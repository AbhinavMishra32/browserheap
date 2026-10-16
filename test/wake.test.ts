/**
 * A woken tab is the tab it was: sessionStorage, window.name, fields, the
 * window's scroll and every scrolled panel's, focus and selection, content
 * loaded as it was scrolled, back/forward history across the sleep, and the
 * agent's snapshot refs.
 *
 * Needs Chromium's headless shell (`pnpm setup`).
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { type AgentBrowser, launch } from "../src/browser.ts"
import { registerRefSelector, snapshot } from "../src/repl/snapshot.ts"
import type { Tab } from "../src/tab.ts"

/** A page with a bit of everything a reload loses. Its script shows what sessionStorage held as it started. */
const STATE_PAGE = `<!doctype html><title>state</title><body>
<p id="seen"></p>
<div id="panel" style="height:100px;overflow:auto"><p style="height:2000px">Panel</p></div>
<input id="q" value=""><textarea id="notes"></textarea>
<select id="pick"><option>One</option><option>Two</option><option>Three</option></select>
<input id="agree" type="checkbox">
<p style="height:3000px">Filler</p>
<script>document.getElementById("seen").textContent = sessionStorage.getItem("cart") ?? "empty"</script>
</body>`

/** A page that loads more as it's scrolled to the bottom. */
const INFINITE_PAGE = `<!doctype html><title>feed</title><body><div id="feed"></div><script>
let count = 0
function more() { for (let i = 0; i < 20; i++) { const p = document.createElement("p"); p.style.height = "40px"; p.textContent = "Post " + count++; feed.append(p) } }
more()
addEventListener("scroll", () => { if (scrollY + innerHeight > document.documentElement.scrollHeight - 200) more() })
</script></body>`

function plain(name: string): string {
  return `<!doctype html><title>${name}</title><body><h1>${name}</h1><p style="height:2000px">.</p></body>`
}

describe("waking a tab as it was", () => {
  let server: Server
  let site = ""
  let browser: AgentBrowser | null = null

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html")
      if (request.url === "/state") {
        response.end(STATE_PAGE)
        return
      }
      if (request.url === "/links") {
        response.end(
          `<!doctype html><title>links</title><body><a href="/a">Alpha</a><a href="/b">Beta</a><button>Gamma</button></body>`,
        )
        return
      }
      if (request.url === "/feed") {
        response.end(INFINITE_PAGE)
        return
      }
      response.end(plain(request.url?.slice(1) ?? ""))
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

  /** Puts `tab` to sleep by opening two more tabs, then wakes it. */
  async function sleepAndWake(tab: Tab) {
    await browser?.open(`${site}/other1`)
    await browser?.open(`${site}/other2`)
    expect(tab.state).toBe("asleep")
    return tab.page()
  }

  it("brings back sessionStorage and window.name before the page's scripts run", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open(`${site}/state`)
    const page = await tab.page()
    await page.evaluate(() => {
      sessionStorage.setItem("cart", "3 items")
      window.name = "checkout"
    })

    const woken = await sleepAndWake(tab)
    expect(await woken.locator("#seen").textContent()).toBe("3 items")
    expect(await woken.evaluate(() => window.name)).toBe("checkout")
  })

  it("brings back fields, panel scroll, page scroll, focus and selection", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open(`${site}/state`)
    const page = await tab.page()
    // Set the way a page's own script would, so the tab is free to sleep.
    await page.evaluate(() => {
      ;(document.getElementById("q") as HTMLInputElement).value = "headless browsers"
      ;(document.getElementById("notes") as HTMLTextAreaElement).value = "compare memory"
      ;(document.getElementById("pick") as HTMLSelectElement).selectedIndex = 2
      ;(document.getElementById("agree") as HTMLInputElement).checked = true
      document.getElementById("panel")?.scrollTo(0, 700)
      window.scrollTo(0, 1200)
      const q = document.getElementById("q") as HTMLInputElement
      q.focus({ preventScroll: true })
      q.setSelectionRange(9, 17)
    })

    const woken = await sleepAndWake(tab)
    const after = await woken.evaluate(() => {
      const q = document.getElementById("q") as HTMLInputElement
      return {
        q: q.value,
        notes: (document.getElementById("notes") as HTMLTextAreaElement).value,
        pick: (document.getElementById("pick") as HTMLSelectElement).selectedIndex,
        agree: (document.getElementById("agree") as HTMLInputElement).checked,
        panel: document.getElementById("panel")?.scrollTop,
        scrollY: window.scrollY,
        focused: document.activeElement?.id,
        selection: [q.selectionStart, q.selectionEnd],
      }
    })
    expect(after).toEqual({
      q: "headless browsers",
      notes: "compare memory",
      pick: 2,
      agree: true,
      panel: 700,
      scrollY: 1200,
      focused: "q",
      selection: [9, 17],
    })
  })

  it("loads again what a feed loaded as it was scrolled, and lands where it was", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open(`${site}/feed`)
    const page = await tab.page()
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await page.waitForTimeout(50)
    }
    const before = await page.evaluate(() => ({
      y: window.scrollY,
      posts: document.querySelectorAll("p").length,
    }))
    expect(before.posts).toBeGreaterThan(60)

    const woken = await sleepAndWake(tab)
    const after = await woken.evaluate(() => ({
      y: window.scrollY,
      posts: document.querySelectorAll("p").length,
    }))
    expect(after.posts).toBeGreaterThanOrEqual(before.posts)
    expect(Math.abs(after.y - before.y)).toBeLessThan(5)
  })

  it("goes back and forward through history it had before it slept", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open(`${site}/one`)
    const page = await tab.page()
    await page.goto(`${site}/two`)
    await page.goto(`${site}/three`)
    await page.goBack()
    expect(page.url()).toBe(`${site}/two`)

    await sleepAndWake(tab)
    expect(await tab.goBack()).toBe(true)
    expect((await tab.page()).url()).toBe(`${site}/one`)
    expect(await tab.goForward()).toBe(true)
    expect((await tab.page()).url()).toBe(`${site}/two`)
    expect(await tab.goForward()).toBe(true)
    expect((await tab.page()).url()).toBe(`${site}/three`)
    expect(await tab.goForward()).toBe(false)
  })

  it("keeps the agent's snapshot refs, so e12 is still the same element", async () => {
    await registerRefSelector()
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open(`${site}/links`)
    const before = (await snapshot(await tab.page())).tree
    const betaRef = before.match(/link "Beta" \[ref=(e\d+)\]/)?.[1]
    expect(betaRef).toBeDefined()

    const woken = await sleepAndWake(tab)
    expect(await woken.locator(`tabref=${betaRef}`).textContent()).toBe("Beta")
    const after = (await snapshot(woken)).tree
    expect(after).toContain(`link "Beta" [ref=${betaRef}]`)
  })

  it("wakes in well under a second with all of it", async () => {
    browser = await launch({ maxLive: 2, block: false })
    const tab = await browser.open(`${site}/state`)
    await (await tab.page()).evaluate(() => sessionStorage.setItem("cart", "1"))
    await browser.open(`${site}/other1`)
    await browser.open(`${site}/other2`)

    const started = performance.now()
    await tab.page()
    const wakeMs = performance.now() - started
    console.log(`wake ${wakeMs.toFixed(0)} ms`)
    expect(wakeMs).toBeLessThan(500)
  })
})
