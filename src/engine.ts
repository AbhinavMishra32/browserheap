/**
 * The browser underneath the tabs.
 *
 *   { kind: "chromium" }                          Playwright's Chromium, headless (default; `browserheap install` downloads it)
 *   { kind: "cdp", url: "http://127.0.0.1:9222" }  a browser that's already running: your own Chrome, Obscura…
 *   { kind: "browser", browser }                  a Playwright browser your program already started: the
 *                                                 tabs get a context of their own in it, and closing them
 *                                                 leaves the browser running (O runs one Chromium for every chat)
 *
 * Never the Chrome or Safari installed on the Mac, unless you point "cdp" at it.
 *
 * "chromium" is the full browser in Chrome's headless mode, not Playwright's
 * lighter headless shell: sites tell the shell apart and show it bot checks
 * far more often (bench/bot-walls.ts). It also doesn't say it's automated:
 * no --enable-automation, no navigator.webdriver, and a user agent without
 * "HeadlessChrome".
 *
 * Uses:    playwright-core
 * Used by: browser.ts
 * Built:   step 0, process id in step 2, "browser" for O
 */
import { type Browser, chromium } from "playwright-core"

export type EngineOptions =
  | { kind: "chromium" }
  | { kind: "cdp"; url: string }
  | { kind: "browser"; browser: Browser }

export interface Engine {
  browser: Browser
  /** The browser's main process, for measuring it. Null for a browser we didn't start. */
  pid: number | null
  /** The user agent pages should send, when ours differs from the browser's own. */
  userAgent?: string
  /** Closes the browser if we started it; disconnects from it if we didn't. */
  stop(): Promise<void>
}

export async function startEngine(options: EngineOptions): Promise<Engine> {
  if (options.kind === "browser") {
    // Not ours to close.
    return { browser: options.browser, pid: null, stop: async () => {} }
  }
  if (options.kind === "cdp") {
    const browser = await chromium.connectOverCDP(options.url)
    return { browser, pid: null, stop: () => browser.close() }
  }

  // Started as a server so we know its process. The "chromium" channel is the
  // full browser; without it, headless Playwright runs the headless shell.
  const server = await chromium.launchServer({
    headless: true,
    channel: "chromium",
    // Playwright adds --enable-automation, which marks the browser as automated.
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      // Smaller caches and buffers in every renderer: the full browser then
      // takes less memory than the headless shell (856 against 1,026 MB with
      // 12 sites opened, 2 still open, on E2B).
      "--enable-low-end-device-mode",
      // One renderer per page, as in the headless shell. With site isolation,
      // every cross-site iframe (ads, embeds) gets its own process: 15 for two
      // news pages instead of 3, and over twice the memory.
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  })
  const browser = await chromium.connect(server.wsEndpoint())
  return {
    browser,
    pid: server.process().pid ?? null,
    userAgent: await plainUserAgent(browser),
    stop: () => server.close(),
  }
}

/** The browser's own user agent, saying "Chrome" where headless says "HeadlessChrome". */
async function plainUserAgent(browser: Browser): Promise<string> {
  const page = await browser.newPage()
  const userAgent = await page.evaluate(() => navigator.userAgent)
  await page.context().close()
  return userAgent.replace("HeadlessChrome", "Chrome")
}
