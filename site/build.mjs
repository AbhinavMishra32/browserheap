/**
 * Puts the launch benchmark results into data.js, which both pages read.
 *
 *   node site/build.mjs
 *
 * Only the numbers the pages draw go in: no page text, no BU Bench task text.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

const results = new URL("../bench/launch/2026-10-15/", import.meta.url)

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

const memory = readFolder("memory/").map((run) => ({
  browser: run.browser,
  finalMb: run.finalMb,
  wake: run.wake ?? null,
  perTab: run.perTab.map((tab) => ({ url: tab.url, mb: tab.totalMb, worked: tab.worked })),
}))

const actions = readFolder("actions/").map((run) => ({
  browser: run.browser,
  passed: run.passed,
  of: run.of,
  results: run.results.map((test) => ({ label: test.label, passed: test.passed })),
}))

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

const bu = readJson("bu-bench.json")

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
// Waking every tab in turn, next to how long the same tab took to load the first time.
const wakeRun = extras.find((run) => run.wakes !== undefined && run.wakes !== null)
let wakeAll = null
if (wakeRun !== undefined) {
  wakeAll = wakeRun.wakes.map((wake) => ({
    url: wakeRun.perTab[wake.index].url,
    wakeMs: wake.ms,
    loadMs: wakeRun.perTab[wake.index].loadMs,
    worked: wake.worked,
  }))
}
// 30 tabs with 1, 2, 4 or 8 of them live (2 comes from the memory run).
const live = []
for (const run of [...extras, ...readFolder("memory/")]) {
  const match = /^browserheap --live (\d+)$/.exec(run.browser)
  if (match !== null && (run.wakes === undefined || run.wakes === null)) {
    live.push({ live: Number(match[1]), finalMb: run.finalMb, perTab: run.perTab.map((tab) => tab.totalMb) })
  }
}
live.sort((a, b) => a.live - b.live)
// 10 agents on one machine, 10 tabs each.
const agents = extras
  .filter((run) => run.rounds !== undefined)
  .map((run) => ({ browser: run.browser, agents: run.agents, stopped: run.stopped, idleMb: run.idleMb, rounds: run.rounds }))

const data = {
  measuredOn: "2026-10-15",
  machine: "E2B sandbox: Linux 6.1 x86_64, 8 vCPUs, 8 GB memory",
  memory,
  actions,
  sites,
  idle,
  scale,
  wakeAll,
  live,
  agents,
  bu: {
    model: bu.model,
    machine: bu.machine,
    chatsAtOnce: bu.chatsAtOnce,
    setups: bu.setups.map((setup) => ({
      setup: setup.setup,
      passed: setup.passed,
      total: setup.total,
      peakMb: setup.peakMb,
      averageMb: setup.averageMb,
      readChars: setup.readChars,
      minutes: setup.minutes,
      tasks: setup.tasks.map((task) => ({
        category: task.category,
        verdict: task.verdict,
        seconds: task.seconds,
        steps: task.steps,
      })),
    })),
  },
}

// Plain ASCII, so the file reads the same however a server labels it.
let json = JSON.stringify(data)
json = json.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
const file = new URL("data.js", import.meta.url)
writeFileSync(file, `// Made by build.mjs from bench/launch/2026-10-15. Don't edit by hand.\nwindow.BENCH = ${json}\n`)
console.log(`wrote site/data.js (${readFileSync(file).length} bytes)`)
