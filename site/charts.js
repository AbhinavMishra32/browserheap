// The benchmark numbers (data.js) as charts and tables, shared by both pages.
// Every function draws into an element the page already has.

const NS = "http://www.w3.org/2000/svg"

// The memory run's browsers: ours, the agent tools, then the engines (dashed).
const TOOLS = [
  { id: "browserheap --live 2", name: "Browserheap", ours: true },
  { id: "agent-browser", name: "agent-browser" },
  { id: "chrome-shell", name: "Headless Chrome" },
  // Not a tool people use: headless Chrome with Browserheap's blocking, to show how much is blocking alone.
  { id: "chrome-shell --block", name: "Chrome + blocking", baseline: true },
  { id: "stagehand", name: "Stagehand" },
  { id: "browser-use", name: "browser-use" },
  { id: "playwright-mcp", name: "Playwright MCP" },
  { id: "lightpanda", name: "Lightpanda", engine: true },
  { id: "obscura", name: "Obscura", engine: true },
]

/** The browsers Browserheap is compared with: every tool and engine, not the blocking baseline. */
const RIVALS = TOOLS.filter((tool) => !tool.ours && !tool.baseline)

// The action and site tests' browsers.
const ENGINES = [
  { id: "browserheap", name: "Browserheap", ours: true },
  { id: "chrome", name: "Chrome" },
  { id: "lightpanda", name: "Lightpanda" },
  { id: "obscura", name: "Obscura" },
]

/** The median wake: every one of 30 sleeping tabs woken in turn, in the median of the runs. */
function wakeMedianMs() {
  const wakes = (window.BENCH.wakeAll ?? []).map((wake) => wake.wakeMs).sort((a, b) => a - b)
  if (wakes.length === 0) {
    return memoryRun("browserheap --live 2").wake.ms
  }
  return wakes[Math.floor((wakes.length - 1) / 2)]
}

function memoryRun(id) {
  return window.BENCH.memory.find((run) => run.browser === id)
}

function actionRun(id) {
  return window.BENCH.actions.find((run) => run.browser === id)
}

function buSetup(id) {
  return window.BENCH.bu.setups.find((setup) => setup.setup === id)
}

/** Memory the way you'd say it: "411 MB", "4.2 GB". */
function formatMb(mb) {
  if (mb < 1000) {
    return `${Math.round(mb)} MB`
  }
  return `${(mb / 1000).toFixed(1)} GB`
}

function siteName(url) {
  return new URL(url).hostname.replace(/^www\./, "").replace(/^edition\./, "")
}

/** How much memory each extra tab adds: the slope of a straight line through the run. */
function mbPerTab(run) {
  const values = run.perTab.map((tab) => tab.mb)
  const n = values.length
  let meanX = 0
  let meanY = 0
  for (let i = 0; i < n; i++) {
    meanX += (i + 1) / n
    meanY += values[i] / n
  }
  let top = 0
  let bottom = 0
  for (let i = 0; i < n; i++) {
    top += (i + 1 - meanX) * (values[i] - meanY)
    bottom += (i + 1 - meanX) ** 2
  }
  return top / bottom
}

/** The other browsers' memory at 30 tabs, as "3.6–6.9 GB". */
function othersRange() {
  const finals = RIVALS.map((tool) => memoryRun(tool.id).finalMb)
  const gb = (mb) => (mb / 1000).toFixed(1)
  return `${gb(Math.min(...finals))}\u2013${gb(Math.max(...finals))} GB`
}

function siteSummary(id) {
  const results = window.BENCH.sites[id]
  let loaded = 0
  let same = 0
  let compared = 0
  const times = []
  for (const site of results) {
    if (site.loaded) {
      loaded++
      if (site.loadMs !== null) {
        times.push(site.loadMs)
      }
    }
    if (site.sameAsChrome !== null) {
      compared++
      if (site.sameAsChrome >= 0.6) {
        same++
      }
    }
  }
  times.sort((a, b) => a - b)
  return {
    loaded,
    total: results.length,
    same,
    compared,
    median: times[Math.floor(times.length / 2)],
    slowest: times[Math.floor(times.length * 0.9)],
  }
}

