// The same sites as bench/run.ts, opened as tabs in another agent browser
// tool through its own interface and default settings, measuring only its
// browser's processes, after each tab. Saves bench/results/<tool>-<tabs>-<time>.json, shaped like
// bench/run.ts's. Usage: node others.mjs agent-browser|playwright-mcp|stagehand [tabs]
// [--idle minutes] [--until-mb mb], the same flags as bench/run.ts.
// (agent-browser first needs `npx agent-browser install` for its Chrome.)
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { footprintMb, processesMatching, processTree, sitesFor, watchIdle } from "../measure.ts"
import { SITES } from "../sites.ts"

const tool = process.argv[2]
const sites = sitesFor(SITES, Number(process.argv[3] ?? SITES.length))
const idleMinutes = Number(flagValue("--idle") ?? 0)
const untilMb = Number(flagValue("--until-mb") ?? Number.POSITIVE_INFINITY)

function flagValue(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

/** Only the browser's processes (Chrome, Chromium and their helpers), not the tool's own. */
function browserOnly(pids) {
  if (pids.length === 0) return []
  const out = execFileSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8" })
  const kept = []
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (match && /chrom/i.test(match[2])) kept.push(Number(match[1]))
  }
  return kept
}

// Its native program for this computer, like agent-browser-linux-x64.
const AB = new URL(
  `./node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
  import.meta.url,
).pathname
function ab(...args) {
  return execFileSync(AB, ["--session", "bench", ...args], { encoding: "utf8", timeout: 60_000 })
}

async function start() {
  if (tool === "agent-browser") {
    let first = true
    return {
      open: async (url) => {
        try {
          ab(...(first ? ["open", url] : ["tab", "new", url]))
        } finally {
          first = false
        }
        // `tab new` returns before the page loads: wait for it like the agent would.
        try {
          ab("wait", "--load", "load")
        } catch {}
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            const length =
              Number(ab("eval", "document.body ? document.body.innerText.length : 0").trim()) || 0
            if (length > 200) return length
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        return 0
      },
      pids: () => browserOnly(processesMatching(".agent-browser/browsers/")),
      close: async () => {
        ab("close")
      },
    }
  }
  if (tool === "playwright-mcp") {
    const transport = new StdioClientTransport({
      command: "node",
      args: [
        new URL("./node_modules/@playwright/mcp/cli.js", import.meta.url).pathname,
        "--headless",
        "--isolated",
        // The benchmark's machine runs as root, where Chrome only starts without its sandbox
        // (the others turn it off themselves). It doesn't change memory.
        "--no-sandbox",
      ],
    })
    const client = new Client({ name: "bench", version: "1" })
    await client.connect(transport)
    const serverPid = transport.pid
    let first = true
    const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
    return {
      open: async (url) => {
        if (first) {
          first = false
          await call("browser_navigate", { url })
        } else {
          await call("browser_tabs", { action: "new", url })
        }
        const result = await call("browser_evaluate", { function: "() => document.body.innerText.length" })
        const text = result.content?.[0]?.text ?? ""
        return Number(text.match(/(\d+)/)?.[1] ?? 0)
      },
      pids: () => browserOnly(processTree(serverPid)),
      close: () => client.close(),
    }
  }
  if (tool === "stagehand") {
    const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand")
    const browser = await localBrowser.launch({ headless: true })
    const stagehand = await Stagehand.create({ browser })
    let first = true
    return {
      open: async (url) => {
        let page
        if (first) {
          first = false
          page = (await browser.context.pages())[0]
          await page.goto(url)
        } else {
          page = await browser.context.newPage(url)
        }
        return page.evaluate(() => document.body.innerText.length)
      },
      pids: () => browserOnly(processTree(process.pid)),
      close: async () => {
        await stagehand.close()
        await browser.close()
      },
    }
  }
  throw new Error(`Which tool? agent-browser, playwright-mcp or stagehand`)
}

const startedAt = Date.now()
const session = await start()
const idleMb = footprintMb(session.pids())
const perTab = []
let worked = 0
let stopped = null
for (const url of sites) {
  let ok = false
  const openedAt = Date.now()
  try {
    ok = (await withTimeout(session.open(url), 45_000)) > 200
  } catch {
    // A site that times out still counts as an open tab.
  }
  if (ok) worked++
  const loadMs = Date.now() - openedAt
  const pids = session.pids()
  const totalMb = footprintMb(pids)
  perTab.push({ url, loadMs, totalMb, worked: ok })
  console.log(
    `${String(perTab.length).padStart(3)}  ${String(totalMb).padStart(6)} MB  ${ok ? "ok  " : "FAIL"}  ${url}`,
  )
  // After the first tab the browser is up; no processes left means it died.
  if (pids.length === 0 && perTab.length > 1) {
    stopped = "crashed"
    break
  }
  if (totalMb >= untilMb) {
    stopped = "memory limit"
    break
  }
}
const seconds = Math.round((Date.now() - startedAt) / 1000)
await new Promise((resolve) => setTimeout(resolve, 5000))
const pids = session.pids()
const finalMb = footprintMb(pids)
console.log(
  `\n${tool}: ${finalMb} MB with ${perTab.length} tabs (${worked} worked), ${seconds} s, ${pids.length} browser processes`,
)
let idle = null
if (idleMinutes > 0 && stopped !== "crashed") {
  idle = await watchIdle(session.pids, idleMinutes)
}
await session.close().catch(() => {})

const measuredAt = new Date().toISOString()
const summary = {
  browser: tool,
  tabs: perTab.length,
  worked,
  idleMb,
  finalMb,
  loadSeconds: seconds,
  stopped,
  idle,
  measuredAt,
  perTab,
}
const resultsDir = new URL("../results/", import.meta.url).pathname
mkdirSync(resultsDir, { recursive: true })
const suffix = idleMinutes > 0 ? `-idle${idleMinutes}m` : ""
const file = `${resultsDir}${tool}${suffix}-${perTab.length}-${measuredAt.replace(/[:.]/g, "-")}.json`
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`saved ${file}`)
process.exit(0)

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ])
}
