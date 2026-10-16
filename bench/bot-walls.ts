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
 *   chromium-quiet  the same with Playwright's full Chromium (new headless) instead of Chrome
 *
 * Prints one line per site and setup, then the count of walls per setup.
 *
 * Uses: playwright-core
 */
import { type Browser, chromium, type LaunchOptions } from "playwright-core"

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

interface Setup {
  launch: LaunchOptions
  /** A user agent without "Headless" in it. */
  plainAgent: boolean
}

const SETUPS: Record<string, Setup> = {
  shell: { launch: { headless: true }, plainAgent: false },
  "shell-quiet": { launch: { headless: true, args: QUIET_ARGS }, plainAgent: true },
  chrome: { launch: { headless: true, channel: "chrome" }, plainAgent: false },
  "chrome-quiet": { launch: { headless: true, channel: "chrome", args: QUIET_ARGS }, plainAgent: true },
  "chromium-quiet": { launch: { headless: true, channel: "chromium", args: QUIET_ARGS }, plainAgent: true },
}

async function userAgentOf(browser: Browser): Promise<string> {
  const page = await browser.newPage()
  const agent = await page.evaluate(() => navigator.userAgent)
  await page.close()
  return agent.replace("HeadlessChrome", "Chrome")
}

async function check(setupName: string): Promise<number> {
  const setup = SETUPS[setupName] as Setup
  const browser = await chromium.launch(setup.launch)
  const userAgent = setup.plainAgent ? await userAgentOf(browser) : undefined
  const context = await browser.newContext({ userAgent, viewport: { width: 1280, height: 800 } })
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

const chosen = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SETUPS)
const totals: string[] = []
for (const setup of chosen) {
  const walls = await check(setup)
  totals.push(`${setup}: ${walls} of ${SITES.length} walled`)
}
console.log(totals.join("\n"))
