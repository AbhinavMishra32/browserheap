# Browserheap

> Working name. The real one is picked before launch.

A browser for AI agents where **a tab costs memory only while the agent is using it.**

Agents doing research open tab after tab and never close them. Most of those tabs sit idle, holding
memory: every running page costs what its site costs, often 100 MB to 1 GB for a news front page.
Browserheap keeps the few tabs the agent is using live and puts the rest to sleep until the agent goes
back to them. It's the same Chromium underneath, so every site still works, and the agent can still
see, click and screenshot.

**Handles that survive sleep.** The pages and locators an agent holds follow their tab, not one
browser page. Keep a page in a variable, open ten more tabs, come back and click: the tab wakes
underneath and the click lands. The agent never has to know its tabs were asleep.

```js
const docs = page                                   // react.dev
await openTab("https://www.bbc.com/news")
await openTab("https://github.com/microsoft/playwright")   // react.dev is asleep now
await docs.getByRole("link", { name: "Learn" }).click()    // it wakes, and the click lands
console.log(await tabs[1].text())                   // read a sleeping tab without waking it
```

## Use it from Claude Code, Codex and other agents

```sh
npx browserheap install                          # once: downloads its Chromium
npx browserheap open https://news.ycombinator.com   # the page as a tree with refs
npx browserheap run 'await page.locator("e14").click(); console.log((await snapshot(page)).diff)'
npx browserheap tabs                             # live and asleep tabs
npx browserheap stop
```


The agent writes Playwright-style JavaScript into a REPL that stays alive between commands, so one
command can do many steps and variables carry over. Give your agent the skill in
[`skills/browserheap/SKILL.md`](skills/browserheap/SKILL.md): `npx browserheap skill claude` adds it
to Claude Code and `npx browserheap skill codex` to Codex (both also download the browser), or paste
it into `AGENTS.md`. An MCP server is next.

## Numbers

**30 real websites opened as tabs, one after another, never closed.** Same E2B machine for every
browser (Linux, 8 vCPUs, 8 GB), default settings, memory as PSS over all the browser's processes:

| Browser | Memory at 30 tabs | Each extra tab adds |
|---|---|---|
| **Browserheap** | **539 MB** | **3 MB** |
| agent-browser 0.39.1 | 3,583 MB | 113 MB |
| Headless Chrome (Playwright) | 3,797 MB | 127 MB |
| Stagehand 4.2.1 | 3,877 MB | 117 MB |
| Lightpanda 1.0.0 | 4,203 MB | 80 MB |
| browser-use 0.13.11 | 4,204 MB | 131 MB |
| Playwright MCP 0.0.83 | 4,406 MB | 137 MB |
| Obscura 0.2.4 | 6,884 MB | 193 MB |

Lightpanda is lighter than Browserheap for the first few tabs and passes it around tab 10. Waking a
sleeping tab took 274 ms.

**Agents can still do their work.** It's Chromium, so nothing an agent does breaks:

| | Browserheap | Chrome (and every agent tool above) | Lightpanda | Obscura |
|---|---|---|---|---|
| Agent actions that work (19 tests) | **19** | 19 | 12 | 15 |
| Real sites with the same content as Chrome | **45 / 46** | 46 / 46 | 42 / 46 | 39 / 46 |
| Typical page load | **0.5 s** | 0.6 s | 0.5 s | 1.3 s |

Lightpanda can't report where elements are, click at a spot, scroll for more items, reach inside
iframes or web components, follow popups, or take a screenshot that shows the page as drawn.

In internal testing on BU Bench V1 (10 tasks, a pi agent on gpt-6-luna), the agent solved as many
tasks with sleeping tabs as with a plain headless Chrome, using 36% less memory on average and 11%
less time. The full 100-task run is in progress.

Every number, and how it was measured: `bench/launch/2026-10-15/` (open `benchmark.html`).

## How it works

An agent sees all its tabs, all the time. Behind them:

| A tab is… | What runs | Memory |
|---|---|---|
| **live** | a real Chromium page | what the site costs |
| **asleep** | nothing; we keep its URL, title, scroll position and text | a few KB |

- Only the tabs used most recently are live (2 by default). Opening a third puts the one used longest
  ago to sleep.
- A sleeping tab's text stays readable without waking it (`tab.saved`).
- Acting on a sleeping tab wakes it: the page loads again and scrolls back to where it was. All tabs
  share one cookie jar, so it's still signed in.
- A tab where the agent typed something it hasn't sent never sleeps. Only real typing counts, not
  fields a site fills in itself.
