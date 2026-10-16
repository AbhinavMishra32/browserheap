/**
 * Puts the launch benchmark results into data.js, which both pages read.
 *
 *   node site/build.mjs
 *
 * Only the numbers the pages draw go in: no page text.
 *
 * Memory ran 3 times per browser and waking 3 times: each one's chart shows
 * its median run (by final memory, by median wake), and `runs` keeps every
 * run's number for the spread.
 *
 * Browserheap ran twice over: on Chromium (the default) and on Chromium's
 * headless shell (`--headless-shell`, its runs named "… --headless-shell" or
 * "browserheap-shell"). The pages show one at a time (charts.js).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

const MEASURED_ON = "2026-10-16"
const VERSION = "0.3.0"
const results = new URL(`../bench/launch/${MEASURED_ON}/`, import.meta.url)

function readJson(path) {
  // These runs were recorded before the rename, as "agent-tabs".
  const text = readFileSync(new URL(path, results), "utf8").replaceAll("agent-tabs", "browserheap")
  return JSON.parse(text)
}

function readFolder(folder) {
  const all = []
  // Later runs (idle, scale, extras) may not be there yet.
  if (!existsSync(new URL(folder, results))) {
    return all
  }
  for (const name of readdirSync(new URL(folder, results))) {
    if (name.endsWith(".json")) {
      all.push(readJson(folder + name))
    }
  }
  return all
}

/** The middle one of a browser's runs, ordered by `score`, with every run's score kept. */
function medianRuns(runs, score) {
  const byBrowser = new Map()
  for (const run of runs) {
    const list = byBrowser.get(run.browser) ?? []
    list.push(run)
    byBrowser.set(run.browser, list)
  }
  const chosen = []
  for (const list of byBrowser.values()) {
    list.sort((a, b) => score(a) - score(b))
    const middle = list[Math.floor((list.length - 1) / 2)]
    chosen.push({ run: middle, runs: list.map(score) })
  }
  return chosen
}

const memory = medianRuns(readFolder("memory/"), (run) => run.finalMb).map(({ run, runs }) => ({
  browser: run.browser,
  finalMb: run.finalMb,
  runs,
  wake: run.wake ?? null,
  perTab: run.perTab.map((tab) => ({ url: tab.url, mb: tab.totalMb, worked: tab.worked })),
}))

const actions = readFolder("actions/").map((run) => ({
  browser: run.browser,
  passed: run.passed,
  of: run.of,
  results: run.results.map((test) => ({ label: test.label, passed: test.passed })),
}))

// Real sites. The first build turns the compat runs (one file per browser, with each page's
// text) into sites.json: just the scores, so no site's text is kept in the repository.
// "Same as Chrome": the share of the distinct words (4+ letters) on Chrome's page that this
// browser's page shows too, counted only where both loaded.
if (!existsSync(new URL("sites.json", results))) {
  writeSitesJson(readFolder("compat/"))
}
const sites = {}
for (const [browser, list] of Object.entries(readJson("sites.json").browsers)) {
  sites[browser] = list.map((site) => ({
    kind: site.kind,
    url: site.url,
    loaded: site.loaded,
    loadMs: site.loadMs,
    sameAsChrome: site.sameAsChrome,
  }))
}

