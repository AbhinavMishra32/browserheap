/**
 * Which tabs go to sleep when too many are live.
 *
 *   tabsToSleep(tabs, 2)   the live tabs beyond the 2 used most recently,
 *                          except ones with typed input that wasn't sent
 *
 * A tab with unsent input stays live even if that means more than `maxLive`
 * are: reopening it would lose what was typed.
 *
 * A plain function over plain values: no browser in here, so it's easy to test.
 *
 * Uses:    nothing
 * Used by: browser.ts
 * Built:   step 2
 */

/** What this choice needs to know about a tab. */
export interface TabForSleep {
  id: string
  live: boolean
  lastUsedAt: number
  /** Something was typed into the page and not sent: closing it would lose that. */
  hasUnsentInput: boolean
}

/** The ids of the tabs to put to sleep so that at most `maxLive` stay live. */
export function tabsToSleep(tabs: TabForSleep[], maxLive: number): string[] {
  const live = tabs.filter((tab) => tab.live)

  // Most recently used first: those are the ones that stay.
  live.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const beyondLimit = live.slice(maxLive)

  const ids: string[] = []
  for (const tab of beyondLimit) {
    if (!tab.hasUnsentInput) {
      ids.push(tab.id)
    }
  }
  return ids
}