function add(svg, tag, attrs) {
  const el = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value)
  }
  svg.append(el)
  return el
}

/**
 * Memory from 1 to 30 tabs, one line per browser, with a hover crosshair.
 * Draw it at about the width it's shown at, so its text stays its real size.
 */
function drawMemoryChart(svg, tooltip, width = 900, height = 440) {
  const ours = memoryRun("browserheap --live 2")
  const tabCount = ours.perTab.length
  const W = width
  const H = height
  const pad = { left: 52, right: 160, top: 12, bottom: 36 }
  const maxMb = 7000
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const x = (tab) => pad.left + ((tab - 1) / (tabCount - 1)) * plotW
  const y = (mb) => pad.top + plotH - (mb / maxMb) * plotH

  for (let mb = 0; mb <= maxMb; mb += 1000) {
    add(svg, "line", { x1: pad.left, x2: pad.left + plotW, y1: y(mb), y2: y(mb), stroke: mb === 0 ? "var(--ink-3)" : "var(--grid)", "stroke-width": 1 })
    const label = add(svg, "text", { x: pad.left - 8, y: y(mb) + 4, "text-anchor": "end" })
    label.textContent = mb === 0 ? "0" : `${mb / 1000} GB`
  }
  for (const tab of [1, 5, 10, 15, 20, 25, 30]) {
    const label = add(svg, "text", { x: x(tab), y: H - pad.bottom + 18, "text-anchor": "middle" })
    label.textContent = tab
  }
  const xTitle = add(svg, "text", { x: pad.left + plotW / 2, y: H - 2, "text-anchor": "middle" })
  xTitle.textContent = "tabs open"

  // The others first, so ours is drawn on top.
  const drawOrder = [...TOOLS.filter((tool) => !tool.ours), ...TOOLS.filter((tool) => tool.ours)]
  for (const tool of drawOrder) {
    const values = memoryRun(tool.id).perTab.map((tab) => tab.mb)
    let d = ""
    values.forEach((mb, i) => {
      d += `${i === 0 ? "M" : "L"}${x(i + 1).toFixed(1)},${y(mb).toFixed(1)}`
    })
    const color = tool.ours ? "var(--live)" : "var(--other)"
    const line = { d, fill: "none", stroke: color, "stroke-width": tool.ours ? 3 : 1.75, "stroke-linejoin": "round", "stroke-linecap": "round" }
    if (tool.engine) {
      line["stroke-dasharray"] = "6 4"
    }
    add(svg, "path", line)
    add(svg, "circle", { cx: x(tabCount), cy: y(values[tabCount - 1]), r: tool.ours ? 4.5 : 3, fill: color, stroke: "var(--surface)", "stroke-width": 2 })
  }

  // End labels, nudged apart so none overlap.
  const ends = TOOLS.map((tool) => ({ tool, mb: memoryRun(tool.id).perTab[tabCount - 1].mb }))
  ends.sort((a, b) => b.mb - a.mb)
  let lastY = -Infinity
  for (const end of ends) {
    end.labelY = Math.max(y(end.mb) + 4, lastY + 15)
    lastY = end.labelY
  }
  for (const end of ends) {
    const label = add(svg, "text", { x: x(tabCount) + 10, y: end.labelY, class: end.tool.ours ? "end ours" : "end" })
    label.textContent = `${end.tool.name} ${formatMb(end.mb)}`
  }

  // Hover: a crosshair and every browser's number at that tab.
  const crosshair = add(svg, "line", { y1: pad.top, y2: pad.top + plotH, stroke: "var(--ink-3)", "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" })
  const hoverDot = add(svg, "circle", { r: 5, fill: "var(--live)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" })
  const hitArea = add(svg, "rect", { x: pad.left - 10, y: pad.top, width: plotW + 20, height: plotH, fill: "transparent" })

  function showTab(tab) {
    crosshair.setAttribute("x1", x(tab))
    crosshair.setAttribute("x2", x(tab))
    crosshair.setAttribute("visibility", "visible")
    hoverDot.setAttribute("cx", x(tab))
    hoverDot.setAttribute("cy", y(ours.perTab[tab - 1].mb))
    hoverDot.setAttribute("visibility", "visible")
    const rows = TOOLS.map((tool) => ({ tool, entry: memoryRun(tool.id).perTab[tab - 1] }))
    rows.sort((a, b) => b.entry.mb - a.entry.mb)
    let html = `<div class="t-head">${tab} tab${tab === 1 ? "" : "s"} open<span class="t-site">+ ${siteName(ours.perTab[tab - 1].url)}</span></div>`
    for (const row of rows) {
      html += `<div class="t-row${row.tool.ours ? " ours" : ""}"><span class="dot"></span><span>${row.tool.name}</span><span class="v">${formatMb(row.entry.mb)}${row.entry.worked ? "" : " \u2020"}</span></div>`
    }
    tooltip.innerHTML = html
    tooltip.hidden = false
    const box = svg.getBoundingClientRect()
    const scale = box.width / W
    const px = x(tab) * scale
    const left = px > box.width / 2 ? px - tooltip.offsetWidth - 14 : px + 14
    tooltip.style.left = `${Math.max(0, left)}px`
    tooltip.style.top = `${pad.top * scale}px`
  }

  function hide() {
    crosshair.setAttribute("visibility", "hidden")
    hoverDot.setAttribute("visibility", "hidden")
    tooltip.hidden = true
  }

  hitArea.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect()
    const svgX = ((event.clientX - box.left) / box.width) * W
    const tab = Math.round(((svgX - pad.left) / plotW) * (tabCount - 1)) + 1
    showTab(Math.min(tabCount, Math.max(1, tab)))
  })
  hitArea.addEventListener("pointerleave", hide)
}

