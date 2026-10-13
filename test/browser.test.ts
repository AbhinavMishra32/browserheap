/**
 * Sleeping tabs, on a real Chromium against a local site: which tabs sleep,
 * what a sleeping tab keeps, waking up where it was, staying signed in, and
 * a tab with typed input staying live.
 *
 * Needs Chromium's headless shell (`pnpm setup`).
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { chromium } from "playwright-core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { type AgentBrowser, launch } from "../src/browser.ts"
import type { Tab } from "../src/tab.ts"

/** A long page, so there's somewhere to scroll to. */
function page(name: string, extra = ""): string {
  const filler = "<p>Line</p>".repeat(200)
  return `<!doctype html><title>${name}</title><body><h1>Page ${name}</h1>${extra}${filler}</body>`
}

describe("sleeping tabs", () => {
  let server: Server
  let site = ""
  let browser: AgentBrowser | null = null

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html")
      if (request.url === "/login") {
        response.setHeader("Set-Cookie", "session=abc123; Path=/; HttpOnly")
        response.end(page("login"))
        return
      }
      if (request.url === "/whoami") {
        response.end(page("whoami", `<p id="who">You are: ${request.headers.cookie ?? "nobody"}</p>`))
        return
      }
      if (request.url === "/filled-by-site") {
        // A dropdown with no default chosen, and a search box the site's own script fills in.
        const fields = `<select><option>One</option><option>Two</option></select><input id="q" value="">`
        const script = `<script>document.getElementById("q").value = "suggested"</script>`
        response.end(page("filled", fields + script))
        return
      }
      if (request.url === "/opener") {
        response.end(page("opener", `<a id="new" href="/popup" target="_blank">New tab</a>`))
        return
      }
      if (request.url === "/closes-itself") {
        response.end(page("closer", `<button id="close" onclick="window.close()">Close</button>`))
        return
      }
      if (request.url === "/form") {
        response.end(page("form", `<input id="name" value="">`))
        return
      }
      response.end(page(request.url?.slice(1) ?? ""))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return () => {
      server.close()
    }
  })

  afterEach(async () => {
    await browser?.close()
    browser = null
  })

  it("keeps only the tabs used most recently live, and what the others showed", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const a = await browser.open(`${site}/a`)
    const b = await browser.open(`${site}/b`)
    const c = await browser.open(`${site}/c`)

    expect([a.state, b.state, c.state]).toEqual(["asleep", "live", "live"])
    expect(a.saved?.title).toBe("a")
    expect(a.saved?.text).toContain("Page a")
    expect(browser.tabs.map((tab) => tab.id)).toEqual(["t1", "t2", "t3"])
  }, 30_000)

  it("wakes a tab where it was scrolled, and puts the one used longest ago to sleep", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const a = await browser.open(`${site}/a`)
    const pageA = await a.page()
    await pageA.evaluate(() => window.scrollTo(0, 500))
    const b = await browser.open(`${site}/b`)
    await browser.open(`${site}/c`)
    expect(a.state).toBe("asleep")

    const woken = await a.page()
    expect(a.state).toBe("live")
    expect(b.state).toBe("asleep")
    expect(await woken.textContent("h1")).toBe("Page a")
    expect(await woken.evaluate(() => window.scrollY)).toBe(500)
  }, 30_000)

  it("is still signed in when a tab wakes", async () => {
    browser = await launch({ maxLive: 1, block: false })
    await browser.open(`${site}/login`)
    const who = await browser.open(`${site}/whoami`)
    await browser.open(`${site}/other`)
    expect(who.state).toBe("asleep")

    const woken = await who.page()
    expect(await woken.textContent("#who")).toBe("You are: session=abc123")
  }, 30_000)

  it("never puts a tab with typed input to sleep", async () => {
    browser = await launch({ maxLive: 1, block: false })
    const form = await browser.open(`${site}/form`)
    await (await form.page()).fill("#name", "half-typed")
    const other = await browser.open(`${site}/other`)

    expect(form.state).toBe("live")
    expect(other.state).toBe("live")
  }, 30_000)

  it("still puts a tab to sleep when only the site itself filled in its fields", async () => {
    browser = await launch({ maxLive: 1, block: false })
    const filled = await browser.open(`${site}/filled-by-site`)
    await browser.open(`${site}/other`)

    expect(filled.state).toBe("asleep")
  }, 30_000)

  it("follows a tab's navigation, so it wakes on the page it was on", async () => {
    browser = await launch({ maxLive: 1, block: false })
    const tab = await browser.open(`${site}/a`)
    await (await tab.page()).goto(`${site}/b`)
    await browser.open(`${site}/c`)

    const woken = await tab.page()
    expect(await woken.textContent("h1")).toBe("Page b")
  }, 30_000)

  it("makes a tab of one a page opens itself, and says so", async () => {
    const opened: Tab[] = []
    browser = await launch({ maxLive: 2, block: false, onNewTab: (tab) => opened.push(tab) })
    const opener = await browser.open(`${site}/opener`)
    await (await opener.page()).click("#new")
    await expect.poll(() => opened.length).toBe(1)

    const popup = opened[0]
    expect(browser.tabs).toHaveLength(2)
    expect(await (await popup?.page())?.textContent("h1")).toBe("Page popup")
  }, 30_000)

  it("closes a tab whose page closes itself", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const opener = await browser.open(`${site}/opener`)
    await (await opener.page()).evaluate(() => {
      window.open("/closes-itself")
    })
    await expect.poll(() => browser?.tabs.length).toBe(2)
    const closer = browser.tabs[1]
    await (await closer?.page())?.click("#close")

    await expect.poll(() => browser?.tabs.length).toBe(1)
    expect(closer?.closed).toBe(true)
    await expect(closer?.page()).rejects.toThrow("is closed")
  }, 30_000)

  it("opens a blank tab to navigate yourself", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open()
    const blank = await tab.page()
    expect(blank.url()).toBe("about:blank")
    await blank.goto(`${site}/a`)
    expect(tab.url).toBe(`${site}/a`)
  }, 30_000)

  it("runs in a browser you started, and leaves it running when closed", async () => {
    const shared = await chromium.launch({ headless: true })
    const one = await launch({ engine: { kind: "browser", browser: shared }, block: false })
    const two = await launch({ engine: { kind: "browser", browser: shared }, block: false })
    await one.open(`${site}/login`)
    await one.close()

    const who = await two.open(`${site}/whoami`)
    expect(shared.isConnected()).toBe(true)
    // Each has its own context: two's tabs don't share one's cookies.
    expect(await (await who.page()).textContent("#who")).toBe("You are: nobody")
    await two.close()
    await shared.close()
  }, 30_000)
})
