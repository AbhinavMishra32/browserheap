/**
 * agent-tabs: a browser for AI agents where a tab costs memory only while
 * the agent is using it.
 *
 *   const browser = await launch()
 *   const tab = await browser.open("https://en.wikipedia.org/wiki/Web_browser")
 *   const page = await tab.page()      a Playwright page; wakes the tab if it was asleep
 *   tab.state                          "live" or "asleep"
 *   tab.saved                          what the agent last saw: url, title, scroll, text
 *   await browser.close()
 *
 * Start reading at browser.ts, then tab.ts, then sleep.ts, then engine.ts.
 */

export { type BlockedCounts, type BlockingOptions, startBlocking } from "./blocking.ts"
export { type AgentBrowser, type LaunchOptions, launch } from "./browser.ts"
export type { EngineOptions } from "./engine.ts"
export type { SavedTab, Tab, TabState } from "./tab.ts"
