/**
 * Everything a tab's page holds that a reload would lose, saved when the tab
 * sleeps and put back when it wakes, so a woken tab is the tab it was.
 *
 *   capturePageState()       runs in the page as it goes to sleep
 *   restoreBeforeScripts()   runs in the woken page before its own scripts:
 *                            sessionStorage, window.name, and the agent's
 *                            snapshot refs (e12), for page-world.ts to reuse
 *   restoreAfterLoad()       runs once the woken page has loaded: fields,
 *                            scroll (the window's and every scrolled panel's),
 *                            focus, text selection, video and audio position.
 *                            Run again, it only does what's still left (a
 *                            page that renders late), and leaves the window
 *                            alone once something else has scrolled it
 *   rememberLoadHeight()     runs in every page: how tall it was when it
 *                            loaded, so a feed that grew as it was scrolled
 *                            can be told from a page that didn't
 *
 * Cookies, localStorage and IndexedDB need nothing here: every tab shares one
 * browser context, so they never left. Back/forward history is browser.ts's.
 *
 * What a page kept only in its own JavaScript (a menu it opened, data it
 * fetched and never put in the address or storage) can't come back: that
 * lived in the page that closed.
 *
 * Elements are found again by their path from <body> (#id where there is
 * one), which is the same on a reloaded page as long as it renders the same.
 *
 * The three functions run inside the page, so they use only what's in their
 * own body: nothing from this file's scope.
 *
 * Uses:    nothing
 * Used by: browser.ts, tab.ts
 */

/** A field the page or the agent changed from what the page's HTML says. */
export interface SavedField {
  path: string
  /** For text, textarea, contenteditable. */
  value?: string
  /** For checkboxes and radios. */
  checked?: boolean
  /** For selects: the chosen options' indexes. */
  selected?: number[]
}

export interface PageState {
  /** Where the state belongs: restored only on a page of this origin. */
  origin: string
  sessionStorage: Array<[string, string]>
  windowName: string
  scrollX: number
  scrollY: number
  /** How tall the page was, so content loaded while scrolling can be loaded again. */
  pageHeight: number
  /** It grew by more than a screen after it loaded: a feed that loads more as it's scrolled. */
  grewWhileOpen: boolean
  /** Panels scrolled inside the page: sidebars, chat lists, code views. */
  scrolled: Array<{ path: string; top: number; left: number }>
  fields: SavedField[]
  /** The focused element, and the selected text in it if it's a field. */
  focus: { path: string; selectionStart: number | null; selectionEnd: number | null } | null
  media: Array<{ path: string; time: number }>
  /** The agent's snapshot refs (page-world.ts), so e12 still means the same element after a wake. */
  refs: unknown
}

/** Runs in the page: everything a reload would lose. */
export function capturePageState(): PageState {
  /** The element's path from <body>, to find it again after a reload. */
  function pathOf(element: Element): string {
    const steps: string[] = []
    let current: Element | null = element
    while (current !== null && current !== document.body && current !== document.documentElement) {
      if (current.id !== "" && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
        steps.unshift(`#${CSS.escape(current.id)}`)
        break
      }
      const parent: Element | null = current.parentElement
      if (parent === null) {
        break
      }
      const tag = current.tagName.toLowerCase()
      let index = 1
      for (const sibling of parent.children) {
        if (sibling === current) {
          break
        }
        if (sibling.tagName === current.tagName) {
          index++
        }
      }
      steps.unshift(`${tag}:nth-of-type(${index})`)
      current = parent
    }
    if (!(steps[0] ?? "").startsWith("#")) {
      steps.unshift("body")
    }
    return steps.join(" > ")
  }

  function grewWhileOpen(): boolean {
    const loadHeight = (globalThis as unknown as { __browserheapLoadHeight?: number }).__browserheapLoadHeight
    if (loadHeight === undefined) {
      return false
    }
    return document.documentElement.scrollHeight > loadHeight + window.innerHeight
  }

  const sessionItems: Array<[string, string]> = []
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key !== null) {
        sessionItems.push([key, sessionStorage.getItem(key) ?? ""])
      }
    }
  } catch {
    // Storage the page isn't allowed to use (sandboxed, opaque origin).
  }

  const scrolled: PageState["scrolled"] = []
  const fields: SavedField[] = []
  const media: PageState["media"] = []
  for (const element of document.body?.querySelectorAll("*") ?? []) {
    if (element.scrollTop > 0 || element.scrollLeft > 0) {
      scrolled.push({ path: pathOf(element), top: element.scrollTop, left: element.scrollLeft })
    }
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked !== element.defaultChecked) {
          fields.push({ path: pathOf(element), checked: element.checked })
        }
      } else if (
        element.type !== "file" &&
        element.type !== "password" &&
        element.value !== element.defaultValue
      ) {
        fields.push({ path: pathOf(element), value: element.value })
      }
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value !== element.defaultValue) {
        fields.push({ path: pathOf(element), value: element.value })
      }
    } else if (element instanceof HTMLSelectElement) {
      const changed = [...element.options].some((option) => option.selected !== option.defaultSelected)
      if (changed) {
        const selected: number[] = []
        for (const option of element.options) {
          if (option.selected) {
            selected.push(option.index)
          }
        }
        fields.push({ path: pathOf(element), selected })
      }
    } else if (element instanceof HTMLMediaElement) {
      if (element.currentTime > 0) {
        media.push({ path: pathOf(element), time: element.currentTime })
      }
    }
  }

  let focus: PageState["focus"] = null
  const active = document.activeElement
  if (active !== null && active !== document.body && active !== document.documentElement) {
    let selectionStart: number | null = null
    let selectionEnd: number | null = null
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      try {
        selectionStart = active.selectionStart
        selectionEnd = active.selectionEnd
      } catch {
        // Inputs like type=number have no selection.
      }
    }
    focus = { path: pathOf(active), selectionStart, selectionEnd }
  }

  return {
    origin: location.origin,
    sessionStorage: sessionItems,
    windowName: window.name,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    pageHeight: document.documentElement.scrollHeight,
    grewWhileOpen: grewWhileOpen(),
    scrolled,
    fields,
    focus,
    media,
    refs:
      (
        globalThis as unknown as { __browserheap?: { exportRefs?: () => unknown } }
      ).__browserheap?.exportRefs?.() ?? null,
  }
}

