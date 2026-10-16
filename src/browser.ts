/**
 * The browser the agent holds: its tabs, and the rule that keeps only a few
 * of them running.
 *
 *   const browser = await launch({ maxLive: 2 })
 *   const a = await browser.open("https://a.example")   live
 *   const b = await browser.open("https://b.example")   live
 *   const c = await browser.open("https://c.example")   live; `a` goes to sleep (used longest ago)
 *   await a.page()                                      `a` wakes where it was; `b` goes to sleep
 *
 * The agent sees every tab it opened, all the time. Behind them, at most
 * `maxLive` are real pages; the rest are asleep: closed, with what the agent
 * last saw kept (tab.ts). Which ones sleep is sleep.ts's choice.
 *
 * A tab wakes as it was: sessionStorage and window.name go back before the
 * page's own scripts run, then fields, scroll, focus and media once it has
 * loaded (page-state.ts). Its back/forward history comes back the first
 * time the agent goes back or forward past where it woke, so waking itself
 * costs nothing more.
 *
 * Every tab shares one browser context, so one cookie jar: a tab that wakes
 * up is still signed in. Blocking (blocking.ts) is on for the whole context
 * unless `block: false`.
 *
 * A tab the page opens itself (a link to a new tab, a popup) joins the tabs
 * as the one used most recently, and `onNewTab` hears about it. A page that
 * closes itself (window.close()) closes its tab.
 *
 * Opening, waking, sleeping and closing happen one at a time, so two calls
 * at once can't wake and sleep the same tab together.
 *
 * Uses:    engine.ts, tab.ts, sleep.ts, blocking.ts, page-state.ts
 * Used by: index.ts
 * Built:   step 2 · popups, shared browser, context options for O
 */
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core"
import { type BlockedCounts, type BlockingOptions, startBlocking } from "./blocking.ts"
import { type Engine, type EngineOptions, startEngine } from "./engine.ts"
import { type PageState, restoreAfterLoad, restoreBeforeScripts } from "./page-state.ts"
import { tabsToSleep } from "./sleep.ts"
import {
  AgentTab,
  hasUnsentInput,
  type SavedHistory,
  savePage,
  type Tab,
  type TabOwner,
  trackTyping,
} from "./tab.ts"

export interface LaunchOptions {
  /** Which browser runs the live tabs. Default: Playwright's headless Chromium. */
  engine?: EngineOptions
  /** How many tabs may be real pages at once. Default 2. */
  maxLive?: number
  /** What to block. Default: ads, trackers, images, video and fonts. False: nothing. */
  block?: BlockingOptions | false
  /** More settings for the browser context, like a user agent. The viewport defaults to 1280×800. */
  context?: BrowserContextOptions
  /** Called when a page opens a tab of its own (a link to a new tab, a popup). */
  onNewTab?: (tab: Tab) => void
}

export interface AgentBrowser {
  /** Every tab the agent opened and hasn't closed, live or asleep, in the order they were opened. */
  readonly tabs: readonly Tab[]
  /** The browser's main process, for measuring it. Null for a browser we didn't start. */
  readonly pid: number | null
  /** How many requests blocking stopped. Null when blocking is off. */
  readonly blocked: BlockedCounts | null
  /** The context every tab is in: its cookies are the tabs' cookies. */
  readonly context: BrowserContext
  /**
   * Opens a new live tab, putting the tab used longest ago to sleep if there
   * are too many. With a url it goes there; without one it stays blank, for
   * you to navigate its page yourself.
   */
  open(url?: string): Promise<Tab>
  /** Closes every tab and the browser underneath. */
  close(): Promise<void>
}

export const DEFAULT_MAX_LIVE = 2
const VIEWPORT = { width: 1280, height: 800 }
const NAVIGATION_TIMEOUT_MS = 30_000
/** How long a woken page gets to render what the saved state points at (fields, panels) before we stop looking. */
const RESTORE_WAIT_MS = 600
/** How long a woken page may spend loading again what it loaded as it was scrolled (infinite scroll). */
const SCROLL_CATCH_UP_MS = 1_000
/** The most history entries a tab brings back. */
const MAX_HISTORY = 50
/** What a history entry is while it's rebuilt: never kept by the browser, so going to it loads the real page. */
const STUB_PAGE = {
  status: 200,
  contentType: "text/html",
  headers: { "Cache-Control": "no-store" },
  body: "<!doctype html><title></title>",
}

