/**
 * The browsers we compare, all driven the same way through Playwright, so a
 * test written once runs on each.
 *
 *   const subject = await startSubject("lightpanda")
 *   const tab = await subject.openTab("https://example.com")
 *   const page = await tab.page()
 *   await tab.close()
 *   await subject.close()
 *
 *   agent-tabs   ours: Chromium's headless shell, 2 tabs live, the rest asleep, ads blocked
 *   chrome       the same headless shell with every tab live: what agent-browser, Stagehand,
 *                browser-use and Playwright MCP all run underneath
 *   lightpanda   Lightpanda (LIGHTPANDA_BIN): its own engine, no layout or drawing
 *   obscura      Obscura (OBSCURA_BIN): its own engine
 *
 * Lightpanda and Obscura are started as Chrome-protocol (CDP) servers and
 * Playwright connects to them, the way their docs say agents should.
 *
 * Uses:    ../src (launch), playwright-core, measure.ts
 * Used by: actions.ts, compat.ts, run.ts
 */
import { type ChildProcess, spawn } from "node:child_process"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core"
import { launch } from "../src/browser.ts"
import { processTree } from "./measure.ts"

export const SUBJECTS = ["agent-tabs", "chrome", "lightpanda", "obscura"] as const
export type SubjectName = (typeof SUBJECTS)[number]

export const PAGE_TIMEOUT_MS = 30_000

/** A tab, however the browser keeps it: agent-tabs may have put it to sleep. */
export interface TabHandle {
  /** The tab's page, woken first if it was asleep. */
  page(): Promise<Page>
  close(): Promise<void>
}

export interface Subject {
  name: SubjectName
  /** Opens a new tab at `url` and waits for the page to load. */
  openTab(url: string): Promise<TabHandle>
  /** Every process of the browser, for measuring its memory. */
  pids(): number[]
  close(): Promise<void>
}

export async function startSubject(name: SubjectName): Promise<Subject> {
  if (name === "agent-tabs") {
    return startAgentTabs()
  }
  if (name === "chrome") {
    return startChrome()
  }
  if (name === "lightpanda") {
    const program = needProgram("LIGHTPANDA_BIN", "the lightpanda program")
    // It allows one page per connection, so each tab gets a connection of its own.
    const args = ["serve", "--port", "9445", "--cdp-max-connections", "64"]
    return startCdpServer(name, program, args, 9445, true)
  }
  const program = needProgram("OBSCURA_BIN", "the obscura program")
  // It refuses local addresses unless told; the action tests' site is one.
  const args = ["serve", "--port", "9446", "--quiet", "--allow-private-network"]
  return startCdpServer(name, program, args, 9446, false)
}

async function startAgentTabs(): Promise<Subject> {
  const browser = await launch({ maxLive: 2 })
  const pid = browser.pid
  if (pid === null) {
    throw new Error("agent-tabs started without a process id")
  }
  return {
    name: "agent-tabs",
    openTab: async (url) => {
      const tab = await browser.open(url)
      return {
        page: () => tab.page(),
        close: () => tab.close(),
      }
    },
    pids: () => processTree(pid),
    close: () => browser.close(),
  }
}

async function startChrome(): Promise<Subject> {
  // Without a channel, headless Playwright runs Chromium's headless shell: what agent-tabs runs on.
  const server = await chromium.launchServer({ headless: true })
  const browser = await chromium.connect(server.wsEndpoint())
  const pid = server.process().pid
  if (pid === undefined) {
    throw new Error("Chromium started without a process id")
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  return {
    name: "chrome",
    openTab: (url) => openInContext(context, url),
    pids: () => processTree(pid),
    close: async () => {
      await browser.close().catch(() => {})
      await server.close()
    },
  }
}

/**
 * A browser that serves the Chrome protocol on `port` once started. With
 * `connectionPerTab`, each tab connects on its own (and so has its own
 * cookies): for an engine that holds one page per connection.
 */
async function startCdpServer(
  name: SubjectName,
  program: string,
  args: string[],
  port: number,
  connectionPerTab: boolean,
): Promise<Subject> {
  const server: ChildProcess = spawn(program, args, { stdio: "ignore" })
  const pid = server.pid
  if (pid === undefined) {
    throw new Error(`${name} didn't start`)
  }
  const endpoint = `http://127.0.0.1:${port}`

  // It takes a moment to start listening.
  let browser: Browser | null = null
  for (let attempt = 0; attempt < 50 && browser === null; attempt++) {
    try {
      browser = await chromium.connectOverCDP(endpoint)
    } catch {
      await sleep(200)
    }
  }
  if (browser === null) {
    server.kill()
    throw new Error(`${name} didn't start listening on port ${port}`)
  }
  const stop = () => {
    server.kill()
  }

  if (connectionPerTab) {
    // That first connection only showed it's listening.
    await browser.close().catch(() => {})
    return {
      name,
      openTab: async (url) => {
        const own = await chromium.connectOverCDP(endpoint)
        const context =
          own.contexts()[0] ?? (await own.newContext({ viewport: { width: 1280, height: 800 } }))
        const tab = await openInContext(context, url)
        return {
          page: tab.page,
          close: async () => {
            await tab.close().catch(() => {})
            await own.close().catch(() => {})
          },
        }
      },
      pids: () => processTree(pid),
      close: async () => stop(),
    }
  }

  const context = await contextOf(name, browser)
  const connected = browser
  return {
    name,
    openTab: (url) => openInContext(context, url),
    pids: () => processTree(pid),
    close: async () => {
      await connected.close().catch(() => {})
      stop()
    },
  }
}

/** A context of our own if the engine can make one; otherwise the one it has. */
async function contextOf(name: SubjectName, browser: Browser): Promise<BrowserContext> {
  try {
    return await browser.newContext({ viewport: { width: 1280, height: 800 } })
  } catch {
    const existing = browser.contexts()[0]
    if (existing === undefined) {
      throw new Error(`${name} has no browser context to open tabs in`)
    }
    return existing
  }
}

async function openInContext(context: BrowserContext, url: string): Promise<TabHandle> {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS })
  return {
    page: async () => page,
    close: () => page.close(),
  }
}

function needProgram(variable: string, what: string): string {
  const program = process.env[variable]
  if (program === undefined || program === "") {
    throw new Error(`Set ${variable} to ${what}.`)
  }
  return program
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