/** One horizontal bar per browser: memory at 30 tabs, or MB per extra tab. */
function drawBars(svg, measure, format, width = 900) {
  const rows = TOOLS.map((tool) => ({ name: tool.name, ours: tool.ours, value: measure(memoryRun(tool.id)) }))
  rows.sort((a, b) => a.value - b.value)
  drawValueBars(svg, rows, format, width)
}

/** Horizontal bars in the order given: rows are [{ name, ours?, value }]. */
function drawValueBars(svg, rows, format, width = 900) {
  // A narrower width draws bigger text when the chart sits in half a row.
  const W = width
  const rowH = 34
  const pad = { left: 130, right: 80, top: 4 }
  const H = pad.top + rows.length * rowH
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
  const max = Math.max(...rows.map((row) => row.value))
  const plotW = W - pad.left - pad.right
  rows.forEach((row, i) => {
    const top = pad.top + i * rowH
    const width = Math.max(4, (row.value / max) * plotW)
    const label = add(svg, "text", { x: pad.left - 12, y: top + 21, "text-anchor": "end", class: row.ours ? "bar-label ours" : "bar-label" })
    label.textContent = row.name
    add(svg, "rect", { x: pad.left, y: top + 7, width, height: 20, rx: 4, fill: row.ours ? "var(--live)" : "var(--other)" })
    const value = add(svg, "text", { x: pad.left + width + 8, y: top + 21, class: row.ours ? "bar-value ours" : "bar-value" })
    value.textContent = format(row.value)
  })
}


function mark(ok) {
  if (ok) {
    return '<span class="mark yes">✓ Works</span>'
  }
  return '<span class="mark no">✕ Fails</span>'
}

function cellClass(engine, extra = "") {
  return [extra, engine.ours ? "ours" : ""].join(" ").trim()
}

function fillActionsTable(table) {
  let html = '<thead><tr><th class="left">What the agent does</th>'
  for (const engine of ENGINES) {
    html += `<th class="${cellClass(engine, "center")}">${engine.name}</th>`
  }
  html += "</tr></thead><tbody>"
  actionRun("chrome").results.forEach((test, i) => {
    html += `<tr><td class="text left">${test.label}</td>`
    for (const engine of ENGINES) {
      html += `<td class="${cellClass(engine, "center")}">${mark(actionRun(engine.id).results[i].passed)}</td>`
    }
    html += "</tr>"
  })
  html += '<tr class="totals"><td class="text left">Actions that work</td>'
  for (const engine of ENGINES) {
    const run = actionRun(engine.id)
    html += `<td class="${cellClass(engine, "center")}">${run.passed} of ${run.of}</td>`
  }
  table.innerHTML = `${html}</tr></tbody>`
}