export async function launch(options: LaunchOptions = {}): Promise<AgentBrowser> {
  const engine = await startEngine(options.engine ?? { kind: "chromium" })
  const blocking = options.block ?? {}
  const context = await engine.browser.newContext({
    viewport: VIEWPORT,
    ...options.context,
    // Requests from service workers can't be filtered, so with blocking there are none.
    serviceWorkers: blocking === false ? "allow" : "block",
  })
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
  await context.addInitScript(trackTyping)

  let blocked: BlockedCounts | null = null
  if (blocking !== false) {
    blocked = await startBlocking(context, blocking)
  }
  const browser = new TabbedBrowser(engine, context, options.maxLive ?? DEFAULT_MAX_LIVE, blocked)
  browser.onNewTab = options.onNewTab ?? null
  context.on("page", (page) => browser.adoptIfOpenedByPage(page))
  return browser
}

class TabbedBrowser implements AgentBrowser, TabOwner {
  tabs: AgentTab[] = []
  readonly blocked: BlockedCounts | null
  readonly context: BrowserContext
  onNewTab: ((tab: Tab) => void) | null = null
  private engine: Engine
  private maxLive: number
  private tabsOpened = 0
  /** Every page we opened ourselves, to tell them from pages a page opened. */
  private ourPages = new WeakSet<Page>()
  /** The work going on now; the next piece waits for it. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(engine: Engine, context: BrowserContext, maxLive: number, blocked: BlockedCounts | null) {
    this.engine = engine
    this.context = context
    this.maxLive = maxLive
    this.blocked = blocked
  }

  get pid(): number | null {
    return this.engine.pid
  }

  open(url?: string): Promise<Tab> {
    return this.oneAtATime(async () => {
      const page = await this.newPage()
      const tab = this.addTab(page, url ?? "about:blank")
      // Make room first, so the browser never holds more pages than it should.
      await this.sleepExtraTabs()
      if (url !== undefined) {
        await page.goto(url)
      }
      return tab
    })
  }

  /**
   * A page the context just opened. The ones we open (open, wake) are a
   * tab's already; any other was opened by a page: it becomes a tab. Runs
   * after whatever we're doing now, so our own new page is a tab's by then.
   */
  adoptIfOpenedByPage(page: Page): void {
    void this.oneAtATime(async () => {
      if (this.ourPages.has(page) || page.isClosed()) {
        return
      }
      const tab = this.addTab(page, page.url())
      await this.sleepExtraTabs()
      this.onNewTab?.(tab)
    })
  }

  pageOfTab(tab: AgentTab): Promise<Page> {
    return this.oneAtATime(async () => {
      if (!this.tabs.includes(tab)) {
        throw new Error(`Tab ${tab.id} is closed`)
      }
      tab.lastUsedAt = Date.now()
      if (tab.livePage === null) {
        await this.wake(tab)
      }
      await this.sleepExtraTabs()
      if (tab.livePage === null) {
        throw new Error(`Tab ${tab.id} closed while waking up`)
      }
      return tab.livePage
    })
  }

  sleepTab(tab: AgentTab): Promise<void> {
    return this.oneAtATime(() => this.putToSleep(tab))
  }

  closeTab(tab: AgentTab): Promise<void> {
    return this.oneAtATime(async () => {
      this.tabs = this.tabs.filter((other) => other !== tab)
      tab.closed = true
      const page = tab.livePage
      tab.livePage = null
      await page?.close()
    })
  }

  close(): Promise<void> {
    return this.oneAtATime(async () => {
      for (const tab of this.tabs) {
        tab.closed = true
        tab.livePage = null
      }
      this.tabs = []
      await this.context.close().catch(() => {})
      await this.engine.stop()
    })
  }

  private async newPage(): Promise<Page> {
    const page = await this.context.newPage()
    this.ourPages.add(page)
    return page
  }

