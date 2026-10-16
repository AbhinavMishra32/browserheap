/**
 * Searching every tab at once, without waking any of them.
 *
 *   await findInTabs(browser.tabs, "pricing per seat")
 *     → [{ tab, title, url, live: false, seenAt: 1760600000000, seen: "saved 14 min ago", hits: 3,
 *          snippets: ["…Team plan: $12 per seat, billed …"] }, …]
 *
 * A live tab is read as it is now. A sleeping tab is read from the text it
 * had when it went to sleep, and says when that was: `seen` tells the agent
 * how old it is, so it knows to wake the tab when it needs the page as it is
 * now (prices, scores, an inbox).
 *
 * A tab matches when its title or text has every word of the query, in any
 * order, ignoring case. Most hits first.
 *
 * Uses:    tab.ts
 * Used by: index.ts, repl/session.ts
 */
import type { Tab } from "./tab.ts"

export interface TabMatch {
  tab: Tab
  title: string
  url: string
  /** True when it was read from the running page. */
  live: boolean
  /** When the text was read: now for a live tab, when it went to sleep for a sleeping one (Date.now()). */
  seenAt: number
  /** "live", or how long ago a sleeping tab's text was saved: "saved 14 min ago". */
  seen: string
  /** How many times the query's words appear. */
  hits: number
  /** A little of the text around the first few hits. */
  snippets: string[]
}

export interface FindOptions {
  /** The most snippets per tab. Default 3. */
  snippets?: number
  /** How many characters around each hit. Default 80 on each side. */
  around?: number
}

export async function findInTabs(
  tabs: readonly Tab[],
  query: string,
  options: FindOptions = {},
): Promise<TabMatch[]> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
  if (words.length === 0) {
    return []
  }
  const now = Date.now()
  const matches: TabMatch[] = []

  for (const tab of tabs) {
    const read = await readTab(tab)
    if (read === null) {
      continue
    }
    const haystack = `${read.title}\n${read.text}`.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) {
      continue
    }

    let hits = 0
    for (const word of words) {
      hits += countOf(haystack, word)
    }
    matches.push({
      tab,
      title: read.title,
      url: tab.url,
      live: read.live,
      seenAt: read.live ? now : read.seenAt,
      seen: read.live ? "live" : `saved ${ageOf(now - read.seenAt)}`,
      hits,
      snippets: snippetsOf(read.text, words, options.snippets ?? 3, options.around ?? 80),
    })
  }

  matches.sort((a, b) => b.hits - a.hits)
  return matches
}

/** A tab's title and text: from the running page, or as it was saved. Null when there's nothing to read. */
async function readTab(
  tab: Tab,
): Promise<{ title: string; text: string; live: boolean; seenAt: number } | null> {
  const page = tab.livePage
  if (page !== null) {
    try {
      const read = await page.evaluate(() => ({
        title: document.title,
        text: document.body?.innerText ?? "",
      }))
      return { ...read, live: true, seenAt: Date.now() }
    } catch {
      // Mid-navigation: fall back to what it had when it last slept, if anything.
    }
  }
  if (tab.saved === null) {
    return null
  }
  return { title: tab.saved.title, text: tab.saved.text, live: false, seenAt: tab.saved.savedAt }
}

function countOf(text: string, word: string): number {
  let count = 0
  let at = text.indexOf(word)
  while (at !== -1) {
    count++
    at = text.indexOf(word, at + word.length)
  }
  return count
}

/** The text around the first hits of the words, one snippet per spot, without overlaps. */
function snippetsOf(text: string, words: string[], most: number, around: number): string[] {
  const lower = text.toLowerCase()
  const spots: number[] = []
  for (const word of words) {
    let at = lower.indexOf(word)
    while (at !== -1 && spots.length < most * words.length) {
      spots.push(at)
      at = lower.indexOf(word, at + word.length)
    }
  }
  spots.sort((a, b) => a - b)

  const snippets: string[] = []
  let coveredUntil = -1
  for (const spot of spots) {
    if (snippets.length >= most) {
      break
    }
    if (spot < coveredUntil) {
      continue
    }
    const start = Math.max(0, spot - around)
    const end = Math.min(text.length, spot + around)
    const middle = text.slice(start, end).replace(/\s+/g, " ").trim()
    snippets.push(`${start > 0 ? "…" : ""}${middle}${end < text.length ? "…" : ""}`)
    coveredUntil = end
  }
  return snippets
}

/** "just now", "40 s ago", "14 min ago", "3 h ago", "2 days ago". */
function ageOf(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 5) {
    return "just now"
  }
  if (seconds < 60) {
    return `${seconds} s ago`
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return `${hours} h ago`
  }
  return `${Math.round(hours / 24)} days ago`
}
