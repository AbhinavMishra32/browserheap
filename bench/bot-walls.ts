/**
 * How often a browser lands on a bot check instead of the page: opens sites
 * that check (search engines, shops, ticketing, news) and looks for the
 * tell-tale words of a challenge page. No model involved.
 *
 *   node bench/bot-walls.ts [setup ...]
 *
 * Setups:
 *   shell           Playwright's Chromium headless shell (Browserheap today)
 *   shell-quiet     the same, without the automation flag in navigator.webdriver
 *   chrome          Google Chrome in its new headless mode
 *   chrome-quiet    Google Chrome, new headless, without the automation flag
 *                   and with a user agent that doesn't say "HeadlessChrome"
 *   shell-filled    the shell, quiet, with what it lacks next to Chrome filled in (fillInChrome)
 *   browserheap     Browserheap itself, as it launches by default (no blocking)
 *   browserheap-shell  Browserheap with --headless-shell
 *   chromium-quiet  the same with Playwright's full Chromium (new headless) instead of Chrome
 *
 * Prints one line per site and setup, then the count of walls per setup.
 *
 * Uses: playwright-core
 */
import { type Browser, chromium, type LaunchOptions } from "playwright-core"
import { launch } from "../src/index.ts"

const SITES = [
  "https://www.google.com/search?q=box+office+2020+worldwide",
  "https://www.bing.com/search?q=box+office+2020+worldwide",
  "https://duckduckgo.com/?q=box+office+2020+worldwide",
  "https://html.duckduckgo.com/html/?q=box+office+2020+worldwide",
  "https://stackexchange.com/sites",
  "https://ra.co/events/uk/london",
  "https://www.amazon.com/s?k=usb+c+cable",
  "https://www.bestbuy.com/site/searchpage.jsp?st=laptop",
  "https://www.target.com/s?searchTerm=lamp",
  "https://www.walmart.com/search?q=lamp",
  "https://www.zillow.com/homes/Austin,-TX_rb/",
  "https://www.indeed.com/jobs?q=nurse",
  "https://www.glassdoor.com/Job/index.htm",
  "https://www.ticketmaster.com/search?q=concert",
  "https://www.booking.com/searchresults.html?ss=Paris",
  "https://www.airbnb.com/s/Paris/homes",
  "https://www.reddit.com/r/programming/",
  "https://www.cnn.com/",
  "https://www.zara.com/us/",
  "https://www.nytimes.com/",
  "https://www.etsy.com/search?q=mug",
  "https://www.yelp.com/search?find_desc=pizza&find_loc=Austin",
]

/** Words a challenge or block page shows. */
const WALL =
  /captcha|unusual traffic|are you a robot|verify (you are|you're) (a )?human|just a moment|access denied|request blocked|blocked|pardon our interruption|press (&|and) hold|security check|not a robot|bot detection|forbidden|error 1020|temporarily restricted|attention required/i

const QUIET_ARGS = ["--disable-blink-features=AutomationControlled"]

/**
 * What the headless shell lacks next to full Chrome, filled in before any
 * page script runs: window.chrome, plugins, a PDF viewer, notification
 * permission, a real GPU name, a network estimate, and brands without
 * "HeadlessChrome".
 */
function fillInChrome(): void {
  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { get: () => value, configurable: true })
  if (!("chrome" in window)) {
    define(window, "chrome", { app: { isInstalled: false }, loadTimes: () => ({}), csi: () => ({}) })
  }
  const pdf = { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }
  const names = [
    "PDF Viewer",
    "Chrome PDF Viewer",
    "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer",
    "WebKit built-in PDF",
  ]
  const plugins = names.map((name) => ({
    name,
    filename: "internal-pdf-viewer",
    description: "Portable Document Format",
    length: 1,
    0: pdf,
  }))
  define(
    Navigator.prototype,
    "plugins",
    Object.assign(plugins, {
      item: (i: number) => plugins[i],
      namedItem: (n: string) => plugins.find((p) => p.name === n) ?? null,
      refresh: () => {},
    }),
  )
  const mimes = [pdf, { ...pdf, type: "text/pdf" }]
  define(
    Navigator.prototype,
    "mimeTypes",
    Object.assign(mimes, {
      item: (i: number) => mimes[i],
      namedItem: (n: string) => mimes.find((m) => m.type === n) ?? null,
    }),
  )
  define(Navigator.prototype, "pdfViewerEnabled", true)
  define(Notification, "permission", "default")
  const data = (
    navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string; version: string }> } }
  ).userAgentData
  if (data) {
    const brands = data.brands.filter((b) => b.brand !== "HeadlessChrome")
    const version = data.brands.find((b) => b.brand === "Chromium")?.version ?? "0"
    define(Object.getPrototypeOf(data), "brands", [...brands, { brand: "Google Chrome", version }])
  }
  for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const original = proto.getParameter
    proto.getParameter = function (this: WebGLRenderingContext, name: number) {
      if (name === 0x9245) return "Google Inc. (Intel)"
      if (name === 0x9246)
        return "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)"
      return original.call(this, name)
    }
  }
}

