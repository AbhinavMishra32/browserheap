/**
 * The page and locators the agent's REPL code uses: Playwright's API, the
 * way Aside's Asidewright offers it.
 *
 *   await page.goto("news.ycombinator.com")         waits until the page is usable
 *   await page.locator("e12").click()                a ref from snapshot(page) …
 *   await page.locator("f1e3").fill("hi")            … in an iframe too
 *   await page.getByRole("button", { name: "Save" }).click()
 *   await page.keyboard.press("Enter")
 *   display(await page.screenshot())
 *
 * Every action waits for the page to settle afterwards (settle.ts), so the
 * agent never needs sleep() after one. Errors are Playwright's first line,
 * without its call log.
 *
 * A page follows its tab (browserheap), not one Playwright page: a tab that
 * went to sleep and woke up has a new page underneath, so every call asks
 * the tab for its page then. `const docs = page` in one REPL call still works
 * many calls later, after docs has slept. Locators work the same way: each
 * one remembers how it's found (locator("e12").first()), and finds it again
 * on whatever page the tab has now.
 *
 * These are the only objects the REPL's sandbox can reach. The tab and
 * Playwright's objects stay in private fields (#tab, #find), which no code in
 * the sandbox can read, so nothing there leads to the browser context, its
 * cookies, or the rest of the program.
 *
 * Uses:    browserheap (Tab), snapshot.ts (refs), settle.ts, playwright-core
 * Used by: session.ts, repl.ts
 * Built:   in O first (5.6), copied into browserheap
 */
import { inspect } from "node:util"
import type { Locator, Page } from "playwright-core"
import type { Tab } from "../tab.ts"
import { afterAction, untilUsable } from "./settle.ts"
import { frameOfRef, isRef } from "./snapshot.ts"

/** How long an action waits for its element (visible, enabled, still). */
export const ACTION_TIMEOUT_MS = 10_000
/** How long a page gets to load. */
export const NAVIGATION_TIMEOUT_MS = 30_000

type ScreenshotOptions = {
  fullPage?: boolean
  type?: "png" | "jpeg"
  quality?: number
  clip?: { x: number; y: number; width: number; height: number }
}
type ClickOptions = {
  button?: "left" | "right" | "middle"
  clickCount?: number
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  position?: { x: number; y: number }
  force?: boolean
  timeout?: number
}
type RoleOptions = {
  name?: string | RegExp
  exact?: boolean
  checked?: boolean
  disabled?: boolean
  expanded?: boolean
  level?: number
  pressed?: boolean
  selected?: boolean
  includeHidden?: boolean
}
type TextOptions = { exact?: boolean }

/** How a locator is found on the tab's page: run again on each call, since the page can change. */
type Find = (page: Page) => Locator

export class AgentPage {
  #tab: Tab
  readonly keyboard: {
    press(key: string): Promise<void>
    type(text: string, options?: { delay?: number }): Promise<void>
    insertText(text: string): Promise<void>
    down(key: string): Promise<void>
    up(key: string): Promise<void>
  }
  readonly mouse: {
    click(x: number, y: number, options?: ClickOptions): Promise<void>
    dblclick(x: number, y: number): Promise<void>
    move(x: number, y: number, options?: { steps?: number }): Promise<void>
    down(): Promise<void>
    up(): Promise<void>
    wheel(deltaX: number, deltaY: number): Promise<void>
  }

