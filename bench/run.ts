/**
 * The memory benchmark: open real sites as tabs, one after another, keep
 * them all open, and measure the browser's memory after each one.
 *
 *   node bench/run.ts agent-tabs 20        agent-tabs: blocking on, 2 tabs live (--live 3 for 3)
 *   node bench/run.ts chrome-shell 20      Chromium's headless shell, every tab live (what agent-tabs runs on)
 *   node bench/run.ts chromium 20          the full Chromium, in its new headless mode
 *   node bench/run.ts webkit 10            Playwright's WebKit (Safari's engine)
 *   node bench/run.ts obscura 5            Obscura, if OBSCURA_BIN points at its program
 *   node bench/run.ts lightpanda 30        Lightpanda, if LIGHTPANDA_BIN points at its program
 *
 *   … --block       with agent-tabs' blocking: ads, trackers, images, video, fonts
 *   … --block-ads   ads and trackers only
 *
 * Prints memory after each tab, then a summary, and saves it all to
 * bench/results/<browser>-<tabs>-<time>.json. For agent-tabs it also wakes
 * the first tab at the end and times it: what going back to a sleeping tab costs.
 *
 * A page "worked" when it shows more than 200 characters of text; a page a
 * site blocks usually shows nothing.
 *
 * Uses:    sites.ts, measure.ts, subjects.ts, ../src (launch, startBlocking), playwright-core
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { type Browser, chromium, type Page, webkit } from "playwright-core"
import { type BlockedCounts, startBlocking } from "../src/blocking.ts"
import { launch } from "../src/browser.ts"
import type { Tab } from "../src/tab.ts"
import { footprintMb, processesMatching, processTree } from "./measure.ts"
import { SITES } from "./sites.ts"
import { startSubject } from "./subjects.ts"

const KINDS = ["agent-tabs", "chrome-shell", "chromium", "webkit", "obscura", "lightpanda"] as const
type Kind = (typeof KINDS)[number]
type Blocking = "none" | "all" | "ads"

const PAGE_TIMEOUT_MS = 30_000
/** After the last tab, wait this long for late scripts and ads before the final measure. */
const SETTLE_MS = 5_000

/** A browser under test: how to open a tab in it, and how to find all its processes. */
interface Session {
  /** Opens a tab at `url` and returns how much text it shows. */
  open(url: string): Promise<number>
  pids(): number[]
  blocked: BlockedCounts | null
  /** agent-tabs only: wakes the first tab and returns how much text it shows. */
  wakeFirst?: () => Promise<number>
  close(): Promise<void>
}

async function textLengthOf(page: Page): Promise<number> {
  return page.evaluate(() => document.body?.innerText.length ?? 0)
}

async function startAgentTabs(maxLive: number): Promise<Session> {
  const browser = await launch({ maxLive })
  const pid = browser.pid
  if (pid === null) {
    throw new Error("agent-tabs started without a process id")
  }
  const tabs: Tab[] = []
  return {
    open: async (url) => {
      const tab = await browser.open(url)
      tabs.push(tab)
      return textLengthOf(await tab.page())
    },
    pids: () => processTree(pid),
    blocked: browser.blocked,
    wakeFirst: async () => {
      const first = tabs[0]
      if (first === undefined) {
        return 0
      }
      return textLengthOf(await first.page())
    },
    close: () => browser.close(),
  }
}

/** A plain browser, every tab live, optionally with agent-tabs' blocking. */
async function startPlain(kind: Kind, blocking: Blocking): Promise<Session> {
  const running = await startBrowser(kind)
  // Requests from service workers can't be filtered, so with blocking there are none.
  const context = await running.browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: blocking === "none" ? "allow" : "block",
  })
  let blocked: BlockedCounts | null = null
  if (blocking !== "none") {
    blocked = await startBlocking(context, { ads: true, media: blocking === "all" })
  }
  return {
    open: async (url) => {
      const page = await context.newPage()
      await page.goto(url, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS })
      return textLengthOf(page)
    },
    pids: running.pids,
    blocked,
    close: async () => {
      await running.browser.close().catch(() => {})
      await running.stop()
    },
  }
}

/** A running browser, and how to find all its processes. */
interface Running {
  browser: Browser
  pids(): number[]
  stop(): Promise<void>
}