  /** A new tab for `page`, the one used most recently. */
  private addTab(page: Page, url: string): AgentTab {
    this.tabsOpened++
    const tab = new AgentTab(`t${this.tabsOpened}`, url, this)
    tab.lastUsedAt = Date.now()
    this.tabs.push(tab)
    this.attachPage(tab, page)
    return tab
  }

  /** Opens a sleeping tab's page again, as it was. */
  private async wake(tab: AgentTab): Promise<void> {
    const page = await this.newPage()
    this.attachPage(tab, page)
    if (tab.url === "about:blank") {
      return
    }
    const state = tab.saved?.state ?? null
    // The page knows only where it woke; the rest of its history waits in the tab.
    if (tab.history === null && tab.saved?.history != null) {
      tab.history = tab.saved.history
    }

    let early = null
    if (state !== null) {
      early = await page.addInitScript(restoreBeforeScripts, {
        origin: state.origin,
        sessionStorage: state.sessionStorage,
        windowName: state.windowName,
        refs: state.refs,
      })
    }
    try {
      await page.goto(tab.url, { waitUntil: "domcontentloaded" })
    } catch {
      // Slow or failing: the page is there as far as it got, like a tab you'd reload yourself.
      return
    } finally {
      // Only this load gets the saved storage, not the pages the tab goes to next.
      await early?.dispose().catch(() => {})
    }
    if (state !== null) {
      await restoreState(page, state)
    }
  }

  /** Saves what the tab shows, then closes its page. */
  private async putToSleep(tab: AgentTab): Promise<void> {
    const page = tab.livePage
    if (page === null) {
      return
    }
    try {
      tab.saved = await savePage(page)
      tab.saved.history = await historyOfTab(tab, page)
      tab.url = tab.saved.url
    } catch {
      // The page is broken or mid-navigation: keep what we saved before, and its last url.
      tab.url = page.url() === "about:blank" ? tab.url : page.url()
    }
    tab.livePage = null
    tab.history = null
    await page.close()
  }

  /**
   * Goes back (-1) or forward (1). Through the page's own history when it
   * has somewhere to go; otherwise through the history the tab had before
   * it slept: a new page gets every entry again (stand-ins, loaded for
   * real when visited), then goes to the one asked for.
   */
  travel(tab: AgentTab, steps: -1 | 1): Promise<boolean> {
    return this.oneAtATime(async () => {
      if (!this.tabs.includes(tab)) {
        throw new Error(`Tab ${tab.id} is closed`)
      }
      tab.lastUsedAt = Date.now()
      if (tab.livePage === null) {
        await this.wake(tab)
      }
      await this.sleepExtraTabs()
      const page = tab.livePage
      if (page === null) {
        throw new Error(`Tab ${tab.id} closed while waking up`)
      }

      const own = await historyOfPage(page)
      const target = own.index + steps
      if (tab.history === null || (target >= 0 && target < own.urls.length)) {
        const options = { waitUntil: "domcontentloaded" as const }
        const response = steps === -1 ? await page.goBack(options) : await page.goForward(options)
        return response !== null || page.url() !== own.urls[own.index]
      }

      const whole = await historyOfTab(tab, page)
      const goTo = whole.index + steps
      if (goTo < 0 || goTo >= whole.urls.length) {
        return false
      }
      await this.rebuildHistory(tab, whole, goTo)
      return true
    })
  }

