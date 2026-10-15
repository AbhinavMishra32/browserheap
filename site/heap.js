// The end of the page: a heap of tabs, the way an agent leaves them after a
// long research run. Every tab sleeps as dots. The one under the pointer wakes,
// and only the two used last stay awake, the same rule Browserheap follows.
// Nobody pointing? A tab wakes now and then on its own.

const HEAP_TITLES = [
  "Headless browser", "Hacker News", "playwright/README.md", "Puppeteer docs", "Selenium",
  "Lightpanda", "browser-use", "Chrome Headless mode", "Page Visibility API", "WebArena paper",
  "Stack Overflow: memory leak", "Chromium flags", "CDP: Target domain", "Issue #885", "Issue #5484",
  "BBC News", "The Verge", "Ars Technica", "MDN: fetch()", "Node.js streams", "npm: playwright-core",
  "Wikipedia: Web crawler", "arXiv: WebVoyager", "Reddit: r/LocalLLaMA", "GitHub trending",
  "Release notes 1.63", "Tab discarding", "Memory pressure", "PSS vs RSS", "E2B docs",
  "Accessibility tree", "ARIA roles", "Cookie jar", "localStorage", "Service workers",
  "Back/forward cache", "Shadow DOM", "iframes", "Lazy loading", "requestIdleCallback",
  "Web vitals", "Lighthouse", "HTTP/3", "WebSockets", "Server-sent events", "CORS",
  "OAuth 2.0", "robots.txt", "Sitemaps", "Readability.js", "Markdown to HTML", "PDF.js",
  "Pricing", "Changelog", "Status page", "Benchmarks", "FAQ", "Blog", "Docs home", "Search",
]

const heap = document.getElementById("heap")
const heapCount = document.getElementById("heap-count")
const heapStill = window.matchMedia("(prefers-reduced-motion: reduce)").matches
let awake = []

function buildHeap() {
  heap.textContent = ""
  // Enough tabs to overfill the heap; the ones that don't fit are clipped.
  for (let i = 0; i < 240; i++) {
    const tab = document.createElement("span")
    tab.className = "heap-tab"
    tab.textContent = HEAP_TITLES[i % HEAP_TITLES.length]
    tab.addEventListener("pointerenter", () => wake(tab))
    heap.append(tab)
  }
  // Colour each tab's dots jade to cyan by where it sits, like the rest of the site.
  const tabs = [...heap.children]
  const width = heap.clientWidth
  for (const tab of tabs) {
    tab.style.setProperty("--x", (tab.offsetLeft / width).toFixed(3))
  }
  const shown = shownTabs()
  awake = []
  wake(shown[3])
  wake(shown[shown.length - 5])
  countHeap(shown.length)
}

/** The tabs that fit in the heap; the rest are clipped off its edges. */
function shownTabs() {
  return [...heap.children].filter((tab) => tab.offsetTop >= 0 && tab.offsetTop + tab.offsetHeight <= heap.clientHeight)
}

/** Wakes a tab; the tab used longest ago goes back to sleep, so two stay awake. */
function wake(tab) {
  if (awake.includes(tab)) {
    return
  }
  tab.classList.add("awake")
  awake.push(tab)
  if (awake.length > 2) {
    awake.shift().classList.remove("awake")
  }
}

function countHeap(open) {
  const ours = BASE_MB + 2 * LIVE_MB + (open - 2) * ASLEEP_MB
  const chrome = BASE_MB + open * CHROME_TAB_MB
  heapCount.innerHTML = `<b>${open} tabs open</b> · 2 awake · ${formatMb(ours)} <span>Plain Chrome: ${formatMb(chrome)}</span>`
}

buildHeap()
let heapWidth = heap.clientWidth
addEventListener("resize", () => {
  if (heap.clientWidth !== heapWidth) {
    heapWidth = heap.clientWidth
    buildHeap()
  }
})

if (!heapStill) {
  setInterval(() => {
    if (heap.matches(":hover")) {
      return
    }
    const shown = shownTabs()
    wake(shown[Math.floor(Math.random() * shown.length)])
  }, 1400)
}
