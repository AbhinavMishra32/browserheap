// The hero demo: an agent researching in Browserheap, shown as its browser's
// tab overview in a browser window, with a memory meter below and the
// agent's own thread in a window in front. Every tab is a real page
// (demo.js, captured by capture-demo.ts): its screenshot, favicon, title and
// text. The 2 tabs the agent used last are live; the rest sleep, and a
// sleeping tab's screenshot turns to dots. Hover a tab to see what the agent
// can still read from it; click a sleeping one to wake it.

const STEP_MS = 1300
const MAX_LIVE = 2

// Memory from the 30-tab benchmark (median runs): Browserheap with no tabs, a
// typical live page, a sleeping tab; plain headless Chrome with no tabs, and
// what each more tab costs it.
const BASE_MB = 247
const LIVE_MB = 122
const ASLEEP_MB = 3
const CHROME_BASE_MB = 112
const CHROME_TAB_MB = 144

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

/**
 * The research task, one step at a time: what the agent thinks, what it
 * tells you, and what it does in the browser.
 */
const STEPS = [
  { think: "Start broad: which headless browsers exist? Then check each one's own page." },
  { open: "wiki" },
  { message: "Wikipedia lists the main ones. Opening each project to compare." },
  { open: "playwright" },
  { open: "puppeteer" },
  { open: "selenium" },
  { think: "Agents need something light and scriptable. Worth looking at the newer engines too." },
  { open: "lightpanda" },
  { open: "browseruse" },
  { think: "What do people actually run in production? Hacker News, and Chrome's own docs." },
  { open: "hn" },
  { open: "chrome" },
  { think: "Back to Playwright's README to compare. That tab is asleep, but its text is still there." },
  { read: "playwright" },
  { think: "Wikipedia's article links a comparison of engines. Following it." },
  { wake: "wiki" },
  { done: "Playwright on Chromium suits most agents: one API for every browser, and it's what agent tools build on. Puppeteer if you only need Chrome." },
]

const els = {
  app: document.getElementById("app"),
  grid: document.getElementById("tab-grid"),
  count: document.getElementById("demo-count"),
  progress: document.getElementById("demo-progress"),
  thread: document.getElementById("thread"),
  status: document.getElementById("agent-status"),
  spin: document.getElementById("cc-spin"),
  memOurs: document.getElementById("mem-ours"),
  memChrome: document.getElementById("mem-chrome"),
  fillOurs: document.getElementById("fill-ours"),
  fillChrome: document.getElementById("fill-chrome"),
  replay: document.getElementById("demo-replay"),
  hovercard: document.getElementById("hovercard"),
}

// The meter's full width: every tab open in plain Chrome.
const METER_MAX_MB = CHROME_BASE_MB + window.DEMO_PAGES.length * CHROME_TAB_MB

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
      // The tabs scroll inside the demo: bring the new one into view.
      els.grid.scrollTo({ top: tab.card.offsetTop - 14, behavior: "smooth" })
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
  const chrome = tabs.length === 0 ? 0 : CHROME_BASE_MB + tabs.length * CHROME_TAB_MB
  els.memOurs.textContent = `${ours.toLocaleString("en-US")} MB`
  els.memChrome.textContent = `${chrome.toLocaleString("en-US")} MB`
  els.fillOurs.style.width = `${(ours / METER_MAX_MB) * 100}%`
  els.fillChrome.style.width = `${(chrome / METER_MAX_MB) * 100}%`
}

function draw() {
  drawGrid()
  drawMeter()
  drawCount()
  if (hovered !== null) {
    showHovercard(hovered)
  }
}

/** Above the tabs: how many are open, and how many of them are awake. */
function drawCount() {
  if (tabs.length === 0) {
    els.count.textContent = "No tabs yet"
    return
  }
  let awake = 0
  for (const tab of tabs) {
    if (tab.state !== "asleep") {
      awake++
    }
  }
  const noun = tabs.length === 1 ? "tab" : "tabs"
  els.count.innerHTML = `${tabs.length} ${noun} open · <b>${awake} awake</b>`
}

// The agent's thread, drawn the way Claude Code draws itself in a terminal:
// a ⏺ for each thing it says or does, a ⎿ under a command for what came back.

function addToThread(html, className) {
  const line = document.createElement("div")
  line.className = className
  line.innerHTML = html
  els.thread.append(line)
  els.thread.scrollTop = els.thread.scrollHeight
}

/** A browserheap command the agent ran, and what came back under it. */
function say(command, html) {
  if (command !== null) {
    addToThread(`<span class="dot">⏺</span><span><b>Bash</b>(${escapeHtml(command)})</span>`, "line tool")
  }
  addToThread(`<span>  ⎿</span><span>${html}</span>`, "result")
}

/** A thought: dim and italic, the way Claude Code shows its thinking. */
function think(text) {
  addToThread(`<span class="dot">✻</span><span>${escapeHtml(text)}</span>`, "thought")
}

/** Something the agent tells you as it goes. */
function message(text) {
  addToThread(`<span class="dot">⏺</span><span>${escapeHtml(text)}</span>`, "line")
}

