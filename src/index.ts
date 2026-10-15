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
 * Or a whole session for an agent tool: the browser and a JavaScript REPL
 * whose pages and locators keep working while their tabs sleep and wake:
 *
 *   const session = await startSession()
 *   await session.run(`await openTab("react.dev"); console.log((await snapshot(page)).tree)`)
 *
 * Start reading at browser.ts, then tab.ts, then sleep.ts, then engine.ts;
 * for the REPL, repl/session.ts, then repl/agent-page.ts, then repl/repl.ts.
 */

export { type BlockedCounts, type BlockingOptions, startBlocking } from "./blocking.ts"
export { type AgentBrowser, type LaunchOptions, launch } from "./browser.ts"
export type { EngineOptions } from "./engine.ts"
export { AgentLocator, AgentPage } from "./repl/agent-page.ts"
export type { ReplPart, ReplResult } from "./repl/repl.ts"
export { type Session, startSession } from "./repl/session.ts"
export type { SavedTab, Tab, TabState } from "./tab.ts"
