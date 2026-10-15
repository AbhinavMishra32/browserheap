/**
 * Waiting for a page to be ready after something happened, the way Aside does,
 * so the agent never needs sleep() after an action:
 *
 *   await afterAction(page, () => locator.click())
 *     1. do it
 *     2. the DOM is ready (up to 2 s), then 150 ms for the page's handlers to start work
 *     3. requests to the same site that started meanwhile finish (up to 1.2 s; not
 *        websockets, event streams, pings, prefetches)
 *     4. it navigated → wait until the new page is usable (below)
 *        it didn't     → wait until the DOM is quiet: at most 1% of elements changing in a
 *                        50 ms sample (up to 300 ms; 750 ms when an app changed the URL itself)
 *     never more than 8 s in all
 *
 *   await untilUsable(page)       after opening a tab or going to an address
 *     the DOM is ready, the body has something in it (an interactive element, or some text),
 *     same-site requests are done (up to 1.5 s), and it isn't an empty page about to
 *     redirect (1 s grace)
 *
 * Uses:    snapshot.ts (ensureWorld), page-world.ts (probe, mutations), playwright-core
 * Used by: agent-page.ts
 * Built:   in O first (5.6), copied into agent-tabs
 */
import type { Frame, Page, Request } from "playwright-core"
import { ensureWorld } from "./snapshot.ts"

const DOM_READY_MS = 2_000
const HOOK_WINDOW_MS = 150
const REQUEST_BUDGET_MS = 1_200
const POST_SETTLE_MS = 300
const SPA_POST_SETTLE_MS = 750
const SPA_MIN_DWELL_MS = 500
const ACTION_MAX_MS = 8_000
const PROBE_EVERY_MS = 100
const NAVIGATION_REQUEST_BUDGET_MS = 1_500
const REDIRECT_GUARD_MS = 1_000
const QUIET_RATIO = 0.01
const QUIET_SAMPLE_MS = 50

const SKIPPED_REQUESTS = new Set(["websocket", "eventsource", "ping", "prefetch", "cspviolationreport"])

/** Does `action`, then waits until the page has finished reacting to it. */
export async function afterAction<T>(page: Page, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + ACTION_MAX_MS
  const requests = new SameSiteRequests(page)
  let navigated = false
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      navigated = true
    }
  }
  page.on("framenavigated", onNavigated)
  const urlBefore = page.url()

  try {
    const result = await action()

    await page
      .waitForLoadState("domcontentloaded", { timeout: Math.min(DOM_READY_MS, left(deadline)) })
      .catch(() => {})
    await sleep(HOOK_WINDOW_MS)

    const requestDeadline = Math.min(Date.now() + REQUEST_BUDGET_MS, deadline)
    while (requests.pending() > 0 && Date.now() < requestDeadline && !navigated) {
      await sleep(50)
    }

    if (navigated && page.url() !== urlBefore && !sameDocument(urlBefore, page.url())) {
      await untilUsable(page, Math.max(left(deadline), DOM_READY_MS)).catch(() => {})
      return result
    }

    const urlChanged = page.url() !== urlBefore
    const budget = Math.min(urlChanged ? SPA_POST_SETTLE_MS : POST_SETTLE_MS, left(deadline))
    if (budget > 0) {
      const dwell = urlChanged ? Math.min(SPA_MIN_DWELL_MS, budget) : 0
      await sleep(dwell)
      await untilQuiet(page, budget - dwell)
    }
    return result
  } finally {
    page.off("framenavigated", onNavigated)
    requests.stop()
  }
}

/** Waits until a freshly loaded page is usable. */
export async function untilUsable(page: Page, timeoutMs = ACTION_MAX_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const requests = new SameSiteRequests(page)
  let busySince: number | null = null
  let emptySince: number | null = null
  try {
    await page
      .waitForLoadState("domcontentloaded", { timeout: Math.min(DOM_READY_MS, left(deadline)) })
      .catch(() => {})
    while (Date.now() < deadline) {
      await sleep(PROBE_EVERY_MS)
      let probe: { bodyExists: boolean; interactiveCount: number; textChars: number }
      try {
        await ensureWorld(page.mainFrame())
        probe = await page.evaluate(() =>
          (globalThis as unknown as { __agentTabs: { probe(): never } }).__agentTabs.probe(),
        )
      } catch {
        // Mid-navigation: the page is being replaced. Look again.
        continue
      }
      if (!probe.bodyExists || (probe.interactiveCount === 0 && probe.textChars < 20)) {
        continue
      }
      if (requests.pending() > 0) {
        busySince ??= Date.now()
        if (Date.now() - busySince < NAVIGATION_REQUEST_BUDGET_MS) {
          continue
        }
      }
      // Nothing to click yet: maybe a page that's about to redirect. Give it a moment.
      if (probe.interactiveCount === 0) {
        emptySince ??= Date.now()
        if (Date.now() - emptySince < REDIRECT_GUARD_MS) {
          continue
        }
      }
      return
    }
  } finally {
    requests.stop()
  }
}

/** Waits until at most 1% of the page's elements change in a sample, for up to `budgetMs`. */
async function untilQuiet(page: Page, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  try {
    await ensureWorld(page.mainFrame())
    await page.evaluate(() =>
      (globalThis as unknown as { __agentTabs: { watchMutations(): void } }).__agentTabs.watchMutations(),
    )
    // Count from now.
    await page.evaluate(() =>
      (globalThis as unknown as { __agentTabs: { readMutations(): void } }).__agentTabs.readMutations(),
    )
    while (Date.now() < deadline) {
      await sleep(QUIET_SAMPLE_MS)
      const sample = await page.evaluate(() =>
        (
          globalThis as unknown as { __agentTabs: { readMutations(): { mutations: number; nodes: number } } }
        ).__agentTabs.readMutations(),
      )
      if (sample.mutations / sample.nodes <= QUIET_RATIO) {
        return
      }
    }
  } catch {
    // The page navigated meanwhile: nothing left to wait for here.
    await sleep(left(deadline))
  }
}

/** Requests to the page's own site that haven't finished. */
class SameSiteRequests {
  private page: Page
  private open = new Set<Request>()
  private onRequest = (request: Request) => {
    if (SKIPPED_REQUESTS.has(request.resourceType()) || !sameSite(request.url(), this.page.url())) {
      return
    }
    this.open.add(request)
  }
  private onDone = (request: Request) => {
    this.open.delete(request)
  }

  constructor(page: Page) {
    this.page = page
    page.on("request", this.onRequest)
    page.on("requestfinished", this.onDone)
    page.on("requestfailed", this.onDone)
  }

  pending(): number {
    return this.open.size
  }

  stop(): void {
    this.page.off("request", this.onRequest)
    this.page.off("requestfinished", this.onDone)
    this.page.off("requestfailed", this.onDone)
  }
}

/** Same registrable domain, near enough: app.example.com and example.com count as one site. */
function sameSite(url: string, pageUrl: string): boolean {
  const host = hostOf(url)
  const pageHost = hostOf(pageUrl)
  if (host === null || pageHost === null) {
    return false
  }
  const site = pageHost.split(".").slice(-2).join(".")
  return host === site || host.endsWith(`.${site}`)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Only the #fragment changed: same document, no new page. */
function sameDocument(before: string, after: string): boolean {
  return before.split("#")[0] === after.split("#")[0]
}

function left(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
