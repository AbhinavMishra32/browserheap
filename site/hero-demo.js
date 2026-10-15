// The hero demo: an agent researching in Browserheap, shown as its browser's
// tab overview, with what it's doing now above and a memory meter below. Every tab is a real page
// (demo.js, captured by capture-demo.ts): its screenshot, favicon, title and
// text. The 2 tabs the agent used last are live; the rest sleep, and a
// sleeping tab's screenshot turns to dots. Hover a tab to see what the agent
// can still read from it; click a sleeping one to wake it.

const STEP_MS = 1500
const MAX_LIVE = 2

// Memory per tab, from the 30-tab benchmark: a browser with no tabs, a live
// page, a sleeping tab, and what one more tab costs in plain headless Chrome.
const BASE_MB = 114
const LIVE_MB = 150
const ASLEEP_MB = 3
const CHROME_TAB_MB = 127

const PAGES = {}
for (const page of window.DEMO_PAGES) {
  PAGES[page.key] = page
}

/** A short name for each page, as you'd say it. */
const NAME = {
  wiki: "Wikipedia",
  playwright: "Playwright",
  puppeteer: "Puppeteer",
  selenium: "Selenium",
  lightpanda: "Lightpanda",
  hn: "Hacker News",
  browseruse: "Browser Use",
  chrome: "Chrome docs",
}

/** The research task, one step at a time. */
const STEPS = [
  { open: "wiki" },
  { open: "playwright" },
  { open: "puppeteer" },
  { open: "selenium" },
  { open: "lightpanda" },
  { open: "browseruse" },
  { open: "hn" },
  { open: "chrome" },
  { read: "playwright" },
  { wake: "wiki" },
  { done: "Playwright on Chromium suits most agents. Puppeteer if you only need Chrome." },
]

const els = {
  app: document.getElementById("app"),
  grid: document.getElementById("tab-grid"),
  now: document.getElementById("now"),
  memOurs: document.getElementById("mem-ours"),
  memChrome: document.getElementById("mem-chrome"),
  fillOurs: document.getElementById("fill-ours"),
  fillChrome: document.getElementById("fill-chrome"),
  replay: document.getElementById("demo-replay"),
  hovercard: document.getElementById("hovercard"),
}

// The meter's full width: every tab open in plain Chrome.
const METER_MAX_MB = BASE_MB + window.DEMO_PAGES.length * CHROME_TAB_MB

// Each page's screenshot as dots, for when its tab sleeps. Made once at load.
const DOTS = {}
for (const page of window.DEMO_PAGES) {
  ditherImage(page.preview, 240).then((canvas) => {
    DOTS[page.key] = canvas.toDataURL()
    for (const tab of tabs) {
      if (tab.key === page.key && tab.card !== undefined) {
        tab.card.querySelector(".dots").src = DOTS[page.key]
      }
    }
  })
}

// The browser: open tabs in the order opened, and the one the agent is on.
let tabs = []
let current = null
let clock = 0
let stepIndex = 0
let playing = true
let timer = null
let hovered = null

function tabOf(key) {
  return tabs.find((tab) => tab.key === key)
}

function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, "")
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
}

/** The agent used this tab: it becomes the newest, and only the 2 newest stay live. Returns the tabs that fell asleep. */
function use(key) {
  clock++
  tabOf(key).lastUsed = clock
  current = key
  const newestFirst = [...tabs].sort((a, b) => b.lastUsed - a.lastUsed)
  const fellAsleep = []
  newestFirst.forEach((tab, i) => {
    const live = i < MAX_LIVE
    if (!live && tab.state === "live") {
      fellAsleep.push(tab.key)
    }
    tab.state = live ? "live" : "asleep"
  })
  return fellAsleep
}

// ---- Drawing ----

/** A tab's state in a few characters, so its name keeps the room. */
const STATE_TEXT = {
  live: `${LIVE_MB} MB`,
  asleep: `${ASLEEP_MB} MB`,
  waking: "waking",
}

