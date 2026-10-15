/**
 * Many agents on one machine: each agent gets its own browser and opens its
 * own tabs, taking turns like agents working at the same time. Measures all
 * the browsers together after every round, until every agent has its tabs or
 * the machine is close to full.
 *
 *   node bench/agents.ts browserheap 10 10      10 agents, 10 tabs each, 2 tabs live in each
 *   node bench/agents.ts chrome-shell 10 10    the same on plain headless Chrome, every tab live
 *   … --until-mb 6500                          stop once all the browsers together use this much
 *
 * Agent k opens the sites from k × tabs onwards, so the agents read different pages.
 * Saves bench/results/agents-<browser>-<agents>x<tabs>-<time>.json.
 *
 * Uses:    sites.ts, measure.ts, ../src (launch), playwright-core
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { chromium, type Page } from "playwright-core"
import { launch } from "../src/browser.ts"
import { footprintMb, processTree } from "./measure.ts"
import { SITES } from "./sites.ts"

const PAGE_TIMEOUT_MS = 30_000

/** One agent's browser: open a tab, list its processes, close it. */
interface AgentBrowser {
  open(url: string): Promise<boolean>
  pids(): number[]
  close(): Promise<void>
}

async function worked(page: Page): Promise<boolean> {
  const length = await page.evaluate(() => document.body?.innerText.length ?? 0)
  return length > 200
}

async function startBrowserheap(): Promise<AgentBrowser> {
  const browser = await launch({ maxLive: 2 })
  const pid = browser.pid
  if (pid === null) {
    throw new Error("browserheap started without a process id")
  }
  return {
    open: async (url) => worked(await (await browser.open(url)).page()),
    pids: () => processTree(pid),
    close: () => browser.close(),
  }
}

async function startChrome(): Promise<AgentBrowser> {
  const server = await chromium.launchServer({ headless: true })
  const browser = await chromium.connect(server.wsEndpoint())
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pid = server.process().pid
  if (pid === undefined) {
    throw new Error("Chromium started without a process id")
  }
  return {
    open: async (url) => {
      const page = await context.newPage()
      await page.goto(url, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS })
      return worked(page)
    },
    pids: () => processTree(pid),
    close: async () => {
      await browser.close().catch(() => {})
      await server.close()
    },
  }
}

function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  if (at === -1) {
    return undefined
  }
  return process.argv[at + 1]
}

const kind = process.argv[2]
if (kind !== "browserheap" && kind !== "chrome-shell") {
  console.error("Which browser? browserheap or chrome-shell")
  process.exit(1)
}
const agentCount = Number(process.argv[3] ?? 10)
const tabsEach = Number(process.argv[4] ?? 10)
const untilMb = Number(flagValue("--until-mb") ?? Number.POSITIVE_INFINITY)

const agents: AgentBrowser[] = []
for (let k = 0; k < agentCount; k++) {
  agents.push(kind === "browserheap" ? await startBrowserheap() : await startChrome())
}

function allPids(): number[] {
  const pids: number[] = []
  for (const agent of agents) {
    pids.push(...agent.pids())
  }
  return pids
}

const idleMb = footprintMb(allPids())
console.log(`${agentCount} agents started: ${idleMb} MB before any tab`)

interface Round {
  /** Tabs each agent has open after this round. */
  tabsEach: number
  totalTabs: number
  mb: number
  worked: number
}
const rounds: Round[] = []
let stopped: string | null = null
let workedSoFar = 0

for (let round = 1; round <= tabsEach; round++) {
  // Every agent opens one tab, all at the same time, like agents working side by side.
  const opened = await Promise.all(
    agents.map(async (agent, k) => {
      const url = SITES[(k * tabsEach + round - 1) % SITES.length] ?? ""
      try {
        return await agent.open(url)
      } catch {
        return false
      }
    }),
  )
  workedSoFar += opened.filter(Boolean).length
  const pids = allPids()
  const mb = footprintMb(pids)
  rounds.push({ tabsEach: round, totalTabs: round * agentCount, mb, worked: workedSoFar })
  console.log(
    `round ${String(round).padStart(2)}: ${String(round * agentCount).padStart(3)} tabs  ${String(mb).padStart(6)} MB`,
  )
  if (pids.length === 0) {
    stopped = "crashed"
    break
  }
  if (mb >= untilMb) {
    stopped = "memory limit"
    break
  }
}

await new Promise((resolve) => setTimeout(resolve, 5000))
const finalMb = footprintMb(allPids())
for (const agent of agents) {
  await agent.close().catch(() => {})
}

const measuredAt = new Date().toISOString()
const summary = { browser: kind, agents: agentCount, tabsEach, idleMb, finalMb, stopped, measuredAt, rounds }
console.log(
  `\n${kind}: ${agentCount} agents, ${finalMb} MB at the end${stopped === null ? "" : ` (stopped: ${stopped})`}`,
)
mkdirSync("bench/results", { recursive: true })
const file = `bench/results/agents-${kind}-${agentCount}x${tabsEach}-${measuredAt.replace(/[:.]/g, "-")}.json`
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`saved ${file}`)
process.exit(0)
