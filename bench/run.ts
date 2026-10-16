/**
 * The memory benchmark: open real sites as tabs, one after another, keep
 * them all open, and measure the browser's memory after each one.
 *
 *   node bench/run.ts browserheap 20        browserheap: blocking on, 2 tabs live (--live 3 for 3)
 *   node bench/run.ts chrome-shell 20      Chromium's headless shell, every tab live (what browserheap runs on)
 *   node bench/run.ts chromium 20          the full Chromium, in its new headless mode
 *   node bench/run.ts webkit 10            Playwright's WebKit (Safari's engine)
 *   node bench/run.ts obscura 5            Obscura, if OBSCURA_BIN points at its program
 *   node bench/run.ts lightpanda 30        Lightpanda, if LIGHTPANDA_BIN points at its program
 *
 *   … --block       with browserheap' blocking: ads, trackers, images, video, fonts
 *   … --block-ads   ads and trackers only
 *   … --idle 10     then leave it alone 10 minutes, sampling memory and CPU every 15 s
 *   … --until-mb 6500   stop opening tabs once the browser uses this much (for runs past 30 tabs)
 *   … --wake-all    browserheap: then wake every sleeping tab in turn and time each
 *   … --headless-shell  browserheap: on Chromium's headless shell, as `browserheap --headless-shell`
 *
 * More tabs than sites opens the sites again from the top (100 tabs: the 30 sites 3 times, then 10).
 *
 * Prints memory after each tab, then a summary, and saves it all to
 * bench/results/<browser>-<tabs>-<time>.json. For browserheap it also wakes
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
import {
  footprintMb,
  type IdleSample,
  processesMatching,
  processTree,
  sitesFor,
  watchIdle,
} from "./measure.ts"
import { SITES } from "./sites.ts"
import { startSubject } from "./subjects.ts"

const KINDS = ["browserheap", "chrome-shell", "chromium", "webkit", "obscura", "lightpanda"] as const
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
  /** browserheap only: wakes tab `index` (opened order) and returns how much text it shows. */
  wake?: (index: number) => Promise<number>
  close(): Promise<void>
}

async function textLengthOf(page: Page): Promise<number> {
  return page.evaluate(() => document.body?.innerText.length ?? 0)
}

async function startBrowserheap(maxLive: number, shell: boolean): Promise<Session> {
  const browser = await launch({ maxLive, engine: { kind: "chromium", shell } })
  const pid = browser.pid
  if (pid === null) {
    throw new Error("browserheap started without a process id")
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
    wake: async (index) => {
      const tab = tabs[index]
      if (tab === undefined) {
        return 0
      }
      return textLengthOf(await tab.page())
    },
    close: () => browser.close(),
  }
}

/** A plain browser, every tab live, optionally with browserheap' blocking. */
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
  /** How long opening the tab took, until its page loaded. */
  loadMs: number
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
  const sites = sitesFor(SITES, count)
  const idleMinutes = Number(flagValue("--idle") ?? 0)
  const untilMb = Number(flagValue("--until-mb") ?? Number.POSITIVE_INFINITY)
  const wakeAll = process.argv.includes("--wake-all")
  let blocking: Blocking = "none"
  if (process.argv.includes("--block")) {
    blocking = "all"
  }
  if (process.argv.includes("--block-ads")) {
    blocking = "ads"
  }
  const maxLive = Number(flagValue("--live") ?? 2)
  const shell = process.argv.includes("--headless-shell")

  let label: string = kind
  if (kind === "browserheap") {
    label = `browserheap --live ${maxLive}${shell ? " --headless-shell" : ""}`
  } else if (blocking !== "none") {
    label = `${kind} --block${blocking === "ads" ? "-ads" : ""}`
  }

  const startedAt = Date.now()
  let session: Session
  if (kind === "browserheap") {
    session = await startBrowserheap(maxLive, shell)
  } else if (kind === "lightpanda" || kind === "obscura") {
    session = await startOtherEngine(kind)
  } else {
    session = await startPlain(kind, blocking)
  }
  const idleMb = footprintMb(session.pids())

  const tabs: TabResult[] = []
  // Why it stopped before opening every tab, if it did.
  let stopped: "memory limit" | "crashed" | null = null
  for (const url of sites) {
    let worked = false
    let error: string | undefined
    const openedAt = Date.now()
    try {
      const textLength = await session.open(url)
      worked = textLength > 200
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      error = message.split("\n")[0]
    }
    const loadMs = Date.now() - openedAt
    const pids = session.pids()
    const totalMb = footprintMb(pids)
    tabs.push({ url, loadMs, totalMb, worked, error })
    console.log(
      `${String(tabs.length).padStart(3)}  ${String(totalMb).padStart(6)} MB  ${worked ? "ok  " : "FAIL"}  ${url}`,
    )
    if (pids.length === 0) {
      stopped = "crashed"
      break
    }
    if (totalMb >= untilMb) {
      stopped = "memory limit"
      break
    }
  }
  const loadSeconds = Math.round((Date.now() - startedAt) / 1000)

  await sleep(SETTLE_MS)
  const finalMb = footprintMb(session.pids())

  let idle: IdleSample[] | null = null
  if (idleMinutes > 0 && stopped !== "crashed") {
    idle = await watchIdle(session.pids, idleMinutes)
  }

  // Going back to sleeping tabs: the first one, or (--wake-all) each one in turn.
  let wake: { ms: number; worked: boolean; totalMb: number } | null = null
  let wakes: { index: number; ms: number; worked: boolean }[] | null = null
  if (session.wake !== undefined && stopped !== "crashed") {
    const wakeStartedAt = Date.now()
    const textLength = await session.wake(0)
    wake = { ms: Date.now() - wakeStartedAt, worked: textLength > 200, totalMb: footprintMb(session.pids()) }
    if (wakeAll) {
      wakes = []
      for (let index = 1; index < tabs.length; index++) {
        const startedAt = Date.now()
        let worked = false
        try {
          worked = (await session.wake(index)) > 200
        } catch {
          // A site that fails to wake still counts, as a failure.
        }
        wakes.push({ index, ms: Date.now() - startedAt, worked })
        console.log(
          `wake ${String(index + 1).padStart(3)}  ${String(Date.now() - startedAt).padStart(5)} ms  ${tabs[index]?.url}`,
        )
      }
    }
  }
  await session.close()

  const summary = {
    browser: label,
    blocked: session.blocked,
    tabs: tabs.length,
    worked: tabs.filter((tab) => tab.worked).length,
    idleMb,
    finalMb,
    loadSeconds,
    wake,
    wakes,
    stopped,
    idle,
    measuredAt: new Date().toISOString(),
    perTab: tabs,
  }
  console.log(
    `\n${label}: ${finalMb} MB with ${tabs.length} tabs (${summary.worked} worked), idle ${idleMb} MB, ${loadSeconds} s`,
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
  let name = label.replace(/[^a-z0-9]+/g, "-")
  if (idleMinutes > 0) {
    name += `-idle${idleMinutes}m`
  }
  if (wakeAll) {
    name += "-wake-all"
  }
  const file = `bench/results/${name}-${tabs.length}-${summary.measuredAt.replace(/[:.]/g, "-")}.json`
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`saved ${file}`)
}

await main()
