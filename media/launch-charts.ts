/**
 * The launch post's images, where the gap is the picture:
 *   1-race.png     memory as tabs pile up to 100; every other browser runs out
 *   2-memory.png   memory with 30 tabs open, one bar per browser
 *   3-cpu.png      CPU while nothing happens, one bar per browser
 * 16:9 PNGs for X and LinkedIn (1200x675, drawn at 2x), from the same numbers
 * as the site (site/data.js). Instrument Sans for words, Geist Mono for numbers.
 *
 *   node media/launch-charts.ts      writes media/launch/*.png
 *
 * Uses: playwright-core, site/data.js, site/logo.svg
 */
import { mkdirSync, readFileSync } from "node:fs"
import { chromium } from "playwright-core"

// site/data.js sets window.BENCH; run it with a stand-in window.
const window: { BENCH?: any } = {}
new Function("window", readFileSync(new URL("../site/data.js", import.meta.url), "utf8"))(window)
const B = window.BENCH

const LOGO = `data:image/svg+xml;base64,${readFileSync(new URL("../site/logo.svg", import.meta.url)).toString("base64")}`

const JADE = "#1fd8a4"
const INK = "#eef4f1"

const OURS = "browserheap --live 2"
const OTHERS = ["agent-browser", "stagehand", "browser-use", "playwright-mcp", "chrome-shell", "lightpanda", "obscura"]
const NAMES: Record<string, string> = {
  [OURS]: "Browserheap",
  "agent-browser": "agent-browser",
  stagehand: "Stagehand",
  "browser-use": "browser-use",
  "playwright-mcp": "Playwright MCP",
  "chrome-shell": "Headless Chrome",
  lightpanda: "Lightpanda",
  obscura: "Obscura",
}

const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap">'

/** What every image shares: the black page, the name on the left and the site on the right. */
const BASE = `
  body { margin: 0; width: 1200px; height: 675px; background: #070908; color: ${INK}; font-family: "Instrument Sans", sans-serif; overflow: hidden; }
  .top { position: absolute; left: 56px; right: 56px; top: 44px; display: flex; justify-content: space-between; align-items: center; z-index: 2; }
  .brand { display: flex; align-items: center; gap: 12px; font: 600 26px "Instrument Sans", sans-serif; letter-spacing: -0.02em; }
  .brand img { width: 32px; height: 32px; }
  .site { font: 500 24px "Geist Mono", monospace; color: ${JADE}; }
`
const TOP = `<div class="top"><div class="brand"><img src="${LOGO}" alt="">Browserheap</div><div class="site">browserheap.com</div></div>`

function runOf(list: { browser: string }[], id: string): any {
  return list.find((run) => run.browser === id)
}

/** CPU once the pages have settled: the average over the last 5 of the 10 idle minutes, as % of one core. */
function settledCpu(id: string): number {
  const samples = runOf(B.idle, id).samples.filter((sample: { cpu: number | null; seconds: number }) => sample.cpu !== null && sample.seconds >= 300)
  let total = 0
  for (const sample of samples) {
    total += sample.cpu
  }
  return total / samples.length
}

