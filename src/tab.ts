/**
 * One tab, as the agent sees it. It's either live (a real page in the
 * browser) or asleep (no page at all, just what the agent last saw).
 *
 *   live    the page is running. Costs what the website costs: 50 to 900 MB in our runs.
 *   asleep  the page is closed. We keep its url, title, scroll position and
 *           text: tens of KB. Asking for the page opens it again where it was.
 *
 * A tab where something was typed and not sent never sleeps: reopening it
 * would lose what was typed.
 *
 * The tab only holds its state; the browser (browser.ts) decides when it
 * sleeps and wakes, one thing at a time, so a tab's methods ask the browser.
 *
 * Uses:    playwright-core (Page)
 * Used by: browser.ts, sleep.ts
 * Built:   step 2
 */
import type { Page } from "playwright-core"

export type TabState = "live" | "asleep"

/** What a sleeping tab keeps: enough to show the agent what it last saw, and to open the page again. */
export interface SavedTab {
  url: string
  title: string
  /** How far down the page was scrolled, in pixels. */
  scrollY: number
  /** The page's text when it went to sleep. */
  text: string
}

export interface Tab {
  /** "t1", "t2"… in the order the tabs were opened. */
  readonly id: string
  readonly state: TabState
  /** Where the tab is: kept up to date as it navigates, and where it opens again after sleeping. */
  readonly url: string
  /** The real page while the tab is live, without waking it; null while asleep or closed. */
  readonly livePage: Page | null
  /** Closed by the agent, by close(), or by the page itself (window.close()). */
  readonly closed: boolean
  /** When the agent last used this tab (Date.now()). The tab used longest ago sleeps first. */
  readonly lastUsedAt: number
  /** What the agent saw when the tab last went to sleep. Null until it first sleeps. */
  readonly saved: SavedTab | null

  /** The real page, opening it again first if the tab is asleep. Counts as using the tab. */
  page(): Promise<Page>
  /** Saves what the page shows and closes it. Does nothing if already asleep. */
  sleep(): Promise<void>
  close(): Promise<void>
}

/** What a tab asks of the browser that holds it. */
export interface TabOwner {
  pageOfTab(tab: AgentTab): Promise<Page>
  sleepTab(tab: AgentTab): Promise<void>
  closeTab(tab: AgentTab): Promise<void>
}

export class AgentTab implements Tab {
  readonly id: string
  lastUsedAt = Date.now()
  saved: SavedTab | null = null
  /** The real page while live; null while asleep. */
  livePage: Page | null = null
  closed = false
  /** Where the tab is, to open it again. Kept up to date while it's live. */
  url: string
  private owner: TabOwner

  constructor(id: string, url: string, owner: TabOwner) {
    this.id = id
    this.url = url
    this.owner = owner
  }

  get state(): TabState {
    return this.livePage === null ? "asleep" : "live"
  }

  page(): Promise<Page> {
    if (this.closed) {
      return Promise.reject(new Error(`Tab ${this.id} is closed`))
    }
    return this.owner.pageOfTab(this)
  }

  sleep(): Promise<void> {
    return this.owner.sleepTab(this)
  }

  close(): Promise<void> {
    return this.owner.closeTab(this)
  }
}

/** What the page shows right now. */
export async function savePage(page: Page): Promise<SavedTab> {
  const shown = await page.evaluate(() => ({
    title: document.title,
    scrollY: Math.round(window.scrollY),
    text: document.body?.innerText ?? "",
  }))
  return { url: page.url(), ...shown }
}

/**
 * Runs in every page before its own scripts: remembers each field a person
 * or the agent typed into or changed. Only real input counts (isTrusted),
 * not the page's own scripts filling in fields, so a search box a site
 * fills in itself doesn't keep its tab awake.
 */
export function trackTyping(): void {
  const touched = new Set<EventTarget>()
  const remember = (event: Event) => {
    if (event.isTrusted && event.target !== null) {
      touched.add(event.target)
    }
  }
  document.addEventListener("input", remember, true)
  document.addEventListener("change", remember, true)
  Object.defineProperty(window, "__browserheapTouched", { value: touched })
}

/** Whether something was typed or chosen in the page, and not sent, that a reload would lose. */
export async function hasUnsentInput(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const touched = (window as unknown as { __browserheapTouched?: Set<EventTarget> }).__browserheapTouched
    if (touched === undefined) {
      return false
    }
    for (const field of touched) {
      // A field the page removed since (a form that was sent, a dialog that closed) is gone anyway.
      if (!(field instanceof Element) || !field.isConnected) {
        continue
      }
      if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
        if (field.checked !== field.defaultChecked) {
          return true
        }
        continue
      }
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        if (field.value !== field.defaultValue) {
          return true
        }
        continue
      }
      if (field instanceof HTMLSelectElement) {
        for (const option of field.options) {
          if (option.selected !== option.defaultSelected) {
            return true
          }
        }
        continue
      }
      // Anything else typed into (a rich text editor) counts as unsent while it's on the page.
      if (field instanceof HTMLElement && field.isContentEditable) {
        return true
      }
    }
    return false
  })
}
