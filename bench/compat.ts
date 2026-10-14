/**
 * Do real sites work in this browser? Opens each site in compat-sites.ts in
 * its own tab, one at a time, and records how long it took and the page's
 * text. No AI model involved. (Layout is tested in actions.ts: on real sites
 * an engine can report sizes it never laid out.)
 *
 *   node bench/compat.ts chrome            (or agent-tabs, lightpanda, obscura)
 *   node bench/compat.ts lightpanda 5      only the first 5 sites
 *
 * Saves bench/results/compat-<browser>-<time>.json with every site's
 * result, text included (the first 20,000 characters), so the launch page
 * can say how much of what Chrome shows each browser shows too.
 *
 *   loaded      the page shows more than 200 characters of text
 *   loadMs      from opening the tab to the page's load event
 *
 * Uses:    subjects.ts, compat-sites.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { COMPAT_SITES } from "./compat-sites.ts"
import { SUBJECTS, type Subject, type SubjectName, startSubject } from "./subjects.ts"

/** Opening and reading one site gets this long. */
const SITE_TIMEOUT_MS = 45_000
const TEXT_KEPT = 20_000

interface SiteResult {
  kind: string
  url: string
  loaded: boolean
  loadMs: number | null
  textLength: number
  text: string
  error?: string
}

async function checkSite(subject: Subject, kind: string, url: string): Promise<SiteResult> {
  const started = Date.now()
  const tab = await subject.openTab(url)
  const loadMs = Date.now() - started
  try {
    const page = await tab.page()
    const text: string = await page.evaluate(() => document.body?.innerText ?? "")
    return {
      kind,
      url,
      loaded: text.length > 200,
      loadMs,
      textLength: text.length,
      text: text.slice(0, TEXT_KEPT),
    }
  } finally {
    await tab.close().catch(() => {})
  }
}

function failed(kind: string, url: string, error: unknown): SiteResult {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error)
  return { kind, url, loaded: false, loadMs: null, textLength: 0, text: "", error: message }
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
  const sites = COMPAT_SITES.slice(0, Number(process.argv[3] ?? COMPAT_SITES.length))

  let subject = await startSubject(name)
  const results: SiteResult[] = []
  for (const site of sites) {
    let result: SiteResult
    try {
      result = await withTimeout(checkSite(subject, site.kind, site.url), SITE_TIMEOUT_MS)
    } catch (error) {
      result = failed(site.kind, site.url, error)
      // The browser may be stuck or gone: start it again for the next site.
      await subject.close().catch(() => {})
      subject = await startSubject(name)
    }
    results.push(result)
    const time = result.loadMs === null ? "     -" : `${(result.loadMs / 1000).toFixed(1).padStart(5)}s`
    const mark = result.loaded ? "ok  " : "FAIL"
    console.log(`${mark} ${time}  ${site.url}${result.error ? `  (${result.error})` : ""}`)
  }
  await subject.close().catch(() => {})

  let loaded = 0
  for (const result of results) {
    if (result.loaded) {
      loaded++
    }
  }
  console.log(`\n${name}: ${loaded} of ${results.length} sites loaded`)

  const measuredAt = new Date().toISOString()
  const resultsDir = new URL("./results/", import.meta.url).pathname
  mkdirSync(resultsDir, { recursive: true })
  const file = `${resultsDir}compat-${name}-${measuredAt.replace(/[:.]/g, "-")}.json`
  writeFileSync(
    file,
    `${JSON.stringify({ browser: name, loaded, of: results.length, measuredAt, results }, null, 2)}\n`,
  )
  console.log(`saved ${file}`)
  process.exit(0)
}

await main()