/** Memory as tabs pile up to 100, full bleed under the headline; every other browser ends at the machine's limit. */
function racePage(): string {
  const width = 1200
  const height = 675
  const plot = { left: 56, right: width - 56, top: 250, bottom: height - 70 }
  const x = (tab: number) => plot.left + (tab / 100) * (plot.right - plot.left)
  const y = (mb: number) => plot.bottom - (mb / 7000) * (plot.bottom - plot.top)

  let svg = `<svg width="${width}" height="${height}" style="position: absolute; inset: 0" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${JADE}" stop-opacity="0.35"/><stop offset="1" stop-color="${JADE}" stop-opacity="0"/></linearGradient>
      <filter id="glow"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>`
  // The limit: 6.5 GB of the sandbox's 8 GB, where the runs stopped.
  svg += `<line x1="${plot.left}" x2="${plot.right}" y1="${y(6500)}" y2="${y(6500)}" stroke="rgb(238 244 241 / 0.35)" stroke-dasharray="6 7" stroke-width="2"/>`
  svg += `<text x="${plot.right}" y="${y(6500) - 14}" fill="rgb(238 244 241 / 0.6)" font-family="Geist Mono" font-size="20" text-anchor="end">8 GB machine full</text>`
  svg += `<line x1="${plot.left}" x2="${plot.right}" y1="${plot.bottom}" y2="${plot.bottom}" stroke="rgb(238 244 241 / 0.14)" stroke-width="2"/>`
  for (const tab of [0, 25, 50, 75, 100]) {
    const anchor = tab === 0 ? "start" : tab === 100 ? "end" : "middle"
    const label = tab === 100 ? "100 tabs" : String(tab)
    svg += `<text x="${x(tab)}" y="${plot.bottom + 34}" fill="rgb(238 244 241 / 0.5)" font-family="Geist Mono" font-size="20" text-anchor="${anchor}">${label}</text>`
  }

  // The others: a grey line each, and an × where it ran out.
  for (const id of OTHERS) {
    const run = runOf(B.scale, id)
    const points = run.perTab.map((tab: { mb: number }, index: number) => `${x(index + 1)},${y(Math.min(tab.mb, 6600))}`).join(" ")
    svg += `<polyline points="${points}" fill="none" stroke="rgb(238 244 241 / 0.38)" stroke-width="2.5" stroke-linejoin="round"/>`
    svg += `<text x="${x(run.perTab.length)}" y="${y(6500) + 9}" fill="${INK}" font-size="28" font-weight="600" text-anchor="middle">×</text>`
  }
  const lastOther = Math.max(...OTHERS.map((id) => runOf(B.scale, id).perTab.length))

  // Browserheap: a glowing jade line with a soft fill under it.
  const ours = runOf(B.scale, OURS)
  const points = ours.perTab.map((tab: { mb: number }, index: number) => `${x(index + 1)},${y(tab.mb)}`).join(" ")
  svg += `<polygon points="${x(1)},${plot.bottom} ${points} ${x(100)},${plot.bottom}" fill="url(#fill)"/>`
  svg += `<polyline points="${points}" fill="none" stroke="${JADE}" stroke-width="10" stroke-linejoin="round" filter="url(#glow)" opacity="0.6"/>`
  svg += `<polyline points="${points}" fill="none" stroke="${JADE}" stroke-width="5" stroke-linejoin="round"/>`
  svg += `<text x="${x(100)}" y="${y(1000) - 34}" fill="${JADE}" font-family="Instrument Sans" font-size="32" font-weight="700" text-anchor="end">Browserheap: 100 tabs in 1 GB</text>`
  svg += `<text x="${x(80)}" y="${y(4800)}" fill="rgb(238 244 241 / 0.7)" font-family="Instrument Sans" font-size="24" font-weight="500" text-anchor="middle">${OTHERS.length} other agent browsers,</text>`
  svg += `<text x="${x(80)}" y="${y(4800) + 32}" fill="rgb(238 244 241 / 0.7)" font-family="Instrument Sans" font-size="24" font-weight="500" text-anchor="middle">out of memory by tab ${lastOther}</text>`
  svg += "</svg>"

  return `<!doctype html><meta charset="utf-8">${FONTS}<style>${BASE}
  h1 { position: absolute; left: 56px; top: 108px; margin: 0; z-index: 2; font: 600 58px/1.02 "Instrument Sans", sans-serif; letter-spacing: -0.03em; }
  </style>
  ${TOP}
  <h1>A browser for agents that<br>never runs out of memory.</h1>
  ${svg}`
}