function writeSitesJson(compat) {
  const chromeRun = compat.find((run) => run.browser === "chrome")
  const wordsOf = (text) => new Set((text ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const browsers = {}
  for (const run of compat) {
    browsers[run.browser] = run.results.map((site, i) => {
      const chromeSite = chromeRun?.results[i]
      let sameAsChrome = null
      if (chromeSite?.loaded && site.loaded) {
        const chromeWords = wordsOf(chromeSite.text)
        const ours = wordsOf(site.text)
        let shared = 0
        for (const word of chromeWords) {
          if (ours.has(word)) shared++
        }
        sameAsChrome = chromeWords.size === 0 ? null : Math.round((shared / chromeWords.size) * 100) / 100
      }
      return { kind: site.kind, url: site.url, loaded: site.loaded, loadMs: site.loadMs, sameAsChrome }
    })
  }
  const note = "sameAsChrome: share of the distinct words (4+ letters) on Chrome's page that this browser's page also shows; null where either didn't load"
  writeFileSync(new URL("sites.json", results), `${JSON.stringify({ note, browsers }, null, 2)}\n`)
}

// 30 tabs, then 10 idle minutes.
const idle = readFolder("idle/").map((run) => ({
  browser: run.browser,
  samples: (run.idle ?? []).map((sample) => ({ seconds: sample.seconds, mb: sample.mb, cpu: sample.cpuPercent })),
}))

// Up to 100 tabs, until 6.5 GB or a crash.
const scale = readFolder("scale/").map((run) => ({
  browser: run.browser,
  stopped: run.stopped ?? null,
  perTab: run.perTab.map((tab) => ({ mb: tab.totalMb, worked: tab.worked })),
}))

const extras = readFolder("extras/")
// Waking every tab in turn, next to how long the same tab took to load the first time:
// the run with the median of its wake times, of the 3.
const medianOf = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor((numbers.length - 1) / 2)]
const wakeRuns = medianRuns(
  extras.filter((run) => run.wakes !== undefined && run.wakes !== null),
  (run) => medianOf(run.wakes.map((wake) => wake.ms)),
)
function wakeOf(browser) {
  const chosen = wakeRuns.find((each) => each.run.browser === browser)
  if (chosen === undefined) {
    return { wakeAll: null, medians: [] }
  }
  const wakeAll = chosen.run.wakes.map((wake) => ({
    url: chosen.run.perTab[wake.index].url,
    wakeMs: wake.ms,
    loadMs: chosen.run.perTab[wake.index].loadMs,
    worked: wake.worked,
  }))
  return { wakeAll, medians: chosen.runs }
}
const wake = {
  chromium: wakeOf("browserheap --live 2"),
  shell: wakeOf("browserheap --live 2 --headless-shell"),
}
// 30 tabs with 1, 2, 4 or 8 of them live (2 comes from the memory run).
const live = []
// 2 live is the memory run itself: the median one.
const memoryForLive = memory
  .filter((run) => run.browser.startsWith("browserheap --live 2"))
  .map((run) => ({ browser: run.browser, finalMb: run.finalMb, perTab: run.perTab.map((tab) => ({ totalMb: tab.mb })) }))
for (const run of [...extras, ...memoryForLive]) {
  const match = /^browserheap --live (\d+)( --headless-shell)?$/.exec(run.browser)
  if (match !== null && (run.wakes === undefined || run.wakes === null)) {
    live.push({
      live: Number(match[1]),
      shell: match[2] !== undefined,
      finalMb: run.finalMb,
      perTab: run.perTab.map((tab) => tab.totalMb),
    })
  }
}
live.sort((a, b) => a.live - b.live)
// 10 agents on one machine, 10 tabs each.
const agents = extras
  .filter((run) => run.rounds !== undefined)
  .map((run) => ({ browser: run.browser, agents: run.agents, stopped: run.stopped, idleMb: run.idleMb, rounds: run.rounds }))

// Sites that check for bots (bench/bot-walls.ts): how many of them turned each browser away,
// from E2B (a data centre) and from a home connection.
const walls = {
  sites: readJson("walls/data-centre.json").sites,
  dataCentre: readJson("walls/data-centre.json").walled,
  home: readJson("walls/home.json").walled,
}

const data = {
  measuredOn: MEASURED_ON,
  version: VERSION,
  wake,
  walls,
  machine: "E2B sandbox: Linux 6.1 x86_64, 8 vCPUs, 8 GB memory",
  memory,
  actions,
  sites,
  idle,
  scale,
  live,
  agents,
}

// Plain ASCII, so the file reads the same however a server labels it.
let json = JSON.stringify(data)
json = json.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
const file = new URL("data.js", import.meta.url)
writeFileSync(file, `// Made by build.mjs from bench/launch/${MEASURED_ON}. Don't edit by hand.\nwindow.BENCH = ${json}\n`)
console.log(`wrote site/data.js (${readFileSync(file).length} bytes)`)