/** Runs in the woken page before its own scripts, so they find their storage as they left it. */
export function restoreBeforeScripts(state: {
  origin: string
  sessionStorage: Array<[string, string]>
  windowName: string
  refs: unknown
}): void {
  if (location.origin !== state.origin) {
    return
  }
  if (state.refs !== null) {
    ;(globalThis as unknown as { __browserheapCarriedRefs?: unknown }).__browserheapCarriedRefs = state.refs
  }
  try {
    for (const [key, value] of state.sessionStorage) {
      sessionStorage.setItem(key, value)
    }
  } catch {
    // Storage the page isn't allowed to use.
  }
  window.name = state.windowName
}

/** What restoreAfterLoad couldn't do yet. */
export interface RestoreLeft {
  /** Saved things not on the page yet. */
  missing: number
  /** The window isn't scrolled to where it was yet (the page is still too short), and nothing else has scrolled it. */
  scrollPending: boolean
}

/**
 * Runs once the woken page has loaded: puts fields, scroll, focus and media
 * back. Run again, it only does what's still left, and only moves the window
 * if nothing else has since (the agent may already be scrolling). Says
 * what's left, so the caller can try again a moment later.
 */
export function restoreAfterLoad(state: PageState): RestoreLeft {
  // What's done so far, kept in the page between runs.
  const holder = globalThis as unknown as {
    __browserheapRestore?: { done: Set<string>; scrolledTo: number | null }
  }
  holder.__browserheapRestore ??= { done: new Set(), scrolledTo: null }
  const memo = holder.__browserheapRestore
  let missing = 0
  const find = (path: string): Element | null => {
    try {
      return document.querySelector(path)
    } catch {
      return null
    }
  }

  for (const field of state.fields) {
    if (memo.done.has(`field ${field.path}`)) {
      continue
    }
    const element = find(field.path)
    if (element === null) {
      missing++
      continue
    }
    if (element instanceof HTMLInputElement && field.checked !== undefined) {
      element.checked = field.checked
    } else if (element instanceof HTMLSelectElement && field.selected !== undefined) {
      for (const option of element.options) {
        option.selected = field.selected.includes(option.index)
      }
    } else if (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      field.value !== undefined
    ) {
      // The prototype's setter, so pages built on React and the like see the change too.
      const prototype =
        element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, field.value)
    } else {
      memo.done.add(`field ${field.path}`)
      continue
    }
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    memo.done.add(`field ${field.path}`)
  }

  for (const panel of state.scrolled) {
    if (memo.done.has(`panel ${panel.path}`)) {
      continue
    }
    const element = find(panel.path)
    if (element === null) {
      missing++
      continue
    }
    element.scrollTop = panel.top
    element.scrollLeft = panel.left
    // Done once it's really there: a panel still filling in can't scroll that far yet.
    if (Math.abs(element.scrollTop - panel.top) <= 2) {
      memo.done.add(`panel ${panel.path}`)
    } else {
      missing++
    }
  }

  for (const saved of state.media) {
    if (memo.done.has(`media ${saved.path}`)) {
      continue
    }
    const element = find(saved.path)
    if (element instanceof HTMLMediaElement) {
      element.currentTime = saved.time
      memo.done.add(`media ${saved.path}`)
    } else {
      missing++
    }
  }

  // The window: the first time, and again only while it's where we left it.
  let scrollPending = false
  const untouched = memo.scrolledTo === null || Math.abs(window.scrollY - memo.scrolledTo) <= 2
  if (untouched) {
    window.scrollTo(state.scrollX, state.scrollY)
    memo.scrolledTo = window.scrollY
    scrollPending = Math.abs(window.scrollY - state.scrollY) > 2
  }

  // Focus, unless something else has the focus by now.
  const nothingFocused = document.activeElement === null || document.activeElement === document.body
  if (state.focus !== null && !memo.done.has("focus") && nothingFocused) {
    const element = find(state.focus.path)
    if (element instanceof HTMLElement) {
      element.focus({ preventScroll: true })
      const { selectionStart, selectionEnd } = state.focus
      if (
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        selectionStart !== null &&
        selectionEnd !== null
      ) {
        try {
          element.setSelectionRange(selectionStart, selectionEnd)
        } catch {
          // Inputs like type=number have no selection.
        }
      }
      memo.done.add("focus")
    } else {
      missing++
    }
  }
  return { missing, scrollPending }
}

/** Runs in every page before its own scripts: remembers how tall the page was when it loaded. */
export function rememberLoadHeight(): void {
  addEventListener("load", () => {
    const holder = globalThis as unknown as { __browserheapLoadHeight?: number }
    holder.__browserheapLoadHeight = document.documentElement.scrollHeight
  })
}
