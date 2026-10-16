---
name: browserheap
description: Browse real websites from the shell with a headless Chromium whose idle tabs sleep. Use for web research, reading docs, filling forms, checking a site or web app, and anything that needs many tabs open. Drive pages with Playwright-style JavaScript in a persistent REPL; pages you keep in variables keep working after their tab sleeps.
---

# Browserheap

A browser for you, driven from the shell. Tabs you aren't using sleep, so you can keep many open
(research, comparing sources) without the machine running out of memory. A sleeping tab wakes by
itself when you act on it.

## Setup (once)

```sh
npx browserheap install
```

## The loop

1. Open a page and look at it:
   ```sh
   npx browserheap open https://news.ycombinator.com
   ```
   This prints the page as a tree. Elements you can act on have refs: `link "new" [ref=e14]`.

2. Act with JavaScript in the REPL, then look at what changed:
   ```sh
   npx browserheap run 'await page.locator("e14").click(); console.log((await snapshot(page)).diff)'
   ```

3. Repeat. Variables live between `run` calls, so `const results = page` in one call is still there
   in the next.

For longer code, write it to a file and run `npx browserheap run --file steps.js`, or pipe it in.

## What the code has

| | |
|---|---|
| `page` | The tab you're on: the one you opened last, or one a page opened (a popup, a new-tab link) |
| `tabs` | All your tabs, in the order opened |
| `openTab(url)` | Opens a tab, makes it `page`, waits until it's usable |
| `closeTab(tab)` | Closes a tab |
| `findInTabs(query)` | Every tab whose title or text has all the query's words, live or asleep, without waking any. Each match: `{ page, title, url, live, seen, seenAt, hits, snippets }` |
| `snapshot(tab, options?)` | `{ tree, diff }`: the page as a tree with refs, and what changed since your last snapshot of it. Options: `{ interactive: true }` only things you can act on, `{ ref: "e12" }` or `{ selector: "main" }` only that part, `{ showHidden: true }` |
| `display(image)` | Shows you an image: `display(await page.screenshot())` |
| `annotatedScreenshot(tab)` | A screenshot with every ref drawn on its element: `display((await annotatedScreenshot(page)).base64Image)` |
| `console.log(…)` | What you see back. Output is capped at 16 KB; print the part you need |
| `sleep(ms)` | Rarely needed: every action already waits for the page to settle |

Pages work like Playwright's: `goto`, `goBack`, `reload`, `title()`, `url()`, `text()`,
`locator(...)`, `getByRole(role, { name })`, `getByText`, `getByLabel`, `getByPlaceholder`,
`keyboard.press("Enter")`, `mouse.click(x, y)`, `screenshot()`, `evaluate(...)`, `waitForURL(...)`.
Locators: `click`, `fill`, `type`, `press`, `check`, `selectOption`, `setInputFiles` (file paths), `hover`, `textContent`,
`innerText`, `inputValue`, `isVisible`, `count`, `first`, `nth`, `all`.

`page.locator("e12")` uses a ref from your last snapshot; `f1e3` is a ref inside an iframe.

## Sleeping tabs

Only the 2 tabs you used most recently are live; the rest sleep. You don't manage this:

- **Pages you hold keep working.** `const docs = page`, open five more tabs, then
  `await docs.getByRole("link", { name: "API" }).click()`: docs wakes and the click lands.
  Locators made with `getByRole`, `getByText`, `getByLabel` or CSS keep working the same way.
- **Search everything you've read.** `await findInTabs("per seat price")` looks through every tab at
  once and gives snippets, most hits first. A sleeping tab's text is from when it went to sleep:
  `seen` says how old (`"saved 14 min ago"`). For things that change (prices, scores, inboxes), wake
  the tab (`match.page`) before relying on it.
- **Read without waking.** `await tab.text()` and `await tab.title()` answer from what the tab
  showed when it went to sleep. Use them to look back at sources; wake a tab only to act on it.
- **Refs keep working.** A ref (`e12`) from before a tab slept still means the same element
  after it wakes. If the page itself changed and the element is gone, the ref fails with
  "Take a new snapshot and use its refs".
- **`tab.isAsleep()`** says whether a tab is sleeping. `npx browserheap tabs` lists them all.

Waking takes a fraction of a second and brings the tab back as it was: same URL, scroll (the page's
and every scrolled panel's), filled-in fields, focus, sessionStorage, back/forward history, still
signed in. `page.goBack()` goes where it went before the tab slept. A menu you opened by clicking
is closed again: open it again if you need it.

## Other commands

```sh
npx browserheap tabs                          # list tabs: live or asleep, title, url
npx browserheap screenshot --out shot.png     # screenshot of the current tab; open the file to look
npx browserheap stop                          # close the browser when you're done
```

- `--session <name>` gives a separate browser with its own tabs: use one per task when several
  agents browse at once.
- `--live <n>` keeps more tabs live (set it on the first command of a session).
- `--headed` opens the browser with a window (first command of a session): for sites that still
  turn the headless browser away.
- `--headless-shell` runs Chromium's headless shell (first command of a session): less memory and
  faster wakes, but more sites show bot checks. Fine for local apps and docs.
- `--connect http://127.0.0.1:9222` drives a Chrome the user started with
  `--remote-debugging-port=9222`: their own browser, with their sign-ins.
- Cookies and site storage are kept between sessions (`~/.browserheap/<session>-state.json`), so a
  site that let you in once still knows you. `BROWSERHEAP_STATE=off` starts clean and saves nothing.
- Images your code displays are saved under `~/.browserheap/images/`; the command prints each path.

## Tips

- One `run` can do many steps: search, open the top results, read each, print a summary.
- Prefer `snapshot(page, { interactive: true })` on busy pages; print `.diff` after actions.
- Never guess what a page says. If you couldn't read it, say so.

## When a site gets in the way

- **Searching:** open the results page directly, e.g.
  `await openTab("https://www.google.com/search?q=" + encodeURIComponent(query))`. If Google shows
  a check, use Bing (`https://www.bing.com/search?q=…`).
- **A "Just a moment" or "checking your browser" page** often clears by itself: wait a few
  seconds (`await sleep(5000)`) and take a new snapshot.
- **Still blocked?** Get the same information another way before giving up: the site's own search
  or another page on it, another site that has it, a search result's snippet. Try at least two
  other ways. Then, for the hardest sites, a new session with `--headed`.
- **A CAPTCHA that is part of the task** (a form you were asked to fill in, a test page): look at it
  with `display(await page.screenshot())` and type what it shows. A CAPTCHA a site uses to keep
  automated browsers out is a "no": find the information elsewhere or ask the user.
- **Files to upload:** write the file first, then `await page.locator("input[type=file]").setInputFiles("/path/to/file")`.
- **Sites that need the user's account:** ask them, or use `--connect` with their own Chrome.
- Close the browser with `npx browserheap stop` when the task is finished.