/** A tab in the overview, built once when the tab opens; drawCard() keeps it current. */
function makeCard(tab) {
  const page = PAGES[tab.key]
  const card = document.createElement("button")
  card.type = "button"
  card.innerHTML = `
    <span class="thumb">
      <img class="preview" src="${page.preview}" alt="">
      <img class="dots" src="${DOTS[tab.key] ?? ""}" alt="">
      <span class="note"></span>
    </span>
    <span class="tab-foot">
      <img src="${page.icon}" alt="" width="14" height="14">
      <span class="tab-title">${escapeHtml(NAME[tab.key])}</span>
      <span class="tab-state"></span>
    </span>`
  card.addEventListener("click", () => userClick(tab.key))
  card.addEventListener("mouseenter", () => showHovercard(tab.key))
  card.addEventListener("focus", () => showHovercard(tab.key))
  card.addEventListener("mouseleave", hideHovercard)
  card.addEventListener("blur", hideHovercard)
  return card
}

function drawCard(tab) {
  const card = tab.card
  card.className = `tab-card ${tab.state}${tab.key === current ? " current" : ""}`
  card.setAttribute("aria-label", `${NAME[tab.key]}, ${tab.state}${tab.state === "asleep" ? ". Click to wake." : ""}`)
  const state = card.querySelector(".tab-state")
  state.textContent = STATE_TEXT[tab.state]
  state.title = tab.state === "asleep" ? "Asleep" : tab.state === "live" ? "Live" : "Waking"
  const note = card.querySelector(".note")
  note.hidden = tab.note === null
  note.textContent = tab.note ?? ""
}

function drawGrid() {
  for (const tab of tabs) {
    if (tab.card === undefined) {
      tab.card = makeCard(tab)
      els.grid.append(tab.card)
    }
    drawCard(tab)
  }
}

/** The memory meter: these tabs in Browserheap, and the same tabs in plain Chrome. */
function drawMeter() {
  let asleep = 0
  for (const tab of tabs) {
    if (tab.state === "asleep") {
      asleep++
    }
  }
  const live = tabs.length - asleep
  const ours = tabs.length === 0 ? 0 : BASE_MB + live * LIVE_MB + asleep * ASLEEP_MB
  const chrome = tabs.length === 0 ? 0 : BASE_MB + tabs.length * CHROME_TAB_MB
  els.memOurs.textContent = `${ours.toLocaleString("en-US")} MB`
  els.memChrome.textContent = `${chrome.toLocaleString("en-US")} MB`
  els.fillOurs.style.width = `${(ours / METER_MAX_MB) * 100}%`
  els.fillChrome.style.width = `${(chrome / METER_MAX_MB) * 100}%`
}

function draw() {
  drawGrid()
  drawMeter()
  if (hovered !== null) {
    showHovercard(hovered)
  }
}

/** What the agent is doing now, in one line at the top of the window. */
function say(key, html) {
  const icon = key === null ? "" : `<img src="${PAGES[key].icon}" alt="" width="14" height="14">`
  els.now.innerHTML = `${icon}<span>${html}</span>`
}

function asleepText(keys) {
  if (keys.length === 0) {
    return ""
  }
  return ` <span class="muted">· ${keys.map((key) => NAME[key]).join(", ")} asleep</span>`
}

// ---- Hover card: what the agent can read from a tab, live or asleep ----

