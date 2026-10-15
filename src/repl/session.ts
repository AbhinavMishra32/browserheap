/**
 * One agent's browser and its REPL together: what an agent tool needs.
 *
 *   const session = await startSession()
 *   await session.run(`await openTab("news.ycombinator.com"); console.log((await snapshot(page)).tree)`)
 *     → { content: [{ type: "text", text: "- title: Hacker News …" }] }
 *   await session.run(`const hn = page; await openTab("react.dev"); await openTab("bbc.com/news")`)
 *   await session.run(`await hn.getByRole("link", { name: "new" }).click()`)   hn slept; it wakes and clicks
 *   await session.close()
 *
 * The agent's code sees pages and locators (agent-page.ts) that follow their
 * tab, not one Playwright page, so tabs can sleep and wake underneath without
 * the code noticing. The REPL keeps one scope for the session: what one call
 * declares, the next can use.
 *
 * `page` is the tab the agent is on: the one it opened last, or one a page
 * opened itself (a popup, a link to a new tab). When that tab closes, it's
 * the newest one left.
 *
 * Uses:    ../browser.ts (launch), agent-page.ts, repl.ts, snapshot.ts
 * Used by: ../index.ts, the CLI (../cli)
 */
import type { Page } from "playwright-core"
import { type AgentBrowser, type LaunchOptions, launch } from "../browser.ts"
import type { Tab } from "../tab.ts"
import { ACTION_TIMEOUT_MS, AgentPage, NAVIGATION_TIMEOUT_MS } from "./agent-page.ts"
import { Repl, type ReplResult } from "./repl.ts"
import { ensureWorld, registerRefSelector } from "./snapshot.ts"

export interface Session {
  /** The tabs underneath, for tools that want them directly. */
  readonly browser: AgentBrowser
  /** Runs the agent's code in the REPL. Stop it early with `signal`. */
  run(code: string, signal?: AbortSignal): Promise<ReplResult>
  close(): Promise<void>
}

/** For pages an agent looks at: ads and trackers blocked, pictures kept. */
const DEFAULT_BLOCK = { ads: true, media: false }

export async function startSession(options: LaunchOptions = {}): Promise<Session> {
  await registerRefSelector()

  // A tab a page opens itself becomes the one the agent is on.
  let current: Tab | null = null
  const browser = await launch({
    block: DEFAULT_BLOCK,
    ...options,
    onNewTab: (tab) => {
      current = tab
      options.onNewTab?.(tab)
    },
  })
  browser.context.setDefaultTimeout(ACTION_TIMEOUT_MS)
  browser.context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

  // One AgentPage per tab, so `const docs = page` stays the same object.
  const pages = new WeakMap<Tab, AgentPage>()
  function pageOf(tab: Tab): AgentPage {
    let page = pages.get(tab)
    if (page === undefined) {
      page = new AgentPage(tab)
      pages.set(tab, page)
    }
    return page
  }

  function currentTab(): Tab | null {
    if (current !== null && !current.closed) {
      return current
    }
    current = browser.tabs.at(-1) ?? null
    return current
  }

  const repl = await Repl.start({
    currentPage: () => {
      const tab = currentTab()
      return tab === null ? null : pageOf(tab)
    },
    tabs: () => browser.tabs.map((tab) => pageOf(tab)),
    openTab: async (url) => {
      const tab = await browser.open()
      current = tab
      const page = pageOf(tab)
      await page.goto(url)
      await ensureWorld((await tab.page()).mainFrame()).catch(() => {})
      return page
    },
    closeTab: (page) => AgentPage.tabOf(page).close(),
    annotatedScreenshot: async (page) => annotatedScreenshot(await AgentPage.unwrap(page)),
  })

  return {
    browser,
    run: (code, signal) => repl.run(code, signal ?? new AbortController().signal),
    close: async () => {
      repl.dispose()
      await browser.close()
    },
  }
}

/** The viewport, with each ref from the last snapshot drawn on its element. */
async function annotatedScreenshot(page: Page): Promise<Buffer> {
  await ensureWorld(page.mainFrame())
  await page.evaluate(() =>
    (globalThis as unknown as { __browserheap: { annotate(): number } }).__browserheap.annotate(),
  )
  try {
    return await page.screenshot({ type: "png" })
  } finally {
    await page
      .evaluate(() =>
        (globalThis as unknown as { __browserheap: { unannotate(): void } }).__browserheap.unannotate(),
      )
      .catch(() => {})
  }
}
