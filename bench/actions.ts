/**
 * Can an agent work in this browser? Each test is one thing agents do —
 * click a button, fill a search, read a table, look inside an iframe,
 * take a screenshot, go back to an old tab — on action-site.ts, through
 * Playwright, the way agent tools drive a browser. No AI model involved.
 *
 *   node bench/actions.ts agent-tabs        (or chrome, lightpanda, obscura)
 *
 * Prints pass or fail for each test and saves
 * bench/results/actions-<browser>-<time>.json.
 *
 * Uses:    subjects.ts, action-site.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import type { Page } from "playwright-core"
import { type ActionSite, startActionSite } from "./action-site.ts"
import { pixelAt } from "./png.ts"
import { SUBJECTS, type Subject, type SubjectName, sleep, startSubject } from "./subjects.ts"

/** Each test gets this long, all of it. */
const TEST_TIMEOUT_MS = 15_000

interface ActionTest {
  id: string
  /** What an agent is doing, in words. */
  label: string
  /** True when the browser did it right. */
  run(subject: Subject, site: ActionSite): Promise<boolean>
}

/** Opens one tab at `path` on the test site and returns its page. */
async function openPage(subject: Subject, site: ActionSite, path: string): Promise<Page> {
  const tab = await subject.openTab(site.url + path)
  return tab.page()
}

async function textOf(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent({ timeout: 5_000 })) ?? ""
}

const TESTS: ActionTest[] = [
  {
    id: "read-text",
    label: "Read a page's heading",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      return (await textOf(page, "h1")) === "Action test"
    },
  },
  {
    id: "click-link",
    label: "Click a link by its text",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.getByRole("link", { name: "Go to second page" }).click({ timeout: 5_000 })
      await page.waitForURL("**/second", { timeout: 5_000 })
      return (await textOf(page, "h1")) === "Second page"
    },
  },
  {
    id: "click-button",
    label: "Click a button",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.getByRole("button", { name: "Save" }).click({ timeout: 5_000 })
      return (await textOf(page, "#status")) === "Saved"
    },
  },
  {
    id: "type-submit",
    label: "Type in a search box and press Enter",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.getByLabel("Search").fill("tabs", { timeout: 5_000 })
      await page.getByLabel("Search").press("Enter", { timeout: 5_000 })
      await page.waitForURL("**/search?q=tabs", { timeout: 5_000 })
      return (await textOf(page, "h1")) === "Results for tabs"
    },
  },
  {
    id: "select",
    label: "Pick from a dropdown",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.getByLabel("Fruit").selectOption({ label: "Cherry" }, { timeout: 5_000 })
      return (await textOf(page, "#fruit-out")) === "Cherry"
    },
  },
  {
    id: "checkbox",
    label: "Tick a checkbox",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.getByLabel("Remember me").check({ timeout: 5_000 })
      return page.getByLabel("Remember me").isChecked()
    },
  },
  {
    id: "table",
    label: "Read a value from a table",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      const row = page.getByRole("row", { name: /Notebook/ })
      return (await row.getByRole("cell").nth(1).textContent({ timeout: 5_000 })) === "$12.50"
    },
  },
  {
    id: "iframe",
    label: "Click a button inside an iframe from another site",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      const frame = page.frameLocator("iframe")
      await frame.getByRole("button", { name: "Inner button" }).click({ timeout: 5_000 })
      // Its text changes once pressed.
      await frame.getByRole("button", { name: "Pressed" }).waitFor({ timeout: 5_000 })
      return true
    },
  },
  {
    id: "shadow-dom",
    label: "Click a button inside a web component",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.getByRole("button", { name: "Shadow button" }).click({ timeout: 5_000 })
      return (await page.getByText("Shadow pressed").count()) === 1
    },
  },
  {
    id: "visibility",
    label: "Tell a hidden link from a visible one",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      const hidden = await page.locator("#hidden-link").isVisible()
      const visible = await page.locator("#visible-link").isVisible()
      return hidden === false && visible === true
    },
  },
  {
    id: "position",
    label: "Know where an element is on the page",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      const box = await page.locator("#box").boundingBox({ timeout: 5_000 })
      if (box === null) {
        return false
      }
      const near = (a: number, b: number) => Math.abs(a - b) <= 2
      return near(box.x, 200) && near(box.y, 300) && near(box.width, 120) && near(box.height, 40)
    },
  },
  {
    id: "click-at-position",
    label: "Click at a spot on the page (like vision agents do)",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      await page.mouse.click(260, 320)
      return (await textOf(page, "#box-out")) === "Clicked box"
    },
  },
  {
    id: "scroll-load-more",
    label: "Scroll down and get more items",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/list")
      const before = await page.locator("li").count()
      await page.mouse.wheel(0, 5_000)
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await page.locator("li").count()) > before) {
          return true
        }
        await sleep(250)
      }
      return false
    },
  },
  {
    id: "popup",
    label: "Follow a link that opens a new tab",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      const popupOpened = page.waitForEvent("popup", { timeout: 5_000 })
      await page.getByRole("link", { name: "Open popup" }).click({ timeout: 5_000 })
      const popup = await popupOpened
      await popup.waitForLoadState("load", { timeout: 5_000 })
      return (await textOf(popup, "h1")) === "Popup page"
    },
  },
  {
    id: "js-content",
    label: "Read text a page loads after it opens",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/spa")
      await page.getByText("Loaded from the server").waitFor({ timeout: 5_000 })
      return true
    },
  },
  {
    id: "cookies",
    label: "Stay signed in from one page to the next",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/login")
      await page.goto(`${site.url}/whoami`, { timeout: 5_000 })
      return (await textOf(page, "p")).includes("session=abc123")
    },
  },
  {
    id: "screenshot",
    label: "Take a screenshot that shows the page as drawn",
    run: async (subject, site) => {
      const page = await openPage(subject, site, "/")
      const png = await page.screenshot({ timeout: 5_000 })
      // The green box (#44aa77) is at 200,300, 120 by 40: its middle must be green.
      const colour = pixelAt(png, 260, 320)
      const near = (a: number, b: number) => Math.abs(a - b) <= 12
      return near(colour.red, 0x44) && near(colour.green, 0xaa) && near(colour.blue, 0x77)
    },
  },
  {
    id: "many-tabs",
    label: "Keep 5 tabs open and read each",
    run: async (subject, site) => {
      // Each path, and the heading it shows.
      const pages = [
        { path: "/", heading: "Action test" },
        { path: "/second", heading: "Second page" },
        { path: "/list", heading: "List" },
        { path: "/popup", heading: "Popup page" },
        { path: "/search?q=five", heading: "Results for five" },
      ]
      const opened = []
      for (const { path, heading } of pages) {
        opened.push({ tab: await subject.openTab(site.url + path), heading })
      }
      for (const { tab, heading } of opened) {
        if ((await textOf(await tab.page(), "h1")) !== heading) {
          return false
        }
      }
      return true
    },
  },
  {
    id: "back-to-old-tab",
    label: "Go back to a tab opened earlier",
    run: async (subject, site) => {
      const first = await subject.openTab(`${site.url}/search?q=first`)
      await subject.openTab(`${site.url}/second`)
      await subject.openTab(`${site.url}/list`)
      await subject.openTab(`${site.url}/popup`)
      // agent-tabs put this one to sleep by now; page() wakes it.
      const page = await first.page()
      return (await textOf(page, "h1")) === "Results for first"
    },
  },
]