function fillSitesTable(table) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
  let html = '<thead><tr><th class="left">Browser</th><th>Pages that loaded</th><th>Same content as Chrome</th><th>Typical load</th><th>Slowest 10%</th></tr></thead><tbody>'
  for (const engine of ENGINES) {
    const s = siteSummary(engine.id)
    const cls = engine.ours ? "ours" : ""
    html += `<tr><td class="text left ${cls}">${engine.name}</td><td class="${cls}">${s.loaded} of ${s.total}</td><td class="${cls}">${s.same} of ${s.compared}</td><td class="${cls}">${seconds(s.median)}</td><td class="${cls}">${seconds(s.slowest)}</td></tr>`
  }
  table.innerHTML = `${html}</tbody>`
}

function fillBuTable(table) {
  const rows = [
    { id: "chrome", name: "Headless Chrome, every tab live" },
    { id: "browserheap", name: "Browserheap, 2 tabs live", ours: true },
  ]
  let html = '<thead><tr><th class="left">Browser</th><th>Tasks solved</th><th>Peak memory</th><th>Average memory</th><th>Page text read</th><th>Time for all 10</th></tr></thead><tbody>'
  for (const row of rows) {
    const s = buSetup(row.id)
    const cls = row.ours ? "ours" : ""
    html += `<tr><td class="text left ${cls}">${row.name}</td><td class="${cls}">${s.passed} of ${s.total}</td><td class="${cls}">${formatMb(s.peakMb)}</td><td class="${cls}">${formatMb(s.averageMb)}</td><td class="${cls}">${Math.round(s.readChars / 1000)}k characters</td><td class="${cls}">${s.minutes} min</td></tr>`
  }
  table.innerHTML = `${html}</tbody>`
}

function fillMemoryTable(table) {
  const ours = memoryRun("browserheap --live 2")
  let html = '<thead><tr><th>Tabs</th><th class="left">Site added</th>'
  for (const tool of TOOLS) {
    html += `<th class="${tool.ours ? "ours" : ""}">${tool.name}</th>`
  }
  html += "</tr></thead><tbody>"
  ours.perTab.forEach((tab, i) => {
    html += `<tr><td>${i + 1}</td><td class="text left">${siteName(tab.url)}</td>`
    for (const tool of TOOLS) {
      const entry = memoryRun(tool.id).perTab[i]
      const classes = [tool.ours ? "ours" : "", entry.worked ? "" : "blocked"].join(" ").trim()
      html += `<td class="${classes}">${formatMb(entry.mb)}</td>`
    }
    html += "</tr>"
  })
  const summaries = [
    { label: "After a 5 s settle", value: (run) => formatMb(run.finalMb) },
    { label: "Peak", value: (run) => formatMb(Math.max(...run.perTab.map((tab) => tab.mb))) },
    { label: "Each extra tab", value: (run) => `${mbPerTab(run).toFixed(0)} MB` },
    { label: "Pages that loaded", value: (run) => `${run.perTab.filter((tab) => tab.worked).length}/30` },
  ]
  for (const summary of summaries) {
    html += `<tr class="totals"><td></td><td class="text left">${summary.label}</td>`
    for (const tool of TOOLS) {
      html += `<td class="${tool.ours ? "ours" : ""}">${summary.value(memoryRun(tool.id))}</td>`
    }
    html += "</tr>"
  }
  table.innerHTML = `${html}</tbody>`
}

/** Copy buttons: data-copy holds the text. */
function wireCopyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const original = button.textContent
      try {
        await navigator.clipboard.writeText(button.dataset.copy)
        button.textContent = "Copied"
      } catch {
        button.textContent = "Select and copy"
      }
      setTimeout(() => {
        button.textContent = original
      }, 1800)
    })
  }
}