- Live tabs don't load ads and trackers, and by default not images, video or fonts either (see
  [Blocking](#blocking)).
- A tab a page opens (a popup, a `target="_blank"` link) joins the agent's tabs. A page that calls
  `window.close()` closes its tab.

## Quick start

Not on npm yet. From a checkout:

```sh
pnpm install
pnpm setup        # downloads Playwright's Chromium headless shell
```

```ts
import { launch } from "browserheap"

const browser = await launch({ maxLive: 2 })

const docs = await browser.open("https://react.dev")
const news = await browser.open("https://www.bbc.com/news")
const repo = await browser.open("https://github.com/microsoft/playwright") // react.dev goes to sleep

docs.state       // "asleep"
docs.saved       // { url, title, scrollY, text }: readable without waking it
const page = await docs.page() // a Playwright Page; wakes the tab, scrolled back to where it was
await page.getByRole("link", { name: "Learn" }).click()

browser.tabs     // every tab the agent opened, live or asleep
await news.close()
await browser.close()
```

It runs Playwright's own Chromium, never the Chrome or Safari installed on your computer, unless you
point it at one.

## API

### `startSession(options?) → Session`: the browser and its REPL

What the CLI runs, for building your own agent tool:

```ts
import { startSession } from "browserheap"

const session = await startSession({ maxLive: 2 })
const result = await session.run(`await openTab("react.dev"); console.log((await snapshot(page)).tree)`)
result.content   // [{ type: "text", text: "- title: React …" }], and images the code displayed
result.error     // set when the code threw, timed out (120 s) or was stopped
await session.close()
```

The code runs in a QuickJS sandbox: it reaches the pages and nothing else on the machine. In it:
`page`, `tabs`, `openTab(url)`, `closeTab(tab)`, `snapshot(tab, options?)` (the page as a tree with
refs, and what changed), `annotatedScreenshot(tab)`, `display(image)`, `console.log`, `sleep(ms)`.
Pages and locators have Playwright's methods, plus `tab.text()` and `tab.isAsleep()`.
`startSession` takes the same options as `launch`, and blocks ads and trackers but keeps pictures.

### `launch(options?) → AgentBrowser`: just the tabs

| Option | What it does | Default |
|---|---|---|
| `maxLive` | How many tabs run at once | `2` |
| `block` | What to block: `{ ads, media }`, or `false` for nothing | ads, trackers, images, video and fonts |
| `engine` | `{ kind: "chromium" }` Playwright's headless Chromium · `{ kind: "cdp", url }` a running browser · `{ kind: "browser", browser }` a Playwright browser you started (closing only closes the tabs) | `{ kind: "chromium" }` |
| `context` | More Playwright context options, like `userAgent` | viewport 1280×800 |
| `onNewTab(tab)` | Called when a page opens a tab itself | — |

### `AgentBrowser`

| | |
|---|---|
| `open(url?)` | Opens a live tab and returns it. Without a URL the tab stays blank for you to navigate. |
| `tabs` | Every open tab, live or asleep, in the order they were opened |
| `context` | The Playwright context every tab is in: its cookies are the tabs' cookies |
| `blocked` | How many requests blocking stopped: `{ ads, media }` |
| `pid` | The browser's main process, for measuring it; `null` for a browser it didn't start |
| `close()` | Closes every tab and the browser underneath |

### `Tab`

| | |
|---|---|
| `id` | Stable for the tab's whole life, asleep or not |
| `state` | `"live"` or `"asleep"` |
| `url` | Where the tab is |
| `saved` | What the agent last saw: `{ url, title, scrollY, text }`, kept while it sleeps |
| `page()` | The tab's Playwright `Page`, waking it first if it's asleep |
| `livePage` | The page if it's live, `null` if it's asleep: look without waking |
| `close()` | Closes the tab for good |

### Blocking

`block: { ads: true, media: true }` is the default: ads and trackers (Ghostery's lists) plus images,
video and fonts. **For agents that look at screenshots, use `block: { ads: true, media: false }`**
so pages keep their pictures. `block: false` turns blocking off. The page itself is never blocked,
only what it loads. `startBlocking(context, options)` adds the same blocking to any Playwright context.

## Building your own tools on the tabs

The REPL is one way to drive the tabs. Underneath, Browserheap decides which tabs are running and
hands out ordinary Playwright pages, so **any tooling works on top of it**:

- tool calls like Playwright MCP's or agent-browser's: `open`, `tabs`, `snapshot`, `click`, `type`, `screenshot`
- your own snapshot format: accessibility trees, numbered elements, markdown, set-of-marks screenshots
- a JavaScript REPL where the agent writes Playwright code
- raw Chrome DevTools Protocol: `page.context().newCDPSession(page)`

Three rules for a tool built on `launch()` directly (the REPL's pages follow them for you):

**1. Keep `Tab`s, not pages. Ask for the page every time you act.** When a tab sleeps its page is
closed; waking makes a new one.

```ts
// right: wakes the tab if needed
await (await tab.page()).getByRole("button", { name: "Save" }).click()

// wrong: `page` is closed once the tab sleeps
const page = await tab.page()
// …the agent opens two more tabs…
await page.click("text=Save")
```

**2. References into a page don't survive sleep.** Element handles, snapshot ids and refs point at
the old page. After a tab wakes, take a fresh snapshot before acting on its elements.

**3. Read sleeping tabs from `tab.saved`.** When the agent only wants to look ("what did that page
say?"), answer from `tab.saved.text` and nothing wakes. Wake only to act.

A tool-call layer is mostly a map from tab ids to `Tab`s:

```ts
const tabs = new Map<string, Tab>()

async function open(url: string) {
  const tab = await browser.open(url)
  tabs.set(tab.id, tab)
  return { tab: tab.id, title: await (await tab.page()).title() }
}

function list() {
  return browser.tabs.map((tab) => ({ tab: tab.id, url: tab.url, title: tab.saved?.title, state: tab.state }))
}

function read(id: string) {
  const tab = tabs.get(id)
  if (tab?.livePage) return tab.livePage.evaluate(() => document.body.innerText)
  return tab?.saved?.text // asleep: no wake needed
}

async function click(id: string, name: string) {
  const page = await tabs.get(id)!.page() // wakes it if it was asleep
  await page.getByRole("link", { name }).or(page.getByRole("button", { name })).first().click()
}
```

## Limits

- **One agent's tabs load one at a time.** Opening, waking and sleeping in one `AgentBrowser` happen in
  turn, so an agent that opens five tabs at once waits for each. Separate agents should each have
  their own `AgentBrowser` (or context) and run side by side.
- **A sleeping page stops.** A page left working in the background (a long export, a live log, a chat
  waiting for a reply) stops when it sleeps. Raise `maxLive` if an agent needs more pages running.
- **Waking reloads.** Whatever lived only in the running page (an open menu, items an endless list
  loaded, a half-done multi-step page) is gone after a wake; the URL, scroll position and cookies
  come back.
- **Refs don't survive a wake.** Snapshot refs (`e12`) belong to the page as it was; after a tab
  wakes, take a new snapshot. Role, text and CSS locators keep working.
- **No MCP server yet.** The CLI and the library work today; an MCP server is next.

## Benchmarks

Everything above can be rerun. Results go to `bench/results/` (not in git); the launch numbers are in
`bench/launch/`.

**Memory**, on this computer (macOS `footprint`) or Linux (PSS):

```sh
node bench/run.ts browserheap 30 --live 2
node bench/run.ts chrome-shell 30          # or chromium, webkit, obscura, lightpanda
```

Lightpanda and Obscura need `LIGHTPANDA_BIN` and `OBSCURA_BIN` pointing at their programs. The other
agent tools are driven through their own interfaces from `bench/others/`:

```sh
cd bench/others && npm install && npx agent-browser install
node others.mjs agent-browser 30          # or playwright-mcp, stagehand
uv venv .venv && uv pip install --python .venv/bin/python browser-use==0.13.11
.venv/bin/python browser-use.py 30
```

**Agent actions** (19 tests on a local test site) and **real sites** (60 sites, compared with Chrome):

```sh
node bench/actions.ts browserheap          # or chrome, lightpanda, obscura
node bench/compat.ts browserheap
```

**On E2B**, every browser on the same clean machine (needs `E2B_API_KEY`):

```sh
node --env-file=.env bench/e2b/run.ts template     # once: builds the machine
node --env-file=.env bench/e2b/run.ts memory 30
node --env-file=.env bench/e2b/run.ts actions
node --env-file=.env bench/e2b/run.ts compat
```

**BU Bench** (`bench/o/`) runs a pi agent through the server of an app we haven't released yet, so it
can't be rerun outside our setup for now. It runs in batches, saves after every task, and stops
before your model provider's usage limit, so a long run picks up where it stopped.

## Reading order

`src/index.ts` → `src/browser.ts` → `src/tab.ts` → `src/sleep.ts` → `src/engine.ts` →
`src/blocking.ts`; the REPL: `src/repl/session.ts` → `src/repl/agent-page.ts` → `src/repl/repl.ts` →
`src/repl/snapshot.ts`; the CLI: `src/cli/main.ts` → `src/cli/client.ts` → `src/cli/server.ts`;
the benchmarks: `bench/subjects.ts` → `bench/run.ts` → `bench/actions.ts` → `bench/compat.ts`.
