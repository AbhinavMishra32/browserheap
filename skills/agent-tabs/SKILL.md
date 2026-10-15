---
name: agent-tabs
description: Browse real websites from the shell with a headless Chromium whose idle tabs sleep. Use for web research, reading docs, filling forms, checking a site or web app, and anything that needs many tabs open. Drive pages with Playwright-style JavaScript in a persistent REPL; pages you keep in variables keep working after their tab sleeps.
---

# agent-tabs

A browser for you, driven from the shell. Tabs you aren't using sleep, so you can keep many open
(research, comparing sources) without the machine running out of memory. A sleeping tab wakes by
itself when you act on it.

## Setup (once)

```sh
npx agent-tabs install
```

## The loop

1. Open a page and look at it:
   ```sh
   npx agent-tabs open https://news.ycombinator.com
   ```
   This prints the page as a tree. Elements you can act on have refs: `link "new" [ref=e14]`.

2. Act with JavaScript in the REPL, then look at what changed:
   ```sh
   npx agent-tabs run 'await page.locator("e14").click(); console.log((await snapshot(page)).diff)'
   ```

3. Repeat. Variables live between `run` calls, so `const results = page` in one call is still there
   in the next.

For longer code, write it to a file and run `npx agent-tabs run --file steps.js`, or pipe it in.

## What the code has

| | |
|---|---|
| `page` | The tab you're on: the one you opened last, or one a page opened (a popup, a new-tab link) |
| `tabs` | All your tabs, in the order opened |
| `openTab(url)` | Opens a tab, makes it `page`, waits until it's usable |
| `closeTab(tab)` | Closes a tab |
| `snapshot(tab, options?)` | `{ tree, diff }`: the page as a tree with refs, and what changed since your last snapshot of it. Options: `{ interactive: true }` only things you can act on, `{ ref: "e12" }` or `{ selector: "main" }` only that part, `{ showHidden: true }` |
| `display(image)` | Shows you an image: `display(await page.screenshot())` |
| `annotatedScreenshot(tab)` | A screenshot with every ref drawn on its element: `display((await annotatedScreenshot(page)).base64Image)` |
| `console.log(…)` | What you see back. Output is capped at 16 KB; print the part you need |
| `sleep(ms)` | Rarely needed: every action already waits for the page to settle |

Pages work like Playwright's: `goto`, `goBack`, `reload`, `title()`, `url()`, `text()`,
`locator(...)`, `getByRole(role, { name })`, `getByText`, `getByLabel`, `getByPlaceholder`,
`keyboard.press("Enter")`, `mouse.click(x, y)`, `screenshot()`, `evaluate(...)`, `waitForURL(...)`.
Locators: `click`, `fill`, `type`, `press`, `check`, `selectOption`, `hover`, `textContent`,
`innerText`, `inputValue`, `isVisible`, `count`, `first`, `nth`, `all`.

`page.locator("e12")` uses a ref from your last snapshot; `f1e3` is a ref inside an iframe.

## Sleeping tabs

Only the 2 tabs you used most recently are live; the rest sleep. You don't manage this:

- **Pages you hold keep working.** `const docs = page`, open five more tabs, then
  `await docs.getByRole("link", { name: "API" }).click()`: docs wakes and the click lands.
  Locators made with `getByRole`, `getByText`, `getByLabel` or CSS keep working the same way.
- **Read without waking.** `await tab.text()` and `await tab.title()` answer from what the tab
  showed when it went to sleep. Use them to look back at sources; wake a tab only to act on it.
- **Refs don't survive a wake.** Refs (`e12`) belong to the page as it was when you took the
  snapshot. After a tab wakes, take a new snapshot before using refs; an old ref fails with
  "Take a new snapshot and use its refs".
- **`tab.isAsleep()`** says whether a tab is sleeping. `npx agent-tabs tabs` lists them all.

Waking takes a fraction of a second and brings the page back where it was (same URL, scroll
position, still signed in). Things that lived only in the running page, like an open menu, are gone.

## Other commands

```sh
npx agent-tabs tabs                          # list tabs: live or asleep, title, url
npx agent-tabs screenshot --out shot.png     # screenshot of the current tab; open the file to look
npx agent-tabs stop                          # close the browser when you're done
```

- `--session <name>` gives a separate browser with its own tabs: use one per task when several
  agents browse at once.
- `--live <n>` keeps more tabs live (set it on the first command of a session).
- Images your code displays are saved under `~/.agent-tabs/images/`; the command prints each path.

## Tips

- One `run` can do many steps: search, open the top results, read each, print a summary.
- Prefer `snapshot(page, { interactive: true })` on busy pages; print `.diff` after actions.
- If a site shows a bot check or nothing loads, say so; don't guess what the page contains.
- Close the browser with `npx agent-tabs stop` when the task is finished.