/** Your question at the top of the thread, and the agent's answer at the end. */
function ask(text) {
  els.thread.innerHTML = ""
  addToThread(`&gt; ${escapeHtml(text)}`, "prompt")
  els.status.hidden = false
}

function answer(text) {
  message(text)
  els.status.hidden = true
}

/** The command that opens a page, as the agent would type it. */
function openCommand(key) {
  return `browserheap open ${PAGES[key].url.replace(/^https:\/\//, "")}`
}

/** A command that works on a tab already open, by its place in the list. */
function tabCommand(key, code) {
  const index = tabs.indexOf(tabOf(key))
  return `browserheap run 'await tabs[${index}]${code}'`
}

// The spinner beside "Browsing…", the characters Claude Code cycles through.
const SPIN = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
let spinIndex = 0
setInterval(() => {
  spinIndex = (spinIndex + 1) % SPIN.length
  els.spin.textContent = SPIN[spinIndex]
}, 120)

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
  card.querySelector(".hc-icon").src = page.icon
  card.querySelector(".hc-title").textContent = NAME[key]
  const foot = {
    asleep: `<b>Asleep · ${ASLEEP_MB} MB</b> · still readable, click to wake`,
    waking: "<b>Waking…</b>",
    live: `<b class="live">Live · ${LIVE_MB} MB</b>`,
  }
  card.querySelector(".hc-foot").innerHTML = foot[tab.state]
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
  if (step.think !== undefined) {
    think(step.think)
    return
  }
  if (step.message !== undefined) {
    message(step.message)
    return
  }
  if (step.open !== undefined) {
    const key = step.open
    tabs.push({ key, state: "live", lastUsed: 0, note: null })
    const slept = use(key)
    say(openCommand(key), `Opened <b>${NAME[key]}</b>${asleepText(slept)}`)
  } else if (step.read !== undefined) {
    const key = step.read
    tabOf(key).note = "Read while asleep"
    say(tabCommand(key, ".text()"), `Read <b>${NAME[key]}</b> without waking it`)
    setTimeout(() => {
      tabOf(key).note = null
      draw()
    }, instant ? 0 : 1800)
  } else if (step.wake !== undefined) {
    wake(step.wake, instant, "Clicked a link on", tabCommand(step.wake, '.getByText("Comparison").click()'))
    return
  } else if (step.done !== undefined) {
    answer(step.done)
  }
  draw()
}

/** Wakes a sleeping tab: a moment of loading, then it's live and the oldest live tab sleeps. */
function wake(key, instant, verb, command) {
  const tab = tabOf(key)
  // Most tabs woke in 0.4 to 0.9 s in the benchmark.
  const ms = 400 + Math.round(Math.random() * 500)
  tab.state = "waking"
  current = key
  draw()
  const finish = () => {
    const slept = use(key)
    say(command, `${verb} <b>${NAME[key]}</b> <span class="muted">· woke in ${ms} ms</span>${asleepText(slept)}`)
    draw()
  }
  if (instant) {
    finish()
  } else {
    setTimeout(finish, Math.max(ms, 450))
  }
}

// ---- Playing ----

/** The thin line under the demo's head: how far through the session the replay is. */
function drawProgress() {
  els.progress.style.width = `${(stepIndex / STEPS.length) * 100}%`
}

function scheduleNext() {
  clearTimeout(timer)
  if (!playing || stepIndex >= STEPS.length) {
    return
  }
  timer = setTimeout(() => {
    runStep(STEPS[stepIndex], false)
    stepIndex++
    drawProgress()
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
  drawProgress()
  els.grid.innerHTML = ""
  ask("Which headless browser should our agent use?")
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
    wake(key, false, "You woke", null)
  } else if (tab.state === "live") {
    use(key)
    say(null, `You switched to <b>${NAME[key]}</b> <span class="muted">· already live</span>`)
    draw()
  }
}

els.replay.addEventListener("click", restart)

// On phones the agent window is a sheet fixed to the bottom of the screen,
// like an iOS drawer: it rises while the demo is on screen and slides away
// after. Tapping its head folds it down to just the head, and back.
const agent = document.querySelector(".agent")
const phone = window.matchMedia("(max-width: 900px)")

function placeAgentSheet() {
  // It rises once the demo comes on screen. The demo keeps room below it
  // for the sheet (its margin); when that room scrolls up to the bottom of
  // the screen, the sheet settles into it and scrolls away with the page.
  if (!phone.matches) {
    agent.classList.remove("shown", "docked")
    agent.style.bottom = ""
    return
  }
  const box = els.app.getBoundingClientRect()
  const roomBottom = box.bottom + agent.offsetHeight + 16
  const lift = Math.max(0, innerHeight - 8 - roomBottom)
  agent.classList.toggle("shown", box.top < innerHeight - 200)
  agent.classList.toggle("docked", lift > 0)
  agent.style.bottom = lift > 0 ? `${8 + lift}px` : ""
}

agent.querySelector(".agent-head").addEventListener("click", () => {
  agent.classList.toggle("folded")
})
addEventListener("scroll", placeAgentSheet, { passive: true })
addEventListener("resize", placeAgentSheet)
placeAgentSheet()

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
