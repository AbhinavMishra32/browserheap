# agent-tabs

> Working name. The real one is picked before launch.

A browser for AI agents where **a tab costs memory only while the agent is using it.**

**20 real tabs open in an agent's browser:**

| | Memory | Pages that worked |
|---|---|---|
| Playwright MCP 0.0.83 | 5.04 GB | 18 / 20 |
| browser-use 0.13.11 | 4.61 GB | 18 / 20 |
| Stagehand 4.2.1 | 4.51 GB | 17 / 20 |
| agent-browser 0.39.1 | 3.83 GB | 18 / 20 |
| Headless Chrome (Playwright) | 3.13 GB | 17 / 20 |
| **agent-tabs** | **339 MB** | **18 / 20** |

11–15× less than every agent browser tool we tried. Each opened the same 20 real sites, one after
another, through its own interface with its default settings, on one MacBook, back to back;
only the browser's processes are counted. Going back to the first tab afterwards: 377 ms.

## Why

We opened the same 20 real sites (docs, GitHub, papers, news front pages) as 20 tabs on a MacBook,
in three different browser engines:

| Engine | Memory, 20 tabs |
|---|---|
| Chromium headless shell | 3.87 GB |
| Obscura 0.2.4 (Rust, "30 MB per page") | 3.80 GB |
| WebKit 26.6 (Safari's engine) | 4.58 GB (Reuters loaded fully; it blocked the others) |

Single runs on live sites, which change: the next day the headless shell measured 3.12 GB, with The
Verge failing to load. Still, they all cost about the same. The memory belongs to the **websites**: a news front page alone took
400–900 MB, mostly ads, trackers and video players. A lighter engine can't fix that. Not running
what the agent isn't using can.

## How

An agent sees all its tabs, all the time. Behind them:

| A tab is… | What runs | Memory |
|---|---|---|
| **live** | a real page in Chromium | what the site costs |
| **asleep** | nothing; we keep its url, title, scroll position and text | tens of KB |

Only the few tabs used most recently are live (2 by default). Asking for a sleeping tab's page opens
it again where it was, still signed in (all tabs share one cookie jar): about 0.4 s for Wikipedia. A
tab where the agent typed something and hasn't sent it never sleeps. Only real typing counts, not
fields a site's own scripts fill in.

Live tabs also don't load what an agent never looks at: ads, trackers, images, video and fonts
(`launch({ block: false })` turns that off, `block: { media: false }` keeps pictures).

```ts
import { launch } from "agent-tabs"

const browser = await launch({ maxLive: 2 })
const tab = await browser.open("https://en.wikipedia.org/wiki/Web_browser")
const page = await tab.page() // a Playwright page; wakes the tab if it was asleep
tab.state // "live" | "asleep"
tab.saved // what the agent last saw, even while asleep
await browser.close()
```

It runs on Playwright's own headless Chromium, downloaded by `pnpm setup`, never the Chrome or Safari
installed on your Mac. Any browser that speaks Chrome's DevTools protocol can be used instead:
`launch({ engine: { kind: "cdp", url: "http://127.0.0.1:9222" } })`.

## Steps

| Step | What | Status |
|---|---|---|
| 0 | Skeleton, benchmark harness, baseline | ✅ |
| 1 | Blocking: no ads, trackers, images, video or fonts (`src/blocking.ts`) | ✅ −36% memory, 2.4× faster |
| 2 | Sleeping tabs (`src/browser.ts`, `src/tab.ts`, `src/sleep.ts`) | ✅ 9.6× less memory |
| 3 | Reading without a browser for simple pages (markdown) | |
| 4 | O uses it | |
| 5 | Accuracy and tokens on a public benchmark, run in parallel; publish | |

## Results so far

20 real tabs, all on Chromium's headless shell, three runs back to back:

| | Memory with 20 tabs | Highest along the way | Pages that worked | Time to open all 20 |
|---|---|---|---|---|
| Headless Chrome | 3.26 GB | 3.26 GB | 17 / 20 | 70 s |
| + blocking | 2.39 GB | 2.39 GB | 18 / 20 | 32 s |
| **agent-tabs** (blocking + 2 tabs live) | **340 MB** | 624 MB (TechCrunch) | **18 / 20** | **19 s** |

Waking the first tab (Wikipedia) after all 20: 401 ms.

Blocking matters most on news sites: CNN went from about 1 GB to 180 MB. But light pages barely
change: a Wikipedia tab still costs about 100 MB, because that's what any running page costs
Chromium. Sleeping tabs remove that floor: with 2 live, memory stays around what the 2 heaviest
recent sites cost, however many tabs are open.

Earlier runs of plain headless Chrome, on other days: 3.12, 3.74 and 3.87 GB. Live sites change.

### The other tools

`bench/others/` drives each tool through its own interface: agent-browser's CLI (`open`, then
`tab new`), Playwright MCP's tools over MCP (`browser_navigate`, then `browser_tabs new`),
Stagehand's `localBrowser` + `context.newPage`, and browser-use's `BrowserSession.navigate_to(url,
new_tab=True)`, all headless, versions pinned in `bench/others/package.json`.

```sh
cd bench/others && npm install && npx agent-browser install
node others.mjs agent-browser 20        # or playwright-mcp, stagehand
uv venv .venv && uv pip install --python .venv/bin/python browser-use==0.13.11
.venv/bin/python browser_use.py 20
```

They all run full Chrome (agent-browser its own Chrome 155; Playwright MCP, Stagehand and
browser-use the Chrome installed on the Mac), with every tab live.

## Benchmark

```sh
pnpm setup                                # downloads Chromium's headless shell
node bench/run.ts agent-tabs 20 --live 2  # agent-tabs
node bench/run.ts chrome-shell 20         # or chromium, webkit, obscura (with OBSCURA_BIN)
node bench/run.ts chrome-shell 20 --block # with blocking (--block-ads: ads and trackers only)
```

Opens the sites in `bench/sites.ts` one after another, keeps them open, and prints the browser's
memory after each, measured with macOS's `footprint` over all its processes (shared memory counted
once). For agent-tabs it then wakes the first tab and times it. Results are saved to `bench/results/`.

## Reading order

`src/index.ts` → `src/browser.ts` → `src/tab.ts` → `src/sleep.ts` → `src/engine.ts` → `src/blocking.ts`, then
`bench/run.ts` → `bench/measure.ts`.