async function startBrowser(kind: Kind): Promise<Running> {
  if (kind === "webkit") {
    const server = await webkit.launchServer({ headless: true })
    const browser = await webkit.connect(server.wsEndpoint())
    return {
      browser,
      pids: () => processesMatching("ms-playwright/webkit-"),
      stop: () => server.close(),
    }
  }
  // Without a channel, headless Playwright runs Chromium's headless shell.
  const options = kind === "chromium" ? { headless: true, channel: "chromium" } : { headless: true }
  const server = await chromium.launchServer(options)
  const browser = await chromium.connect(server.wsEndpoint())
  const pid = server.process().pid
  if (pid === undefined) {
    throw new Error("Chromium started without a process id")
  }
  return {
    browser,
    pids: () => processTree(pid),
    stop: () => server.close(),
  }
}

/** Lightpanda and Obscura, started the way subjects.ts starts them for every comparison. */
async function startOtherEngine(kind: "lightpanda" | "obscura"): Promise<Session> {
  const subject = await startSubject(kind)
  return {
    open: async (url) => {
      const tab = await subject.openTab(url)
      return textLengthOf(await tab.page())
    },
    pids: subject.pids,
    blocked: null,
    close: () => subject.close(),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The value after `--name` on the command line, if given. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  if (at === -1) {
    return undefined
  }
  return process.argv[at + 1]
}

interface TabResult {
  url: string
  /** The browser's memory after this tab loaded, in MB. */
  totalMb: number
  worked: boolean
  error?: string
}

async function main(): Promise<void> {
  const kind = process.argv[2] as Kind
  if (!KINDS.includes(kind)) {
    console.error(`Which browser? One of: ${KINDS.join(", ")}`)
    process.exit(1)
  }
  const count = Number(process.argv[3] ?? SITES.length)
  const sites = SITES.slice(0, count)
  let blocking: Blocking = "none"
  if (process.argv.includes("--block")) {
    blocking = "all"
  }
  if (process.argv.includes("--block-ads")) {
    blocking = "ads"
  }
  const maxLive = Number(flagValue("--live") ?? 2)

  let label: string = kind
  if (kind === "agent-tabs") {
    label = `agent-tabs --live ${maxLive}`
  } else if (blocking !== "none") {
    label = `${kind} --block${blocking === "ads" ? "-ads" : ""}`
  }

  const startedAt = Date.now()
  let session: Session
  if (kind === "agent-tabs") {
    session = await startAgentTabs(maxLive)
  } else if (kind === "lightpanda" || kind === "obscura") {
    session = await startOtherEngine(kind)
  } else {
    session = await startPlain(kind, blocking)
  }
  const idleMb = footprintMb(session.pids())

  const tabs: TabResult[] = []
  for (const url of sites) {
    let worked = false
    let error: string | undefined
    try {
      const textLength = await session.open(url)
      worked = textLength > 200
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      error = message.split("\n")[0]
    }
    const totalMb = footprintMb(session.pids())
    tabs.push({ url, totalMb, worked, error })
    console.log(`${String(totalMb).padStart(6)} MB  ${worked ? "ok  " : "FAIL"}  ${url}`)
  }
  const loadSeconds = Math.round((Date.now() - startedAt) / 1000)

  await sleep(SETTLE_MS)
  const finalMb = footprintMb(session.pids())

  let wake: { ms: number; worked: boolean; totalMb: number } | null = null
  if (session.wakeFirst !== undefined) {
    const wakeStartedAt = Date.now()
    const textLength = await session.wakeFirst()
    wake = { ms: Date.now() - wakeStartedAt, worked: textLength > 200, totalMb: footprintMb(session.pids()) }
  }
  await session.close()

  const summary = {
    browser: label,
    blocked: session.blocked,
    tabs: sites.length,
    worked: tabs.filter((tab) => tab.worked).length,
    idleMb,
    finalMb,
    loadSeconds,
    wake,
    measuredAt: new Date().toISOString(),
    perTab: tabs,
  }
  console.log(
    `\n${label}: ${finalMb} MB with ${sites.length} tabs (${summary.worked} worked), idle ${idleMb} MB, ${loadSeconds} s`,
  )
  if (session.blocked !== null) {
    console.log(
      `blocked ${session.blocked.ads} ad and tracker requests, ${session.blocked.media} media requests`,
    )
  }
  if (wake !== null) {
    console.log(
      `waking the first tab: ${wake.ms} ms, ${wake.worked ? "worked" : "FAILED"}, ${wake.totalMb} MB after`,
    )
  }

  mkdirSync("bench/results", { recursive: true })
  const name = label.replace(/[^a-z0-9]+/g, "-")
  const file = `bench/results/${name}-${sites.length}-${summary.measuredAt.replace(/[:.]/g, "-")}.json`
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`saved ${file}`)
}

await main()