  constructor(tab: Tab) {
    this.#tab = tab
    this.keyboard = {
      press: (key) => this.#settled((page) => page.keyboard.press(key)),
      type: (text, options) =>
        this.#settled((page) => page.keyboard.type(text, { delay: options?.delay ?? 12 })),
      insertText: (text) => this.#settled((page) => page.keyboard.insertText(text)),
      down: (key) => this.#withPage((page) => page.keyboard.down(key)),
      up: (key) => this.#withPage((page) => page.keyboard.up(key)),
    }
    this.mouse = {
      click: (x, y, options) =>
        this.#settled((page) =>
          page.mouse.click(x, y, { button: options?.button, clickCount: options?.clickCount }),
        ),
      dblclick: (x, y) => this.#settled((page) => page.mouse.dblclick(x, y)),
      move: (x, y, options) => this.#withPage((page) => page.mouse.move(x, y, options)),
      down: () => this.#withPage((page) => page.mouse.down()),
      up: () => this.#settled((page) => page.mouse.up()),
      wheel: (deltaX, deltaY) => this.#settled((page) => page.mouse.wheel(deltaX, deltaY)),
    }
  }

  /** The tab's Playwright page now, waking the tab if it sleeps. For the session (never handed to the sandbox). */
  static unwrap(page: AgentPage): Promise<Page> {
    return page.#tab.page()
  }

  /** The tab, for the session (never handed to the sandbox). */
  static tabOf(page: AgentPage): Tab {
    return page.#tab
  }

  /** Runs `work` on the tab's page now, with Playwright's error made plain. */
  #withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    return withPlainError(async () => work(await this.#tab.page()))
  }

  /** Like #withPage, then waits for the page to settle after the action. */
  #settled<T>(action: (page: Page) => Promise<T>): Promise<T> {
    return this.#withPage((page) => afterAction(page, () => action(page)))
  }

  /** Where the tab is. Doesn't wake it. */
  url(): string {
    return this.#tab.livePage?.url() ?? this.#tab.url
  }

  /** The tab's title. A sleeping tab answers with the title it had, without waking. */
  async title(): Promise<string> {
    const live = this.#tab.livePage
    if (live === null) {
      return this.#tab.saved?.title ?? ""
    }
    return live.title()
  }

  isClosed(): boolean {
    return this.#tab.closed
  }

  /** True while the tab sleeps: nothing runs, and acting on it wakes it. */
  isAsleep(): boolean {
    return this.#tab.state === "asleep"
  }

  /** The page's text. A sleeping tab answers with the text it had, without waking. */
  async text(): Promise<string> {
    const live = this.#tab.livePage
    if (live === null) {
      return this.#tab.saved?.text ?? ""
    }
    return live.evaluate(() => document.body?.innerText ?? "")
  }

  async goto(url: string): Promise<void> {
    await this.#withPage(async (page) => {
      await page.goto(addressOf(url), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
      await untilUsable(page)
    })
  }

  async goBack(): Promise<void> {
    await this.#settled((page) =>
      page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
    )
  }

  async goForward(): Promise<void> {
    await this.#settled((page) =>
      page.goForward({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
    )
  }

  async reload(): Promise<void> {
    await this.#withPage(async (page) => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
      await untilUsable(page)
    })
  }

  /** A ref from snapshot() (e12, f1e3), or any Playwright selector. */
  locator(selector: string): AgentLocator {
    const described = `locator(${JSON.stringify(selector)})`
    if (isRef(selector)) {
      return new AgentLocator(
        this.#tab,
        (page) => frameOfRef(page, selector).locator(`tabref=${selector}`),
        described,
        selector,
      )
    }
    return new AgentLocator(this.#tab, (page) => page.locator(selector), described)
  }

  getByRole(role: string, options?: RoleOptions): AgentLocator {
    return new AgentLocator(
      this.#tab,
      (page) => page.getByRole(role as Parameters<Page["getByRole"]>[0], options),
      `getByRole(${JSON.stringify(role)})`,
    )
  }

  getByText(text: string | RegExp, options?: TextOptions): AgentLocator {
    return new AgentLocator(this.#tab, (page) => page.getByText(text, options), `getByText(${String(text)})`)
  }

  getByLabel(text: string | RegExp, options?: TextOptions): AgentLocator {
    return new AgentLocator(
      this.#tab,
      (page) => page.getByLabel(text, options),
      `getByLabel(${String(text)})`,
    )
  }

  getByPlaceholder(text: string | RegExp, options?: TextOptions): AgentLocator {
    return new AgentLocator(
      this.#tab,
      (page) => page.getByPlaceholder(text, options),
      `getByPlaceholder(${String(text)})`,
    )
  }

  getByAltText(text: string | RegExp, options?: TextOptions): AgentLocator {
    return new AgentLocator(
      this.#tab,
      (page) => page.getByAltText(text, options),
      `getByAltText(${String(text)})`,
    )
  }

  getByTitle(text: string | RegExp, options?: TextOptions): AgentLocator {
    return new AgentLocator(
      this.#tab,
      (page) => page.getByTitle(text, options),
      `getByTitle(${String(text)})`,
    )
  }

  getByTestId(id: string): AgentLocator {
    return new AgentLocator(this.#tab, (page) => page.getByTestId(id), `getByTestId(${JSON.stringify(id)})`)
  }

  // Playwright's page-level shortcuts: page.click(selector) is page.locator(selector).click().

  click(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).click(options)
  }

  dblclick(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).dblclick(options)
  }

  fill(selector: string, value: string): Promise<void> {
    return this.locator(selector).fill(value)
  }

  type(selector: string, text: string, options?: { delay?: number }): Promise<void> {
    return this.locator(selector).pressSequentially(text, options)
  }

  press(selector: string, key: string): Promise<void> {
    return this.locator(selector).press(key)
  }

  check(selector: string): Promise<void> {
    return this.locator(selector).check()
  }

  uncheck(selector: string): Promise<void> {
    return this.locator(selector).uncheck()
  }

  hover(selector: string): Promise<void> {
    return this.locator(selector).hover()
  }

  focus(selector: string): Promise<void> {
    return this.locator(selector).focus()
  }

  selectOption(selector: string, values: string | string[]): Promise<string[]> {
    return this.locator(selector).selectOption(values)
  }

  textContent(selector: string): Promise<string | null> {
    return this.locator(selector).textContent()
  }

  innerText(selector: string): Promise<string> {
    return this.locator(selector).innerText()
  }

  inputValue(selector: string): Promise<string> {
    return this.locator(selector).inputValue()
  }

  getAttribute(selector: string, name: string): Promise<string | null> {
    return this.locator(selector).getAttribute(name)
  }

  isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).isVisible()
  }

  async waitForSelector(
    selector: string,
    options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number },
  ): Promise<void> {
    await this.locator(selector).waitFor(options)
  }

  async waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void> {
    await this.#withPage((page) =>
      page.waitForLoadState(state, { timeout: options?.timeout ?? NAVIGATION_TIMEOUT_MS }),
    )
  }

  async waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void> {
    await this.#withPage((page) =>
      page.waitForURL(url, {
        timeout: options?.timeout ?? NAVIGATION_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      }),
    )
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Runs a function (or an expression) in the page. The REPL hands functions over as their source. */
  evaluate(pageFunction: string, arg?: unknown): Promise<unknown> {
    return this.#withPage((page) => page.evaluate(callable(pageFunction, arg)))
  }

  content(): Promise<string> {
    return this.#withPage((page) => page.content())
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    return this.#withPage((page) =>
      page.screenshot({
        fullPage: options?.fullPage,
        type: options?.type ?? "jpeg",
        quality: options?.quality ?? (options?.type === "png" ? undefined : 80),
        clip: options?.clip,
      }),
    )
  }

  [inspect.custom](): string {
    return `Page(${this.url()})`
  }
}

