import { describe, expect, it } from "vitest"
import { type TabForSleep, tabsToSleep } from "../src/sleep.ts"

function tab(id: string, lastUsedAt: number, more: Partial<TabForSleep> = {}): TabForSleep {
  return { id, live: true, lastUsedAt, hasUnsentInput: false, ...more }
}

describe("which tabs sleep", () => {
  it("keeps the most recently used, and puts the rest to sleep", () => {
    const tabs = [tab("t1", 100), tab("t2", 300), tab("t3", 200), tab("t4", 400)]
    expect(tabsToSleep(tabs, 2)).toEqual(["t3", "t1"])
  })

  it("puts nothing to sleep when there aren't too many", () => {
    expect(tabsToSleep([tab("t1", 100), tab("t2", 200)], 2)).toEqual([])
  })

  it("only counts live tabs", () => {
    const tabs = [tab("t1", 100, { live: false }), tab("t2", 200), tab("t3", 300)]
    expect(tabsToSleep(tabs, 2)).toEqual([])
  })

  it("never puts a tab with unsent input to sleep", () => {
    const tabs = [tab("t1", 100, { hasUnsentInput: true }), tab("t2", 200), tab("t3", 300), tab("t4", 400)]
    expect(tabsToSleep(tabs, 2)).toEqual(["t2"])
  })
})
