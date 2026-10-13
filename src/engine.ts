/**
 * The browser underneath the tabs.
 *
 *   { kind: "chromium" }                          Playwright's headless Chromium (default; `pnpm setup` downloads it)
 *   { kind: "cdp", url: "http://127.0.0.1:9222" }  a browser that's already running: your own Chrome, Obscura…
 *   { kind: "browser", browser }                  a Playwright browser your program already started: the
 *                                                 tabs get a context of their own in it, and closing them
 *                                                 leaves the browser running (O runs one Chromium for every chat)
 *
 * Never the Chrome or Safari installed on the Mac, unless you point "cdp" at it.
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

  // Started as a server so we know its process. Without a channel, headless
  // Playwright runs Chromium's headless shell: the lighter build.
  const server = await chromium.launchServer({ headless: true })
  const browser = await chromium.connect(server.wsEndpoint())
  return {
    browser,
    pid: server.process().pid ?? null,
    stop: () => server.close(),
  }
}