/**
 * A line chart for any measure over time or tabs, ours in the accent color, the rest grey.
 *
 *   series   [{ name, ours?, dashed?, stopped?, points: [{ x, y }] }]
 *   options  { xMax, xTicks, xLabel, yMax, yStep, yFormat, xTitle(x), valueFormat(y), limit?: { y, label } }
 *
 * Hovering shows every series' value at the nearest x it has. A series that
 * stopped early (a crash, the memory limit) ends with an ×.
 */
function drawLineChart(svg, tooltip, series, options) {
  const W = options.width ?? 900
  const H = options.height ?? 400
  const pad = { left: 56, right: options.labelRoom ?? 170, top: 12, bottom: 38 }
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const xMin = options.xMin ?? 0
  const x = (value) => pad.left + ((value - xMin) / (options.xMax - xMin)) * plotW
  const y = (value) => pad.top + plotH - (Math.min(value, options.yMax) / options.yMax) * plotH

  for (let value = 0; value <= options.yMax; value += options.yStep) {
    add(svg, "line", { x1: pad.left, x2: pad.left + plotW, y1: y(value), y2: y(value), stroke: value === 0 ? "var(--ink-3)" : "var(--grid)", "stroke-width": 1 })
    const label = add(svg, "text", { x: pad.left - 8, y: y(value) + 4, "text-anchor": "end" })
    label.textContent = options.yFormat(value)
  }
  for (const tick of options.xTicks) {
    const label = add(svg, "text", { x: x(tick), y: H - pad.bottom + 18, "text-anchor": "middle" })
    label.textContent = options.xTickFormat === undefined ? tick : options.xTickFormat(tick)
  }
  const xLabel = add(svg, "text", { x: pad.left + plotW / 2, y: H - 2, "text-anchor": "middle" })
  xLabel.textContent = options.xLabel

  if (options.limit !== undefined) {
    add(svg, "line", { x1: pad.left, x2: pad.left + plotW, y1: y(options.limit.y), y2: y(options.limit.y), stroke: "var(--bad)", "stroke-width": 1, "stroke-dasharray": "4 4" })
    const label = add(svg, "text", { x: pad.left + 6, y: y(options.limit.y) - 6 })
    label.textContent = options.limit.label
  }

  const drawOrder = [...series.filter((one) => !one.ours), ...series.filter((one) => one.ours)]
  for (const one of drawOrder) {
    if (one.points.length === 0) {
      continue
    }
    const color = one.ours ? "var(--live)" : "var(--other)"
    let d = ""
    one.points.forEach((point, i) => {
      d += `${i === 0 ? "M" : "L"}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`
    })
    const line = { d, fill: "none", stroke: color, "stroke-width": one.ours ? 3 : 1.75, "stroke-linejoin": "round", "stroke-linecap": "round" }
    if (one.dashed) {
      line["stroke-dasharray"] = "6 4"
    }
    add(svg, "path", line)
    const last = one.points[one.points.length - 1]
    if (one.stopped) {
      const cross = add(svg, "text", { x: x(last.x), y: y(last.y) + 5, "text-anchor": "middle", class: one.ours ? "end ours" : "end", style: "font-size: 15px; font-weight: 700" })
      cross.textContent = "×"
    } else {
      add(svg, "circle", { cx: x(last.x), cy: y(last.y), r: one.ours ? 4.5 : 3, fill: color, stroke: "var(--surface)", "stroke-width": 2 })
    }
  }

  // End labels on the right, nudged apart so none overlap.
  const ends = series
    .filter((one) => one.points.length > 0)
    .map((one) => ({ one, value: one.points[one.points.length - 1].y }))
  ends.sort((a, b) => b.value - a.value)
  let lastY = -Infinity
  for (const end of ends) {
    end.labelY = Math.max(y(end.value) + 4, lastY + 15)
    lastY = end.labelY
  }
  for (const end of ends) {
    const label = add(svg, "text", { x: pad.left + plotW + 12, y: end.labelY, class: end.one.ours ? "end ours" : "end" })
    // The × already marks a stop at the limit; only a crash needs saying.
    label.textContent = `${end.one.name} ${options.valueFormat(end.value)}${end.one.stopped === "crashed" ? " (crashed)" : ""}`
  }

  if (tooltip === null) {
    return
  }
  const allX = [...new Set(series.flatMap((one) => one.points.map((point) => point.x)))].sort((a, b) => a - b)
  const crosshair = add(svg, "line", { y1: pad.top, y2: pad.top + plotH, stroke: "var(--ink-3)", "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" })
  const hitArea = add(svg, "rect", { x: pad.left - 10, y: pad.top, width: plotW + 20, height: plotH, fill: "transparent" })

  function nearestX(svgX) {
    const wanted = xMin + ((svgX - pad.left) / plotW) * (options.xMax - xMin)
    let best = allX[0]
    for (const value of allX) {
      if (Math.abs(value - wanted) < Math.abs(best - wanted)) {
        best = value
      }
    }
    return best
  }

  hitArea.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect()
    const at = nearestX(((event.clientX - box.left) / box.width) * W)
    crosshair.setAttribute("x1", x(at))
    crosshair.setAttribute("x2", x(at))
    crosshair.setAttribute("visibility", "visible")
    const rows = []
    for (const one of series) {
      const point = one.points.find((candidate) => candidate.x === at)
      if (point !== undefined) {
        rows.push({ one, value: point.y })
      }
    }
    rows.sort((a, b) => b.value - a.value)
    let html = `<div class="t-head">${options.xTitle(at)}</div>`
    for (const row of rows) {
      html += `<div class="t-row${row.one.ours ? " ours" : ""}"><span class="dot"></span><span>${row.one.name}</span><span class="v">${options.valueFormat(row.value)}</span></div>`
    }
    tooltip.innerHTML = html
    tooltip.hidden = false
    const scale = box.width / W
    const px = x(at) * scale
    const left = px > box.width / 2 ? px - tooltip.offsetWidth - 14 : px + 14
    tooltip.style.left = `${Math.max(0, left)}px`
    tooltip.style.top = `${pad.top * scale}px`
  })
  hitArea.addEventListener("pointerleave", () => {
    crosshair.setAttribute("visibility", "hidden")
    tooltip.hidden = true
  })
}