interface ActionResult {
  id: string
  label: string
  passed: boolean
  ms: number
  error?: string
}

async function runTest(test: ActionTest, name: SubjectName, site: ActionSite): Promise<ActionResult> {
  // A fresh browser for each test, so one failure can't break the next.
  const started = Date.now()
  let subject: Subject | null = null
  try {
    subject = await startSubject(name)
    const running = subject
    const passed = await withTimeout(test.run(running, site), TEST_TIMEOUT_MS)
    return { id: test.id, label: test.label, passed, ms: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return { id: test.id, label: test.label, passed: false, ms: Date.now() - started, error: message }
  } finally {
    await subject?.close().catch(() => {})
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`took over ${ms / 1000} s`)), ms)),
  ])
}

async function main(): Promise<void> {
  const name = process.argv[2] as SubjectName
  if (!SUBJECTS.includes(name)) {
    console.error(`Which browser? One of: ${SUBJECTS.join(", ")}`)
    process.exit(1)
  }

  const site = await startActionSite()
  const results: ActionResult[] = []
  for (const test of TESTS) {
    const result = await runTest(test, name, site)
    results.push(result)
    const mark = result.passed ? "pass" : "FAIL"
    console.log(`${mark}  ${test.label}${result.error === undefined ? "" : `  (${result.error})`}`)
  }
  await site.close()

  let passed = 0
  for (const result of results) {
    if (result.passed) {
      passed++
    }
  }
  console.log(`\n${name}: ${passed} of ${results.length} actions work`)

  const measuredAt = new Date().toISOString()
  const resultsDir = new URL("./results/", import.meta.url).pathname
  mkdirSync(resultsDir, { recursive: true })
  const file = `${resultsDir}actions-${name}-${measuredAt.replace(/[:.]/g, "-")}.json`
  writeFileSync(
    file,
    `${JSON.stringify({ browser: name, passed, of: results.length, measuredAt, results }, null, 2)}\n`,
  )
  console.log(`saved ${file}`)
  process.exit(0)
}

await main()
