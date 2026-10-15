/**
 * Captures the real pages the hero demo's agent opens, with Browserheap
 * itself: each page's title, the agent's snapshot of it (the interactive
 * part), the first of its text, and its favicon. The demo replays these, so
 * everything a visitor hovers or clicks is what an agent really saw.
 *
 *   node site/capture-demo.ts        writes site/demo.js
 *
 * Favicons and screenshots go in as data: URIs, because the published page
 * can't load images from other sites. Screenshots are shrunk to 640 px wide
 * with macOS's sips, so the demo stays light.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSession } from "../src/index.ts"

/** The research task's pages, in the order the agent opens them; `main` picks the article where a page has chrome around it. */
const PAGES: { key: string; url: string; main?: string }[] = [
  { key: "wiki", url: "https://en.wikipedia.org/wiki/Headless_browser", main: "#mw-content-text .mw-parser-output" },
  { key: "playwright", url: "https://github.com/microsoft/playwright", main: "article" },
  { key: "puppeteer", url: "https://pptr.dev/" },
  { key: "selenium", url: "https://www.selenium.dev/" },
  { key: "lightpanda", url: "https://lightpanda.io/" },
  { key: "hn", url: "https://news.ycombinator.com/" },
  { key: "browseruse", url: "https://github.com/browser-use/browser-use", main: "article" },
  { key: "chrome", url: "https://developer.chrome.com/docs/chromium/headless" },
]

const TREE_LINES = 18
const TEXT_CHARS = 420

async function favicon(url: string): Promise<string> {
  const host = new URL(url).hostname
  const response = await fetch(`https://www.google.com/s2/favicons?domain=${host}&sz=64`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const type = response.headers.get("content-type") ?? "image/png"
  return `data:${type};base64,${bytes.toString("base64")}`
}

/** A screenshot, 640 px wide as a small JPEG, as a data: URI. */
function shrink(base64: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "browserheap-demo-")), "shot.jpg")
  writeFileSync(file, Buffer.from(base64, "base64"))
  execFileSync("sips", ["-Z", "640", "-s", "format", "jpeg", "-s", "formatOptions", "55", file], { stdio: "ignore" })
  return `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`
}

const session = await startSession({ maxLive: 2 })
const pages = []
for (const page of PAGES) {
  // The agent's view of the page, as the REPL would print it.
  const code = `
    await openTab(${JSON.stringify(page.url)})
    const shot = await snapshot(page, { interactive: true })
    // The page's main content when it marks one, else all its text.
    const main = page.locator(${JSON.stringify(page.main ?? "main, article, [role=main]")}).first()
    const text = (await main.count()) > 0 ? await main.innerText() : await page.text()
    console.log(JSON.stringify({
      title: await page.title(),
      url: page.url(),
      tree: shot.tree.split("\\n").slice(0, ${TREE_LINES}).join("\\n"),
      text: text.replace(/\\s+/g, " ").trim().slice(0, ${TEXT_CHARS}),
    }))
    display(await page.screenshot({ type: "jpeg", quality: 80 }))
  `
  const result = await session.run(code)
  const printed = result.content.find((part) => part.type === "text")
  if (printed === undefined || printed.type !== "text") {
    console.error(`no output for ${page.url}`)
    continue
  }
  const seen = JSON.parse(printed.text.trim().split("\n").at(-1) ?? "{}")
  const tree = String(seen.tree ?? "").split("\n").slice(0, TREE_LINES)
  const shot = result.content.find((part) => part.type === "image")
  const preview = shot !== undefined && shot.type === "image" ? shrink(shot.data) : ""
  pages.push({ key: page.key, url: seen.url, title: seen.title, tree, text: seen.text, icon: await favicon(page.url), preview })
  console.log(`${page.key}: ${seen.title} (${tree.length} tree lines, ${String(seen.text).length} chars)`)
}
await session.close()

writeFileSync(new URL("demo.js", import.meta.url), `// Made by capture-demo.ts: real pages as Browserheap's agent saw them.\nwindow.DEMO_PAGES = ${JSON.stringify(pages)}\n`)
console.log(`wrote site/demo.js with ${pages.length} pages`)
