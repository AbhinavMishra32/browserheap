/**
 * Blocking, on a real Chromium against a local page that asks for a
 * picture, a font, its own script, and Google Analytics.
 *
 * The first run downloads Ghostery's lists (then they're cached), and it
 * needs Chromium's headless shell (`pnpm setup`).
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { type Browser, chromium } from "playwright-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startBlocking } from "../src/blocking.ts"

const PAGE = `<!doctype html>
<html><head>
  <style>@font-face { font-family: F; src: url(/font.woff2) } body { font-family: F }</style>
  <script src="/app.js"></script>
  <script src="https://www.google-analytics.com/analytics.js"></script>
</head><body>
  <p id="text">Hello</p>
  <img src="/photo.png">
</body></html>`

describe("blocking", () => {
  let server: Server
  let url = ""
  /** The paths our server was asked for. */
  let asked: string[] = []
  let browser: Browser

  beforeAll(async () => {
    server = createServer((request, response) => {
      asked.push(request.url ?? "")
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html")
        response.end(PAGE)
        return
      }
      if (request.url === "/app.js") {
        response.setHeader("Content-Type", "text/javascript")
        response.end(`document.title = "app ran"`)
        return
      }
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
    server.close()
  })

  it("stops ads, trackers, pictures and fonts, and keeps the page and its own scripts", async () => {
    asked = []
    const context = await browser.newContext()
    const blocked = await startBlocking(context)
    const page = await context.newPage()
    await page.goto(url)
    await page.waitForLoadState("networkidle")

    expect(await page.textContent("#text")).toBe("Hello")
    expect(await page.title()).toBe("app ran")
    expect(asked).toContain("/app.js")
    expect(asked).not.toContain("/photo.png")
    expect(asked).not.toContain("/font.woff2")
    expect(blocked.ads).toBe(1)
    expect(blocked.media).toBeGreaterThanOrEqual(1)
    await context.close()
  }, 60_000)

  it("keeps pictures and fonts when media blocking is off", async () => {
    asked = []
    const context = await browser.newContext()
    const blocked = await startBlocking(context, { media: false })
    const page = await context.newPage()
    await page.goto(url)
    await page.waitForLoadState("networkidle")

    expect(asked).toContain("/photo.png")
    expect(blocked.media).toBe(0)
    expect(blocked.ads).toBe(1)
    await context.close()
  }, 60_000)
})