export class AgentLocator {
  #tab: Tab
  #find: Find
  /** How it was made, like locator("e12").first(), to show the agent. */
  #described: string
  /** The ref it was made from (e12), so a stale one fails at once instead of waiting. */
  #ref: string | null

  constructor(tab: Tab, find: Find, described: string, ref: string | null = null) {
    this.#tab = tab
    this.#find = find
    this.#described = described
    this.#ref = ref
  }

  #act<T>(action: (locator: Locator) => Promise<T>): Promise<T> {
    return withPlainError(async () => {
      const page = await this.#tab.page()
      const locator = this.#find(page)
      await this.#refExists(locator)
      return afterAction(page, () => action(locator))
    })
  }

  #read<T>(read: (locator: Locator) => Promise<T>): Promise<T> {
    return withPlainError(async () => {
      const page = await this.#tab.page()
      const locator = this.#find(page)
      await this.#refExists(locator)
      return read(locator)
    })
  }

  async #refExists(locator: Locator): Promise<void> {
    if (this.#ref !== null && (await locator.count()) === 0) {
      throw new Error(
        `There's no element ${this.#ref} on the page any more. Take a new snapshot and use its refs.`,
      )
    }
  }

  /** A narrower locator: found by finding this one, then `narrow`. */
  #narrow(narrow: (locator: Locator) => Locator, described: string): AgentLocator {
    const find = this.#find
    return new AgentLocator(this.#tab, (page) => narrow(find(page)), `${this.#described}.${described}`)
  }

  // Actions: they wait for the element (visible, enabled, still, not covered), then for the page to settle.

  click(options?: ClickOptions): Promise<void> {
    return this.#act((locator) => locator.click({ timeout: ACTION_TIMEOUT_MS, ...options }))
  }

  dblclick(options?: ClickOptions): Promise<void> {
    return this.#act((locator) => locator.dblclick({ timeout: ACTION_TIMEOUT_MS, ...options }))
  }

  fill(value: string): Promise<void> {
    return this.#act((locator) => locator.fill(value, { timeout: ACTION_TIMEOUT_MS }))
  }

  clear(): Promise<void> {
    return this.#act((locator) => locator.clear({ timeout: ACTION_TIMEOUT_MS }))
  }

  pressSequentially(text: string, options?: { delay?: number }): Promise<void> {
    return this.#act((locator) =>
      locator.pressSequentially(text, { delay: options?.delay ?? 12, timeout: ACTION_TIMEOUT_MS }),
    )
  }

  /** Playwright's older name for pressSequentially. */
  type(text: string, options?: { delay?: number }): Promise<void> {
    return this.pressSequentially(text, options)
  }

  press(key: string): Promise<void> {
    return this.#act((locator) => locator.press(key, { timeout: ACTION_TIMEOUT_MS }))
  }

  check(): Promise<void> {
    return this.#act((locator) => locator.check({ timeout: ACTION_TIMEOUT_MS }))
  }

  uncheck(): Promise<void> {
    return this.#act((locator) => locator.uncheck({ timeout: ACTION_TIMEOUT_MS }))
  }

  setChecked(checked: boolean): Promise<void> {
    return this.#act((locator) => locator.setChecked(checked, { timeout: ACTION_TIMEOUT_MS }))
  }

  selectOption(values: string | string[]): Promise<string[]> {
    return this.#act((locator) => locator.selectOption(values, { timeout: ACTION_TIMEOUT_MS }))
  }

  hover(): Promise<void> {
    return this.#act((locator) => locator.hover({ timeout: ACTION_TIMEOUT_MS }))
  }

  focus(): Promise<void> {
    return this.#act((locator) => locator.focus({ timeout: ACTION_TIMEOUT_MS }))
  }

  blur(): Promise<void> {
    return this.#act((locator) => locator.blur({ timeout: ACTION_TIMEOUT_MS }))
  }

  scrollIntoViewIfNeeded(): Promise<void> {
    return this.#act((locator) => locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }))
  }

  dispatchEvent(type: string): Promise<void> {
    return this.#act((locator) => locator.dispatchEvent(type, undefined, { timeout: ACTION_TIMEOUT_MS }))
  }

  // Reads.

  textContent(): Promise<string | null> {
    return this.#read((locator) => locator.textContent({ timeout: ACTION_TIMEOUT_MS }))
  }

  innerText(): Promise<string> {
    return this.#read((locator) => locator.innerText({ timeout: ACTION_TIMEOUT_MS }))
  }

  innerHTML(): Promise<string> {
    return this.#read((locator) => locator.innerHTML({ timeout: ACTION_TIMEOUT_MS }))
  }

  inputValue(): Promise<string> {
    return this.#read((locator) => locator.inputValue({ timeout: ACTION_TIMEOUT_MS }))
  }

  getAttribute(name: string): Promise<string | null> {
    return this.#read((locator) => locator.getAttribute(name, { timeout: ACTION_TIMEOUT_MS }))
  }

  allTextContents(): Promise<string[]> {
    return this.#read((locator) => locator.allTextContents())
  }

  allInnerTexts(): Promise<string[]> {
    return this.#read((locator) => locator.allInnerTexts())
  }

  isVisible(): Promise<boolean> {
    return this.#read((locator) => locator.isVisible())
  }

  isHidden(): Promise<boolean> {
    return this.#read((locator) => locator.isHidden())
  }

  isEnabled(): Promise<boolean> {
    return this.#read((locator) => locator.isEnabled({ timeout: ACTION_TIMEOUT_MS }))
  }

  isDisabled(): Promise<boolean> {
    return this.#read((locator) => locator.isDisabled({ timeout: ACTION_TIMEOUT_MS }))
  }

  isChecked(): Promise<boolean> {
    return this.#read((locator) => locator.isChecked({ timeout: ACTION_TIMEOUT_MS }))
  }

  isEditable(): Promise<boolean> {
    return this.#read((locator) => locator.isEditable({ timeout: ACTION_TIMEOUT_MS }))
  }

  count(): Promise<number> {
    return this.#read((locator) => locator.count())
  }

  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return this.#read((locator) => locator.boundingBox({ timeout: ACTION_TIMEOUT_MS }))
  }

  async waitFor(options?: {
    state?: "attached" | "detached" | "visible" | "hidden"
    timeout?: number
  }): Promise<void> {
    await this.#read((locator) => locator.waitFor({ timeout: ACTION_TIMEOUT_MS, ...options }))
  }

  evaluate(pageFunction: string, arg?: unknown): Promise<unknown> {
    const source = pageFunction
    return this.#read((locator) => locator.evaluate(elementCallable(source), arg))
  }

  /** A picture of just this element (JPEG unless you ask for PNG). */
  screenshot(options?: { type?: "png" | "jpeg"; quality?: number }): Promise<Buffer> {
    return this.#read((locator) =>
      locator.screenshot({
        type: options?.type ?? "jpeg",
        quality: options?.quality ?? (options?.type === "png" ? undefined : 80),
        timeout: ACTION_TIMEOUT_MS,
      }),
    )
  }

  // Narrowing.

  first(): AgentLocator {
    return this.#narrow((locator) => locator.first(), "first()")
  }

  last(): AgentLocator {
    return this.#narrow((locator) => locator.last(), "last()")
  }

  nth(index: number): AgentLocator {
    return this.#narrow((locator) => locator.nth(index), `nth(${index})`)
  }

  locator(selector: string): AgentLocator {
    return this.#narrow((locator) => locator.locator(selector), `locator(${JSON.stringify(selector)})`)
  }

  filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp }): AgentLocator {
    return this.#narrow((locator) => locator.filter(options), "filter()")
  }

  getByRole(role: string, options?: RoleOptions): AgentLocator {
    return this.#narrow(
      (locator) => locator.getByRole(role as Parameters<Locator["getByRole"]>[0], options),
      `getByRole(${JSON.stringify(role)})`,
    )
  }

  getByText(text: string | RegExp, options?: TextOptions): AgentLocator {
    return this.#narrow((locator) => locator.getByText(text, options), `getByText(${String(text)})`)
  }

  getByLabel(text: string | RegExp, options?: TextOptions): AgentLocator {
    return this.#narrow((locator) => locator.getByLabel(text, options), `getByLabel(${String(text)})`)
  }

  getByPlaceholder(text: string | RegExp, options?: TextOptions): AgentLocator {
    return this.#narrow(
      (locator) => locator.getByPlaceholder(text, options),
      `getByPlaceholder(${String(text)})`,
    )
  }

  /** One locator for each element found now, by its position (nth). */
  async all(): Promise<AgentLocator[]> {
    const count = await this.#read((locator) => locator.count())
    const each: AgentLocator[] = []
    for (let index = 0; index < count; index++) {
      each.push(this.nth(index))
    }
    return each
  }

  [inspect.custom](): string {
    return `Locator(${this.#described})`
  }
}

/** "example.com" → "https://example.com". Anything with a scheme stays as it is. */
export function addressOf(url: string): string {
  const trimmed = url.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed
  }
  return `https://${trimmed}`
}

/**
 * Something page.evaluate can run: a function's source becomes a call with
 * its argument; anything else is an expression.
 */
function callable(source: string, arg: unknown): string {
  const trimmed = source.trim()
  if (/^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(trimmed)) {
    return `(${trimmed})(${JSON.stringify(arg ?? null)})`
  }
  return trimmed
}

/** For locator.evaluate, which calls it with the element: always a function. */
function elementCallable(source: string): string {
  const trimmed = source.trim()
  if (/^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(trimmed)) {
    return trimmed
  }
  return `() => (${trimmed})`
}

/** Playwright's error, without its call log: the first lines are what the agent can act on. */
async function withPlainError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Error) {
      const message = error.message.split("\nCall log:")[0]?.trim() ?? error.message
      throw new Error(message.replace(/^(locator|page|frame|keyboard|mouse)\.\w+: /, ""))
    }
    throw error
  }
}