/** A big number and a line on the left; one bar per browser on the right, least first. */
function barsPage(options: { rows: { id: string; value: number }[]; big: string; title: string; note: string; format: (value: number) => string }): string {
  const rows = [...options.rows].sort((a, b) => a.value - b.value)
  const max = Math.max(...rows.map((row) => row.value))
  let bars = ""
  for (const row of rows) {
    const ours = row.id === OURS
    bars += `<div class="row${ours ? " ours" : ""}"><span class="name">${NAMES[row.id]}</span><span class="track"><i style="width: ${(row.value / max) * 100}%"></i></span><span class="value">${options.format(row.value)}</span></div>`
  }

  return `<!doctype html><meta charset="utf-8">${FONTS}<style>${BASE}
  .wrap { position: absolute; left: 56px; right: 56px; top: 108px; bottom: 50px; display: grid; grid-template-columns: 430px 1fr; gap: 48px; align-items: center; }
  .big { font: 700 150px/0.9 "Instrument Sans", sans-serif; letter-spacing: -0.035em; color: ${JADE}; }
  h2 { margin: 0; font: 600 58px/1.02 "Instrument Sans", sans-serif; letter-spacing: -0.03em; }
  p { margin: 18px 0 0; font: 24px/1.4 "Instrument Sans", sans-serif; color: rgb(238 244 241 / 0.6); }
  .bars { display: grid; gap: 12px; }
  .row { display: grid; grid-template-columns: 180px 1fr 124px; gap: 14px; align-items: center; font: 500 22px "Instrument Sans", sans-serif; color: rgb(238 244 241 / 0.65); }
  .row .name { text-align: right; }
  .row .track i { display: block; height: 38px; border-radius: 6px; background: rgb(238 244 241 / 0.22); }
  .row .value { white-space: nowrap; font: 500 22px "Geist Mono", monospace; color: ${INK}; }
  .row.ours { color: ${JADE}; font-weight: 700; }
  .row.ours .track i { background: ${JADE}; box-shadow: 0 0 30px rgb(31 216 164 / 0.6); }
  .row.ours .value { color: ${JADE}; font-weight: 600; }
  </style>
  ${TOP}
  <div class="wrap">
    <div>
      <div class="big">${options.big}</div>
      <h2>${options.title}</h2>
      <p>${options.note}</p>
    </div>
    <div class="bars">${bars}</div>
  </div>`
}

/** Memory with 30 tabs open (the median of three runs), against the next lightest. */
function memoryPage(): string {
  const rows = [OURS, ...OTHERS].map((id) => ({ id, value: runOf(B.memory, id).finalMb }))
  const nextLightest = Math.min(...OTHERS.map((id) => runOf(B.memory, id).finalMb))
  return barsPage({
    rows,
    big: `${(nextLightest / runOf(B.memory, OURS).finalMb).toFixed(1)}×`,
    title: "less memory than any other agent browser",
    note: "30 real websites open as tabs, same 8 GB machine.",
    format: (mb) => `${(mb / 1000).toFixed(2)} GB`,
  })
}

/** CPU with 30 tabs open and nothing happening, as % of one core. */
function cpuPage(): string {
  const rows = [OURS, ...OTHERS].map((id) => ({ id, value: settledCpu(id) }))
  return barsPage({
    rows,
    big: `${Math.round(settledCpu(OURS))}%`,
    title: "CPU while the agent thinks",
    note: `30 tabs open, nothing happening. Headless Chrome: ${Math.round(settledCpu("chrome-shell"))}%.`,
    format: (cpu) => `${Math.round(cpu)}%`,
  })
}

const images = [
  { file: "1-race.png", html: racePage() },
  { file: "2-memory.png", html: memoryPage() },
  { file: "3-cpu.png", html: cpuPage() },
]

mkdirSync(new URL("launch/", import.meta.url), { recursive: true })
const browser = await chromium.launch({ channel: "chromium" })
const context = await browser.newContext({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 2 })
const tab = await context.newPage()
for (const image of images) {
  await tab.setContent(image.html, { waitUntil: "networkidle" })
  // The fonts load after the page; draw only once they're in.
  await tab.evaluate(() => document.fonts.ready)
  await tab.waitForTimeout(800)
  await tab.screenshot({ path: new URL(`launch/${image.file}`, import.meta.url).pathname })
  console.log(`wrote media/launch/${image.file}`)
}
await browser.close()