function showHovercard(key) {
  hovered = key
  const tab = tabOf(key)
  const page = PAGES[key]
  const card = els.hovercard
  const firstShow = card.hidden || card.dataset.key !== key
  card.dataset.key = key
  card.querySelector(".hc-icon").src = page.icon
  card.querySelector(".hc-title").textContent = page.title
  card.querySelector(".hc-host").textContent = hostOf(page.url)
  const foot = {
    asleep: `<span class="chip plain">Asleep · ${ASLEEP_MB} MB</span><span>The agent still reads this. Click to wake.</span>`,
    waking: '<span class="chip cyan">Waking</span>',
    live: `<span class="chip ok">✓ Live · ${LIVE_MB} MB</span><span>A real Chromium page.</span>`,
  }
  card.querySelector(".hc-foot").innerHTML = foot[tab.state]
  const text = page.text.length > 200 ? `${page.text.slice(0, 200)}…` : page.text
  if (firstShow) {
    // The text decodes in, as if the agent were reading it.
    decode(card.querySelector(".hc-text"), text, 450)
  }
  card.hidden = false

  // Under the tab, or above it when there's no room below.
  const app = els.app.getBoundingClientRect()
  const box = tab.card.getBoundingClientRect()
  const width = card.offsetWidth
  let left = box.left - app.left + box.width / 2 - width / 2
  left = Math.max(8, Math.min(left, app.width - width - 8))
  let top = box.bottom - app.top + 8
  if (top + card.offsetHeight > app.height - 8) {
    top = box.top - app.top - card.offsetHeight - 8
  }
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}

function hideHovercard() {
  hovered = null
  els.hovercard.hidden = true
}

// ---- Steps ----

function runStep(step, instant) {
  if (step.open !== undefined) {
    const key = step.open
    tabs.push({ key, state: "live", lastUsed: 0, note: null })
    const slept = use(key)
    say(key, `Opened <b>${NAME[key]}</b>${asleepText(slept)}`)
  } else if (step.read !== undefined) {
    const key = step.read
    tabOf(key).note = "Read while asleep"
    say(key, `Read <b>${NAME[key]}</b> <span class="muted">· without waking it</span>`)
    setTimeout(() => {
      tabOf(key).note = null
      draw()
    }, instant ? 0 : 1800)
  } else if (step.wake !== undefined) {
    wake(step.wake, instant, "Clicked a link on")
    return
  } else if (step.done !== undefined) {
    say(null, `<b>Done.</b> ${escapeHtml(step.done)}`)
  }
  draw()
}

/** Wakes a sleeping tab: a moment of loading, then it's live and the oldest live tab sleeps. */
function wake(key, instant, verb) {
  const tab = tabOf(key)
  // Most tabs woke in 0.2 to 0.4 s in the benchmark.
  const ms = 220 + Math.round(Math.random() * 160)
  tab.state = "waking"
  current = key
  draw()
  const finish = () => {
    const slept = use(key)
    say(key, `${verb} <b>${NAME[key]}</b> <span class="muted">· woke in ${ms} ms</span>${asleepText(slept)}`)
    draw()
  }
  if (instant) {
    finish()
  } else {
    setTimeout(finish, Math.max(ms, 450))
  }
}

// ---- Playing ----

function scheduleNext() {
  clearTimeout(timer)
  if (!playing || stepIndex >= STEPS.length) {
    return
  }
  timer = setTimeout(() => {
    runStep(STEPS[stepIndex], false)
    stepIndex++
    scheduleNext()
  }, STEP_MS)
}

function restart() {
  clearTimeout(timer)
  tabs = []
  current = null
  clock = 0
  stepIndex = 0
  playing = true
  els.grid.innerHTML = ""
  say(null, '<span class="muted">Task:</span> which headless browser should our agent use?')
  hideHovercard()
  draw()
  scheduleNext()
}

/** You clicked a tab: you're driving now. A sleeping tab wakes; a live one becomes the current page. */
function userClick(key) {
  playing = false
  clearTimeout(timer)
  const tab = tabOf(key)
  if (tab.state === "asleep") {
    wake(key, false, "You woke")
  } else if (tab.state === "live") {
    use(key)
    say(key, `You switched to <b>${NAME[key]}</b> <span class="muted">· already live</span>`)
    draw()
  }
}

els.replay.addEventListener("click", restart)

// Reduced motion: the finished session at once, still clickable.
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  restart()
  playing = false
  clearTimeout(timer)
  for (const step of STEPS) {
    runStep(step, true)
  }
  stepIndex = STEPS.length
} else {
  restart()
}