/**
 * One row of dots per browser on a log time scale, with a tick at the median:
 * how load or wake times spread, not just their average.
 *
 *   rows  [{ name, ours?, values: [{ ms, label }] }]
 */
function drawDotStrips(svg, rows, ticksMs) {
  const W = 900
  const rowH = 46
  const pad = { left: 150, right: 30, top: 6, bottom: 30 }
  const H = pad.top + rows.length * rowH + pad.bottom
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
  const plotW = W - pad.left - pad.right
  const minMs = ticksMs[0]
  const maxMs = ticksMs[ticksMs.length - 1]
  const x = (ms) => {
    const clamped = Math.min(Math.max(ms, minMs), maxMs)
    return pad.left + (Math.log(clamped / minMs) / Math.log(maxMs / minMs)) * plotW
  }
  const bottom = pad.top + rows.length * rowH
  for (const tick of ticksMs) {
    add(svg, "line", { x1: x(tick), x2: x(tick), y1: pad.top, y2: bottom, stroke: "var(--grid)", "stroke-width": 1 })
    const label = add(svg, "text", { x: x(tick), y: bottom + 18, "text-anchor": "middle" })
    label.textContent = tick < 1000 ? `${tick} ms` : `${tick / 1000} s`
  }
  rows.forEach((row, i) => {
    const middle = pad.top + i * rowH + rowH / 2
    const label = add(svg, "text", { x: pad.left - 14, y: middle + 4, "text-anchor": "end", class: row.ours ? "bar-label ours" : "bar-label" })
    label.textContent = row.name
    const color = row.ours ? "var(--live)" : "var(--other)"
    row.values.forEach((value, j) => {
      // A small fixed spread up and down so dots at the same time don't hide each other.
      const jitter = ((j * 7) % 11) - 5
      const dot = add(svg, "circle", { cx: x(value.ms), cy: middle + jitter * 1.6, r: 3.5, fill: color, "fill-opacity": 0.75 })
      const title = document.createElementNS(NS, "title")
      title.textContent = `${value.label}: ${(value.ms / 1000).toFixed(2)} s`
      dot.append(title)
    })
    const sorted = row.values.map((value) => value.ms).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median !== undefined) {
      add(svg, "line", { x1: x(median), x2: x(median), y1: middle - 15, y2: middle + 15, stroke: "var(--ink)", "stroke-width": 2.5, "stroke-linecap": "round" })
      const value = add(svg, "text", { x: x(median), y: middle - 19, "text-anchor": "middle", class: row.ours ? "bar-value ours" : "bar-value" })
      value.textContent = median < 1000 ? `${median} ms` : `${(median / 1000).toFixed(1)} s`
    }
  })
}

