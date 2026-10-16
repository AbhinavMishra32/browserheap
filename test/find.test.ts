/**
 * findInTabs: searching every tab, live or asleep, without waking any, and
 * saying how old a sleeping tab's text is. In the library and in the REPL.
 *
 * Needs Chromium's headless shell (`pnpm setup`).
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { type AgentBrowser, launch } from "../src/browser.ts"
import { findInTabs } from "../src/find.ts"
import { type Session, startSession } from "../src/repl/session.ts"

const PAGES: Record<string, string> = {
  "/plans":
    "<title>Plans</title><p>Team plan: $12 per seat, billed monthly. Business plan: $30 per seat.</p>",
  "/blog": "<title>Blog</title><p>We changed our pricing last spring.</p>",
  "/docs": "<title>Docs</title><p>Install the CLI. Every seat gets an API key.</p>",
}

describe("finding in tabs", () => {
  let server: Server
  let site = ""
  let browser: AgentBrowser | null = null
  let session: Session | null = null

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html")
      response.end(`<!doctype html>${PAGES[request.url ?? ""] ?? "<title>Other</title><p>Nothing here.</p>"}`)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return () => {
      server.close()
    }
  })

  afterEach(async () => {
    await browser?.close()
    await session?.close()
    browser = null
    session = null
  })

  it("finds every word of the query in live and sleeping tabs, without waking any", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const plans = await browser.open(`${site}/plans`)
    await browser.open(`${site}/blog`)
    const docs = await browser.open(`${site}/docs`)
    expect(plans.state).toBe("asleep")

    const matches = await findInTabs(browser.tabs, "per SEAT")
    expect(matches.map((match) => match.title)).toEqual(["Plans"])
    const [found] = matches
    expect(found?.live).toBe(false)
    expect(found?.seen).toBe("saved just now")
    expect(found?.hits).toBe(4)
    expect(found?.snippets[0]).toContain("$12 per seat")
    expect(plans.state).toBe("asleep")

    const seat = await findInTabs(browser.tabs, "seat")
    expect(seat.map((match) => match.title)).toEqual(["Plans", "Docs"])
    expect(seat[1]?.live).toBe(true)
    expect(seat[1]?.seen).toBe("live")
    expect(docs.state).toBe("live")
    expect(await findInTabs(browser.tabs, "nowhere")).toEqual([])
  })

  it("is in the REPL, handing back pages the agent can act on", async () => {
    session = await startSession({ block: false, maxLive: 2 })
    const result = await session.run(`
      await openTab("${site}/plans"); await openTab("${site}/blog"); await openTab("${site}/docs")
      const [hit] = await findInTabs("team plan")
      console.log(hit.title, hit.live, hit.seen, hit.page.isAsleep(), hit.snippets.length)
    `)
    expect(result.error).toBeUndefined()
    expect(result.content[0]).toEqual({ type: "text", text: "Plans false saved just now true 1" })
  })
})