  /** Gives the tab a new page holding every entry of `saved`, on entry `goTo`. */
  private async rebuildHistory(tab: AgentTab, saved: SavedHistory, goTo: number): Promise<void> {
    const old = tab.livePage
    const page = await this.newPage()
    this.attachPage(tab, page)
    tab.history = null
    await old?.close()

    // Every entry, as a stand-in the browser won't keep, so visiting it loads the real page.
    await page.route("**/*", (route) => route.fulfill(STUB_PAGE))
    for (const url of saved.urls) {
      await page.goto(url, { waitUntil: "commit" })
    }
    await page.unrouteAll()

    const loaded = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() })
    await page.evaluate((delta) => window.history.go(delta), goTo - (saved.urls.length - 1))
    await loaded
    await page.waitForLoadState("domcontentloaded").catch(() => {})
  }

  /** Puts tabs to sleep until no more than `maxLive` are live. */
  private async sleepExtraTabs(): Promise<void> {
    const candidates = []
    for (const tab of this.tabs) {
      let unsent = false
      if (tab.livePage !== null) {
        unsent = await hasUnsentInput(tab.livePage).catch(() => false)
      }
      candidates.push({
        id: tab.id,
        live: tab.livePage !== null,
        lastUsedAt: tab.lastUsedAt,
        hasUnsentInput: unsent,
      })
    }

    const ids = tabsToSleep(candidates, this.maxLive)
    for (const tab of this.tabs) {
      if (ids.includes(tab.id)) {
        await this.putToSleep(tab)
      }
    }
  }

  /** Makes `page` the tab's live page, keeping the tab's url current as the page navigates. */
  private attachPage(tab: AgentTab, page: Page): void {
    tab.livePage = page
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() !== "about:blank") {
        tab.url = frame.url()
      }
    })
    // We let go of a page before closing it (sleep, close). Still holding it: the page closed itself.
    page.on("close", () => {
      if (tab.livePage === page) {
        tab.livePage = null
        tab.closed = true
        this.tabs = this.tabs.filter((other) => other !== tab)
      }
    })
  }

  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    // The next piece of work waits for this one, whether it worked or not.
    this.queue = result.catch(() => {})
    return result
  }
}

/**
 * Puts the saved state back on a woken page. A page that renders late gets
 * a few more tries; a page that loads as it's scrolled (infinite scroll) is
 * scrolled down until it's as tall as it was, for a moment at most.
 */
async function restoreState(page: Page, state: PageState): Promise<void> {
  const started = Date.now()
  let missing = await page.evaluate(restoreAfterLoad, state).catch(() => 0)
  while (missing > 0 && Date.now() - started < RESTORE_WAIT_MS) {
    await page.waitForTimeout(100)
    missing = await page.evaluate(restoreAfterLoad, state).catch(() => 0)
  }

  // Too short to scroll to where it was: what was there loaded as the page was scrolled.
  const tooShort = () =>
    page
      .evaluate((y) => document.documentElement.scrollHeight < y + window.innerHeight, state.scrollY)
      .catch(() => false)
  if (!(await tooShort())) {
    return
  }
  while (Date.now() - started < SCROLL_CATCH_UP_MS && (await tooShort())) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {})
    await page.waitForTimeout(150)
  }
  await page.evaluate(restoreAfterLoad, state).catch(() => {})
}

/** The page's own back/forward history, read from Chromium. Just where it is, for a browser that can't say. */
async function historyOfPage(page: Page): Promise<SavedHistory> {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory")
    await cdp.detach().catch(() => {})
    const urls: string[] = []
    let index = 0
    for (const [i, entry] of entries.entries()) {
      if (entry.url === "about:blank") {
        continue
      }
      if (i <= currentIndex) {
        index = urls.length
      }
      urls.push(entry.url)
    }
    if (urls.length > 0) {
      return { urls, index }
    }
  } catch {
    // Not Chromium, or the page is going away.
  }
  return { urls: [page.url()], index: 0 }
}

/**
 * The tab's whole history: the page's own, with what the tab had before it
 * woke around it. Entries ahead of where it woke count only while the page
 * hasn't gone anywhere since, as in any browser.
 */
async function historyOfTab(tab: AgentTab, page: Page): Promise<SavedHistory> {
  const own = await historyOfPage(page)
  const before = tab.history?.urls.slice(0, tab.history.index) ?? []
  let after: string[] = []
  if (tab.history !== null && own.urls.length === 1) {
    after = tab.history.urls.slice(tab.history.index + 1)
  }
  const urls = [...before, ...own.urls, ...after]
  let index = before.length + own.index
  // Keep the newest entries around where the tab is.
  const start = Math.max(0, Math.min(index - Math.floor(MAX_HISTORY / 2), urls.length - MAX_HISTORY))
  index -= start
  return { urls: urls.slice(start, start + MAX_HISTORY), index }
}
