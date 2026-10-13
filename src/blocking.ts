/**
 * Only load what the agent might use.
 *
 *   const blocked = await startBlocking(context)                  ads, trackers, images, video and fonts
 *   const blocked = await startBlocking(context, { media: false }) ads and trackers only
 *   blocked.ads, blocked.media                                     how many requests were stopped
 *
 * An agent reads text and acts on buttons and links. It never looks at ads,
 * and only looks at pictures when it takes a screenshot. On a news front
 * page those are most of what the browser downloads and runs.
 *
 *   ads and trackers   Ghostery's filter engine with its ads-and-tracking lists
 *                      (the same lists as uBlock Origin's). Downloaded once,
 *                      then kept in ~/.cache/agent-tabs.
 *   media              every image, video, audio and font, by the request's type.
 *
 * The page itself is never blocked: only what it asks for.
 *
 * Every request in the context goes through one filter, set before any tab
 * opens, so a new tab can't load anything before blocking starts.
 *
 * Uses:    @ghostery/adblocker, playwright-core (BrowserContext)
 * Used by: browser.ts (step 2), bench/run.ts
 * Built:   step 1
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Request as FilterRequest, FiltersEngine } from "@ghostery/adblocker"
import type { BrowserContext, Request, Route } from "playwright-core"

export interface BlockingOptions {
  /** Ads and trackers. Default true. */
  ads?: boolean
  /** Images, video, audio and fonts. Default true. */
  media?: boolean
}

/** How many requests were stopped, by why. */
export interface BlockedCounts {
  ads: number
  media: number
}

const MEDIA_TYPES = new Set(["image", "media", "font"])

const ENGINE_CACHE = join(homedir(), ".cache", "agent-tabs", "ghostery-ads-and-tracking.bin")

/** Loaded once per program, shared by every context. */
let engine: Promise<FiltersEngine> | null = null

function loadEngine(): Promise<FiltersEngine> {
  engine ??= FiltersEngine.fromPrebuiltAdsAndTracking(fetch, {
    path: ENGINE_CACHE,
    read: async (path) => new Uint8Array(await readFile(path)),
    write: async (path, buffer) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, buffer)
    },
  })
  return engine
}

/** Starts blocking in `context`. Call it before opening tabs. */
export async function startBlocking(
  context: BrowserContext,
  options: BlockingOptions = {},
): Promise<BlockedCounts> {
  const blockAds = options.ads ?? true
  const blockMedia = options.media ?? true
  const filters = blockAds ? await loadEngine() : null
  const counts: BlockedCounts = { ads: 0, media: 0 }

  await context.route("**/*", async (route: Route) => {
    const request = route.request()

    if (isPageItself(request)) {
      await route.continue()
      return
    }
    if (blockMedia && MEDIA_TYPES.has(request.resourceType())) {
      counts.media++
      await route.abort("blockedbyclient")
      return
    }
    if (filters !== null && isAdOrTracker(filters, request)) {
      counts.ads++
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })

  return counts
}

/** The tab's own page: the document its top frame navigates to. */
function isPageItself(request: Request): boolean {
  if (!request.isNavigationRequest()) {
    return false
  }
  try {
    return request.frame().parentFrame() === null
  } catch {
    // A new tab's first page: Playwright has no frame for it yet. It's the page itself.
    return true
  }
}

function isAdOrTracker(filters: FiltersEngine, request: Request): boolean {
  const asked = FilterRequest.fromRawDetails({
    url: request.url(),
    sourceUrl: pageUrlOf(request),
    type: request.resourceType() as FilterRequest["type"],
  })
  return filters.match(asked).match
}

/** The page that asked for this request, which some filter rules depend on ("only on news.com"). */
function pageUrlOf(request: Request): string {
  try {
    return request.frame().url()
  } catch {
    // A service worker's request has no frame.
    return request.url()
  }
}