interface Setup {
  launch: LaunchOptions
  /** A user agent without "Headless" in it. */
  plainAgent: boolean
  /** Fill in what the headless shell lacks (fillInChrome). */
  fillIn?: boolean
}

const SETUPS: Record<string, Setup> = {
  shell: { launch: { headless: true }, plainAgent: false },
  "shell-quiet": { launch: { headless: true, args: QUIET_ARGS }, plainAgent: true },
  chrome: { launch: { headless: true, channel: "chrome" }, plainAgent: false },
  "chrome-quiet": { launch: { headless: true, channel: "chrome", args: QUIET_ARGS }, plainAgent: true },
  "shell-filled": { launch: { headless: true, args: QUIET_ARGS }, plainAgent: true, fillIn: true },
  "chromium-quiet": { launch: { headless: true, channel: "chromium", args: QUIET_ARGS }, plainAgent: true },
}

async function userAgentOf(browser: Browser): Promise<string> {
  const page = await browser.newPage()
  const agent = await page.evaluate(() => navigator.userAgent)
  await page.close()
  return agent.replace("HeadlessChrome", "Chrome")
}

async function check(setupName: string): Promise<number> {
  if (setupName === "browserheap" || setupName === "browserheap-shell") {
    return checkBrowserheap(setupName)
  }
  const setup = SETUPS[setupName] as Setup
  const browser = await chromium.launch(setup.launch)
  const userAgent = setup.plainAgent ? await userAgentOf(browser) : undefined
  const context = await browser.newContext({ userAgent, viewport: { width: 1280, height: 800 } })
  if (setup.fillIn) {
    await context.addInitScript(fillInChrome)
    // The Sec-CH-UA header carries the brands too.
    const version = (userAgent ?? "").match(/Chrome\/(\d+)/)?.[1] ?? "0"
    await context.setExtraHTTPHeaders({
      "sec-ch-ua": `"Chromium";v="${version}", "Google Chrome";v="${version}", "Not_A Brand";v="24"`,
    })
  }
  let walls = 0
  for (const url of SITES) {
    const page = await context.newPage()
    let verdict = ""
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
      await page.waitForTimeout(3_000)
      const title = await page.title()
      const text = await page.evaluate(() => document.body?.innerText.slice(0, 3000) ?? "")
      const status = response?.status() ?? 0
      const walled =
        status === 403 || status === 429 || WALL.test(title) || (text.length < 1500 && WALL.test(text))
      verdict = walled ? `WALL ${status}` : `ok   ${status}`
      if (walled) {
        walls++
      }
      verdict += `  ${title.slice(0, 60)}`
    } catch (error) {
      verdict = `fail ${String(error).split("\n")[0]?.slice(0, 60)}`
      walls++
    }
    console.log(`${setupName.padEnd(13)} ${verdict.padEnd(80)} ${new URL(url).hostname}`)
    await page.close()
  }
  await browser.close()
  return walls
}

/** The same sites through Browserheap's own launch. */
async function checkBrowserheap(name: string): Promise<number> {
  const shell = name === "browserheap-shell"
  const browser = await launch({ block: false, maxLive: 2, engine: { kind: "chromium", shell } })
  let walls = 0
  for (const url of SITES) {
    let verdict = ""
    try {
      const tab = await browser.open(url)
      const page = await tab.page()
      await page.waitForTimeout(3_000)
      const title = await page.title()
      const text = await page.evaluate(() => document.body?.innerText.slice(0, 3000) ?? "")
      const walled = WALL.test(title) || (text.length < 1500 && WALL.test(text))
      verdict = `${walled ? "WALL" : "ok  "}      ${title.slice(0, 60)}`
      if (walled) {
        walls++
      }
    } catch (error) {
      verdict = `fail ${String(error).split("\n")[0]?.slice(0, 60)}`
      walls++
    }
    console.log(`${name.padEnd(13)} ${verdict.padEnd(80)} ${new URL(url).hostname}`)
  }
  await browser.close()
  return walls
}

const chosen =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [...Object.keys(SETUPS), "browserheap", "browserheap-shell"]
const totals: string[] = []
for (const setup of chosen) {
  const walls = await check(setup)
  totals.push(`${setup}: ${walls} of ${SITES.length} walled`)
}
console.log(totals.join("\n"))