/**
 * Each task as a pair: how long Chrome took and how long Browserheap took.
 * A filled dot is a solved task, a ring an unsolved one.
 *
 *   rows  [{ label, chrome: { seconds, solved }, ours: { seconds, solved } }]
 */
function drawPairs(svg, rows, maxSeconds) {
  const W = 900
  const rowH = 30
  const pad = { left: 150, right: 40, top: 6, bottom: 30 }
  const H = pad.top + rows.length * rowH + pad.bottom
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
  const plotW = W - pad.left - pad.right
  const x = (seconds) => pad.left + (seconds / maxSeconds) * plotW
  const bottom = pad.top + rows.length * rowH
  for (let seconds = 0; seconds <= maxSeconds; seconds += 60) {
    add(svg, "line", { x1: x(seconds), x2: x(seconds), y1: pad.top, y2: bottom, stroke: "var(--grid)", "stroke-width": 1 })
    const label = add(svg, "text", { x: x(seconds), y: bottom + 18, "text-anchor": "middle" })
    label.textContent = `${seconds / 60} min`
  }
  rows.forEach((row, i) => {
    const middle = pad.top + i * rowH + rowH / 2
    const label = add(svg, "text", { x: pad.left - 14, y: middle + 4, "text-anchor": "end", class: "bar-label" })
    label.textContent = row.label
    add(svg, "line", { x1: x(row.chrome.seconds), x2: x(row.ours.seconds), y1: middle, y2: middle, stroke: "var(--rule)", "stroke-width": 3 })
    for (const [run, color] of [[row.chrome, "var(--other)"], [row.ours, "var(--live)"]]) {
      add(svg, "circle", {
        cx: x(run.seconds),
        cy: middle,
        r: 6,
        fill: run.solved ? color : "var(--surface)",
        stroke: color,
        "stroke-width": 2.5,
      })
    }
  })
}

/** Real sites by kind: how many loaded in each browser, shaded by the share. */
function fillKindGrid(table) {
  const kinds = []
  for (const site of window.BENCH.sites.chrome) {
    if (!kinds.includes(site.kind)) {
      kinds.push(site.kind)
    }
  }
  let html = '<thead><tr><th class="left">Browser</th>'
  for (const kind of kinds) {
    html += `<th class="center">${kind}</th>`
  }
  html += "</tr></thead><tbody>"
  for (const engine of ENGINES) {
    html += `<tr><td class="text left${engine.ours ? " ours" : ""}">${engine.name}</td>`
    for (const kind of kinds) {
      const sites = window.BENCH.sites[engine.id].filter((site) => site.kind === kind)
      const loaded = sites.filter((site) => site.loaded).length
      const share = Math.round((loaded / sites.length) * 100)
      html += `<td class="center" style="background: color-mix(in srgb, var(--good) ${Math.round(share * 0.35)}%, transparent)">${loaded} of ${sites.length}</td>`
    }
    html += "</tr>"
  }
  table.innerHTML = `${html}</tbody>`
}

/** A browser's display name and whether it's ours, from its id in the results. */
function toolOf(id) {
  return TOOLS.find((tool) => tool.id === id) ?? { id, name: id }
}

/** The smallest "nice" axis top above a value: 100, 200, 500, 1000, … */
function niceMax(value) {
  for (const step of [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000]) {
    if (value <= step * 5) {
      return { max: Math.ceil(value / step) * step, step }
    }
  }
  return { max: Math.ceil(value / 10000) * 10000, step: 10000 }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
