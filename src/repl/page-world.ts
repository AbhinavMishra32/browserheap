/**
 * What we put inside every page (and frame) the agent uses: the snapshot
 * engine, the ref registry, and the DOM-quiet monitor. It lives in the page
 * as `globalThis.__browserheap`.
 *
 *   __browserheap.snapshot({ interactive, showHidden, ref, selector, refPrefix })   → { tree, error? }
 *   __browserheap.deref("e12")         the element behind a ref (selector engine "tabref" uses it)
 *   __browserheap.refOf(element)       an element's ref, if it has one (to place iframes in the tree)
 *   __browserheap.watchMutations()     start counting DOM changes; __browserheap.readMutations() → { mutations, nodes }
 *   __browserheap.probe()              is the page usable yet? { bodyExists, interactiveCount, landmarkCount, textChars }
 *
 * The snapshot is a compact accessibility tree, in the same shape as Aside's
 * (Asidewright), which puts what matters first:
 *
 *   - title: "Example" [url=https://example.com/]        (added by snapshot.ts)
 *   - navigation "Sections":
 *     - link "Pricing" [ref=e4]
 *   - heading "Plans" [ref=e7] [level=2]
 *   - textbox "Email" [ref=e9] [placeholder="you@example.com"]
 *   - generic [ref=e12] cursor:pointer: "Show more"
 *
 *   refs        only on what can be acted on or read: interactive elements (by tag, role,
 *               onclick, tabindex, contenteditable, or a cursor:pointer of their own),
 *               scrollables, canvases, iframes, and named headings and content
 *   collapsing  wrappers with no name and no ref disappear; a generic holding one ref'd child
 *               becomes that child; short text leaves merge into their parent's name;
 *               paragraphs become plain text
 *   included    off-screen elements (no scrolling to read), select options, checked, disabled,
 *               focused, placeholder, scrollable, hidden (with showHidden)
 *   redacted    passwords and card numbers in fields
 *
 * A ref (e12) stays the same across snapshots while the element keeps its role
 * and name. Each ref also remembers its role, name and place among elements
 * with both the same, so when a page re-renders the element, deref finds its
 * replacement.
 *
 * This is one self-contained function: it's sent to the page as source text
 * (pageWorld.toString()), so it can't use anything from outside itself.
 *
 * Uses:    nothing (runs in the page)
 * Used by: snapshot.ts, settle.ts, agent-page.ts
 * Built:   in O first (5.6), copied into browserheap
 */
export function pageWorld(): void {
  const g = globalThis as unknown as { __browserheap?: unknown }
  if (g.__browserheap !== undefined) {
    return
  }

  // --- What things are ---------------------------------------------------------

  const SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "meta",
    "link",
    "head",
    "title",
    "base",
  ])
  const INTERACTIVE_TAGS = new Set([
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "details",
    "summary",
    "option",
  ])
  const LANDMARK_TAGS = new Set(["nav", "main", "header", "footer", "aside", "form", "dialog"])
  /** Roles that get a ref whatever their name. */
  const INTERACTIVE_REF_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "treeitem",
  ])
  /** Roles that get a ref when they have a name. */
  const CONTENT_REF_ROLES = new Set([
    "heading",
    "img",
    "cell",
    "columnheader",
    "rowheader",
    "dialog",
    "alertdialog",
    "alert",
    "listitem",
    "article",
    "region",
    "figure",
  ])
  /** Roles whose name comes from their text. */
  const NAME_FROM_CONTENT = new Set([
    "button",
    "link",
    "heading",
    "cell",
    "columnheader",
    "rowheader",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "treeitem",
    "checkbox",
    "radio",
    "switch",
    "tooltip",
    "label",
    "legend",
    "caption",
  ])
  const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"])

  const REF_KEY = Symbol.for("o.ref")

  interface RefMeta {
    role: string
    name: string
    nth: number
  }

  interface SnapNode {
    role: string
    name: string
    ref?: string
    level?: number
    hidden?: boolean
    scrollable?: boolean
    checked?: boolean
    selected?: boolean
    focused?: boolean
    disabled?: boolean
    placeholder?: string
    size?: string
    hints: string[]
    element?: Element
    children: Array<SnapNode | string>
  }

  interface SnapshotOptions {
    interactive?: boolean
    showHidden?: boolean
    ref?: string
    selector?: string
    refPrefix?: string
    maxDepth?: number
  }

  const registry = new Map<string, Element>()
  let lastRefs: Record<string, RefMeta> = {}
  let refCounter = 0

  function tagOf(element: Element): string {
    return element.tagName.toLowerCase()
  }

  function style(element: Element): CSSStyleDeclaration {
    return window.getComputedStyle(element)
  }

  function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim()
  }

  function explicitRole(element: Element): string | null {
    const role = element.getAttribute("role")
    if (role === null) {
      return null
    }
    const first = role.trim().split(/\s+/)[0]
    return first === undefined || first === "" ? null : first.toLowerCase()
  }

  function inputRole(input: HTMLInputElement): string {
    const type = (input.getAttribute("type") ?? "text").toLowerCase()
    if (type === "checkbox") return "checkbox"
    if (type === "radio") return "radio"
    if (type === "range") return "slider"
    if (type === "number") return "spinbutton"
    if (type === "search") return input.hasAttribute("list") ? "combobox" : "searchbox"
    if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button"
    if (type === "hidden") return "generic"
    if (input.hasAttribute("list")) return "combobox"
    return "textbox"
  }

  function isInsideSectioning(element: Element): boolean {
    return element.parentElement?.closest("article, aside, main, nav, section") != null
  }

  function implicitRole(element: Element): string {
    const tag = tagOf(element)
    switch (tag) {
      case "a":
      case "area":
        return element.hasAttribute("href") ? "link" : "generic"
      case "button":
        return "button"
      case "input":
        return inputRole(element as HTMLInputElement)
      case "textarea":
        return "textbox"
      case "select": {
        const select = element as HTMLSelectElement
        return select.multiple || select.size > 1 ? "listbox" : "combobox"
      }
      case "option":
        return "option"
      case "img":
        return element.getAttribute("alt") === "" ? "presentation" : "img"
      case "svg":
        return "img"
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading"
      case "nav":
        return "navigation"
      case "main":
        return "main"
      case "header":
        return isInsideSectioning(element) ? "generic" : "banner"
      case "footer":
        return isInsideSectioning(element) ? "generic" : "contentinfo"
      case "aside":
        return "complementary"
      case "form":
        return "form"
      case "section":
        return element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")
          ? "region"
          : "generic"
      case "article":
        return "article"
      case "ul":
      case "ol":
      case "menu":
        return "list"
      case "li":
        return "listitem"
      case "dl":
        return "list"
      case "dt":
        return "term"
      case "dd":
        return "definition"
      case "table":
        return "table"
      case "thead":
      case "tbody":
      case "tfoot":
        return "rowgroup"
      case "tr":
        return "row"
      case "td":
        return "cell"
      case "th":
        return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader"
      case "caption":
        return "caption"
      case "dialog":
        return "dialog"
      case "p":
        return "paragraph"
      case "label":
        return "label"
      case "legend":
        return "legend"
      case "fieldset":
        return "group"
      case "details":
        return "group"
      case "summary":
        return "button"
      case "iframe":
        return "iframe"
      case "canvas":
        return "canvas"
      case "progress":
        return "progressbar"
      case "meter":
        return "meter"
      case "hr":
        return "separator"
      case "blockquote":
        return "blockquote"
      case "figure":
        return "figure"
      case "figcaption":
        return "caption"
      case "pre":
      case "code":
        return "code"
      case "strong":
      case "b":
        return "strong"
      case "em":
      case "i":
        return "emphasis"
      default:
        return "generic"
    }
  }

  function roleOf(element: Element): string {
    const role = explicitRole(element)
    if (role !== null && role !== "presentation" && role !== "none") {
      return role
    }
    if (role === "presentation" || role === "none") {
      return "generic"
    }
    const implicit = implicitRole(element)
    return implicit === "presentation" ? "generic" : implicit
  }

  // --- Names ---------------------------------------------------------------------

  let nameCache: Map<Element, string> | null = null

  function textOfIds(element: Element, ids: string): string {
    const parts: string[] = []
    for (const id of ids.split(/\s+/)) {
      const target = id === "" ? null : element.ownerDocument.getElementById(id)
      if (target !== null) {
        parts.push(textContentForName(target, true))
      }
    }
    return normalizeWhitespace(parts.join(" "))
  }

  function cssContent(element: Element, pseudo: "::before" | "::after"): string {
    const content = window.getComputedStyle(element, pseudo).content
    if (content === "none" || content === "normal" || content === "") {
      return ""
    }
    const quoted = content.match(/^"(.*)"$/)
    return quoted?.[1] ?? ""
  }

  /** The text a name is made of: the element's own text, with its children's names. */
  function textContentForName(element: Element, includeHidden: boolean): string {
    const parts: string[] = [cssContent(element, "::before")]
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.nodeValue ?? "")
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue
      }
      const childElement = child as Element
      if (SKIP_TAGS.has(tagOf(childElement))) {
        continue
      }
      if (!includeHidden && !isVisible(childElement)) {
        continue
      }
      const label = childElement.getAttribute("aria-label")
      if (label !== null && label.trim() !== "") {
        parts.push(label)
      } else if (tagOf(childElement) === "img") {
        parts.push(childElement.getAttribute("alt") ?? "")
      } else {
        parts.push(textContentForName(childElement, includeHidden))
      }
    }
    parts.push(cssContent(element, "::after"))
    return parts.join(" ")
  }

  function labelsOf(element: Element): string {
    const labels = (element as HTMLInputElement).labels
    if (labels === undefined || labels === null || labels.length === 0) {
      return ""
    }
    const parts: string[] = []
    for (const label of Array.from(labels)) {
      parts.push(textContentForName(label, false))
    }
    return normalizeWhitespace(parts.join(" "))
  }

  function computeName(element: Element): string {
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy !== null) {
      const text = textOfIds(element, labelledBy)
      if (text !== "") return text
    }
    const ariaLabel = element.getAttribute("aria-label")
    if (ariaLabel !== null && ariaLabel.trim() !== "") {
      return normalizeWhitespace(ariaLabel)
    }

    const tag = tagOf(element)
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const fromLabels = labelsOf(element)
      if (fromLabels !== "") return fromLabels
      const input = element as HTMLInputElement
      const type = (input.getAttribute("type") ?? "").toLowerCase()
      if (type === "submit" || type === "button" || type === "reset") {
        return normalizeWhitespace(
          input.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""),
        )
      }
      if (type === "image") {
        return normalizeWhitespace(input.getAttribute("alt") ?? "")
      }
      const title = element.getAttribute("title")
      if (title !== null && title.trim() !== "") return normalizeWhitespace(title)
      return ""
    }
    if (tag === "img" || tag === "area") {
      const alt = element.getAttribute("alt")
      if (alt !== null && alt.trim() !== "") return normalizeWhitespace(alt)
    }
    if (tag === "svg") {
      const title = element.querySelector(":scope > title")
      if (title !== null) return normalizeWhitespace(title.textContent ?? "")
    }
    if (tag === "fieldset") {
      const legend = element.querySelector(":scope > legend")
      if (legend !== null) return normalizeWhitespace(legend.textContent ?? "")
    }
    if (tag === "table") {
      const caption = element.querySelector(":scope > caption")
      if (caption !== null) return normalizeWhitespace(caption.textContent ?? "")
    }
    if (tag === "iframe") {
      const title = element.getAttribute("title")
      if (title !== null && title.trim() !== "") return normalizeWhitespace(title)
    }

    if (NAME_FROM_CONTENT.has(roleOf(element))) {
      const text = normalizeWhitespace(textContentForName(element, false))
      if (text !== "") return text
    }

    const title = element.getAttribute("title")
    if (title !== null && title.trim() !== "") return normalizeWhitespace(title)
    return ""
  }

  function nameOf(element: Element): string {
    if (nameCache !== null) {
      const cached = nameCache.get(element)
      if (cached !== undefined) return cached
    }
    const name = computeName(element).slice(0, 500)
    nameCache?.set(element, name)
    return name
  }

  // --- Visibility and interactivity -------------------------------------------

  let visibilityCache: Map<Element, boolean> | null = null

  function parentAcrossShadow(element: Element): Element | null {
    if (element.parentElement !== null) return element.parentElement
    const root = element.getRootNode()
    return root instanceof ShadowRoot ? root.host : null
  }

  function isVisible(element: Element): boolean {
    if (visibilityCache !== null) {
      const cached = visibilityCache.get(element)
      if (cached !== undefined) return cached
    }
    const visible = isVisibleUncached(element)
    visibilityCache?.set(element, visible)
    return visible
  }

  function isVisibleUncached(element: Element): boolean {
    if (element.getAttribute("aria-hidden") === "true") return false
    const ownVisibility = style(element).visibility
    let underContents = false
    for (
      let current: Element | null = element;
      current !== null && current !== document.documentElement;
      current = parentAcrossShadow(current)
    ) {
      const currentStyle = style(current)
      if (currentStyle.display === "contents") {
        underContents = true
        continue
      }
      if (currentStyle.display === "none") return false
      if (currentStyle.visibility === "hidden" && ownVisibility !== "visible") return false
      if (Number.parseFloat(currentStyle.opacity) === 0) return false
      const clips = currentStyle.overflow !== "visible"
      const rect = current.getBoundingClientRect()
      if (clips && (rect.width === 0 || rect.height === 0)) return false
    }
    if (typeof element.checkVisibility === "function" && !underContents) {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    }
    return true
  }

  interface Interactivity {
    interactive: boolean
    byTag: boolean
    hints: string[]
  }

  function interactivityOf(element: Element): Interactivity {
    const tag = tagOf(element)
    const role = explicitRole(element)
    const tabIndex = element.getAttribute("tabindex")
    const hasTabIndex = tabIndex !== null && tabIndex !== "-1"
    const hasOnClick = element.hasAttribute("onclick")
    const editable =
      element.getAttribute("contenteditable") === "true" || element.getAttribute("contenteditable") === ""
    const byTag = INTERACTIVE_TAGS.has(tag) && !(tag === "a" && !element.hasAttribute("href"))
    const byRole = role !== null && INTERACTIVE_REF_ROLES.has(role)

    // A pointer cursor counts only where it starts: children of a clickable
    // thing inherit it without being clickable themselves.
    let pointer = style(element).cursor === "pointer"
    if (pointer && !hasOnClick && !hasTabIndex) {
      const parent = element.parentElement
      if (parent !== null && style(parent).cursor === "pointer") pointer = false
    }

    const hints: string[] = []
    if (pointer) hints.push("cursor:pointer")
    if (hasOnClick) hints.push("onclick")
    if (hasTabIndex) hints.push("tabindex")
    return { interactive: byTag || byRole || hasOnClick || hasTabIndex || editable || pointer, byTag, hints }
  }

  function isScrollable(element: Element): boolean {
    const tag = tagOf(element)
    if (tag === "html" || tag === "body") return false
    const elementStyle = style(element)
    if (!SCROLLABLE_OVERFLOW.has(elementStyle.overflowX) && !SCROLLABLE_OVERFLOW.has(elementStyle.overflowY))
      return false
    return element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1
  }

  function isLandmark(element: Element): boolean {
    const role = explicitRole(element)
    return LANDMARK_TAGS.has(tagOf(element)) || (role !== null && role !== "presentation" && role !== "none")
  }

  // --- Field values, with secrets kept out -----------------------------------

  function passesLuhn(digits: string): boolean {
    let sum = 0
    let double = false
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = Number(digits[i])
      if (double) {
        digit *= 2
        if (digit > 9) digit -= 9
      }
      sum += digit
      double = !double
    }
    return sum % 10 === 0
  }

  function looksLikeCard(value: string): boolean {
    const digits = value.replace(/[\s-]/g, "")
    return /^\d{13,19}$/.test(digits) && passesLuhn(digits)
  }

  function looksSecret(element: Element): boolean {
    const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase()
    return /password|cc-number|cc-csc|one-time-code/.test(autocomplete)
  }

  /** What's typed in a text field, or null for anything else. Secrets come back as [redacted]. */
  function fieldValue(element: Element): string | null {
    const tag = tagOf(element)
    let value: string
    if (tag === "textarea") {
      value = (element as HTMLTextAreaElement).value
    } else if (tag === "input") {
      const input = element as HTMLInputElement
      const role = inputRole(input)
      if (role !== "textbox" && role !== "searchbox" && role !== "combobox" && role !== "spinbutton")
        return null
      if (input.type === "password") return input.value === "" ? null : "[redacted]"
      value = input.value
    } else if (
      element instanceof HTMLElement &&
      element.isContentEditable &&
      element.getAttribute("contenteditable") !== null
    ) {
      value = element.innerText
    } else {
      return null
    }
    if (value === "") return null
    if (looksSecret(element) || looksLikeCard(value)) return "[redacted]"
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  }

  // --- Building the tree ------------------------------------------------------------

  function shouldTraverse(element: Element, options: SnapshotOptions): boolean {
    const tag = tagOf(element)
    if (SKIP_TAGS.has(tag)) return false
    if (element.getAttribute("aria-hidden") === "true" && element.children.length === 0) return false
    if (!options.showHidden && !isVisible(element)) {
      // Custom checkboxes and radios often hide the real input behind a styled label.
      if (tag === "input") {
        const type = (element as HTMLInputElement).type
        if (type === "radio" || type === "checkbox") return true
      }
      return false
    }
    return true
  }

  function shouldInclude(element: Element, options: SnapshotOptions): boolean {
    const role = roleOf(element)
    if (options.interactive) {
      return (
        role === "canvas" ||
        interactivityOf(element).interactive ||
        isScrollable(element) ||
        isLandmark(element)
      )
    }
    if (interactivityOf(element).interactive) return true
    if (isScrollable(element)) return true
    if (isLandmark(element)) return true
    if (nameOf(element) !== "" && role !== "generic") return true
    return role !== "generic" && role !== "img" && role !== "strong" && role !== "emphasis" && role !== "code"
  }

  /** The element's ref, made now or kept from the last snapshot. */
  function refFor(
    element: Element,
    role: string,
    name: string,
    prefix: string,
    signatures: Map<string, number>,
  ): string {
    const signature = `${role}::${name.slice(0, 100)}`
    const nth = signatures.get(signature) ?? 0
    signatures.set(signature, nth + 1)

    const holder = element as unknown as Record<
      symbol,
      { ref: string; role: string; name: string } | undefined
    >
    const cached = holder[REF_KEY]
    let ref: string
    if (
      cached !== undefined &&
      cached.role === role &&
      cached.name === name &&
      cached.ref.startsWith(prefix)
    ) {
      ref = cached.ref
    } else {
      refCounter++
      ref = `${prefix}e${refCounter}`
      holder[REF_KEY] = { ref, role, name }
    }
    registry.set(ref, element)
    lastRefs[ref] = { role, name: name.slice(0, 100), nth }
    return ref
  }

  function levelOf(element: Element, role: string): number | undefined {
    if (role !== "heading") return undefined
    const aria = element.getAttribute("aria-level")
    if (aria !== null) return Number(aria) || undefined
    const match = tagOf(element).match(/^h([1-6])$/)
    return match ? Number(match[1]) : 2
  }

  function isChecked(element: Element, role: string): boolean {
    if (
      role !== "checkbox" &&
      role !== "radio" &&
      role !== "switch" &&
      role !== "menuitemcheckbox" &&
      role !== "menuitemradio"
    ) {
      return false
    }
    if (element instanceof HTMLInputElement) return element.checked
    return element.getAttribute("aria-checked") === "true"
  }

  function isSelected(element: Element, role: string): boolean {
    if (role === "option" && element instanceof HTMLOptionElement) return element.selected
    return element.getAttribute("aria-selected") === "true"
  }

  function isDisabled(element: Element): boolean {
    if (
      (element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLOptionElement) &&
      element.disabled
    ) {
      return true
    }
    const fieldset = element.closest("fieldset:disabled")
    if (fieldset !== null) {
      const legend = fieldset.querySelector(":scope > legend")
      if (legend === null || !legend.contains(element)) return true
    }
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      if (current.getAttribute("aria-disabled") === "true") return true
    }
    return false
  }

  function toNode(element: Element, prefix: string, signatures: Map<string, number>): SnapNode | null {
    const role = roleOf(element)
    const interactivity = interactivityOf(element)
    const name = nameOf(element)
    const hidden = !isVisible(element)
    const scrollable = isScrollable(element)
    const wantsRef =
      role === "iframe" ||
      role === "canvas" ||
      scrollable ||
      interactivity.interactive ||
      INTERACTIVE_REF_ROLES.has(role) ||
      (CONTENT_REF_ROLES.has(role) && name !== "")

    let ref: string | undefined
    if (wantsRef) {
      ref = refFor(element, role, name, prefix, signatures)
    }
    if (role === "generic" && ref === undefined && !hidden) {
      return null
    }

    const hints: string[] = []
    if (interactivity.interactive && !interactivity.byTag) {
      hints.push(...interactivity.hints)
    }
    const value = fieldValue(element)
    const rect = role === "canvas" ? element.getBoundingClientRect() : null
    const placeholder = element.getAttribute("placeholder")
    const node: SnapNode = {
      role,
      name,
      ref,
      level: levelOf(element, role),
      hidden: hidden || undefined,
      scrollable: scrollable || undefined,
      checked: isChecked(element, role) || undefined,
      selected: isSelected(element, role) || undefined,
      focused: element.ownerDocument.activeElement === element || undefined,
      disabled: isDisabled(element) || undefined,
      placeholder: placeholder ?? undefined,
      size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : undefined,
      hints,
      element,
      children: value !== null ? [value] : [],
    }
    return node
  }

  function childNodesAcrossShadow(element: Element): Node[] {
    const nodes = Array.from(element.childNodes)
    if (element.shadowRoot !== null) {
      nodes.push(...Array.from(element.shadowRoot.childNodes))
    }
    return nodes
  }

  function ownedElements(element: Element): Element[] {
    const owns = element.getAttribute("aria-owns")
    if (owns === null) return []
    const owned: Element[] = []
    for (const id of owns.split(/\s+/)) {
      const target = id === "" ? null : element.ownerDocument.getElementById(id)
      if (target !== null) owned.push(target)
    }
    return owned
  }

  function build(start: Element, options: SnapshotOptions): SnapNode {
    const root: SnapNode = { role: "fragment", name: "", hints: [], children: [] }
    const visited = new Set<Element>()
    const prefix = options.refPrefix ?? ""
    const maxDepth = options.maxDepth ?? 50
    const signatures = new Map<string, number>()

    function walk(element: Element, depth: number, parent: SnapNode): void {
      if (depth > maxDepth || visited.has(element)) return
      visited.add(element)

      const traversable = shouldTraverse(element, options)
      const isRoot = element === start && element === document.body
      if (!traversable && !isRoot) return
      const hidden = !isVisible(element)
      const include = isRoot
        ? false
        : shouldInclude(element, options) || (options.showHidden === true && hidden)

      let target = parent
      if (include) {
        const node = toNode(element, prefix, signatures)
        if (node !== null) {
          parent.children.push(node)
          target = node
        }
      }
      // In interactive mode, the text of a leaf that isn't itself included goes to its parent.
      if (!include && options.interactive && element.childNodes.length === 0) {
        const name = nameOf(element)
        if (name !== "" && target.role !== "fragment") target.children.push(name)
      }

      const before = cssContent(element, "::before")
      if (before !== "") target.children.push(before)
      const nextDepth = include ? depth + 1 : depth
      for (const child of childNodesAcrossShadow(element)) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (
            child.nodeValue &&
            target.role !== "textbox" &&
            target.role !== "searchbox" &&
            target.role !== "combobox"
          ) {
            target.children.push(child.nodeValue)
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child as Element, nextDepth, target)
        }
      }
      for (const owned of ownedElements(element)) {
        walk(owned, nextDepth, target)
      }
      const after = cssContent(element, "::after")
      if (after !== "") target.children.push(after)
    }

    walk(start, 0, root)
    return root
  }

  // --- Making it compact -------------------------------------------------------------

  function isBare(node: SnapNode): boolean {
    return (
      node.name === "" &&
      !node.level &&
      !node.hidden &&
      !node.scrollable &&
      !node.checked &&
      !node.selected &&
      !node.focused &&
      !node.disabled &&
      node.ref === undefined &&
      node.hints.length === 0 &&
      node.placeholder === undefined &&
      node.size === undefined
    )
  }

  /** Neighbouring text pieces become one string; a bare paragraph of text becomes its text. */
  function joinText(node: SnapNode): void {
    const joined: Array<SnapNode | string> = []
    let buffer: string[] = []
    const flush = () => {
      const text = normalizeWhitespace(buffer.join(" "))
      if (text !== "") joined.push(text)
      buffer = []
    }
    for (const child of node.children) {
      if (typeof child === "string") {
        buffer.push(child)
        continue
      }
      joinText(child)
      const onlyText = child.children.every((grandchild) => typeof grandchild === "string")
      if (child.role === "paragraph" && isBare(child) && onlyText) {
        buffer.push(...(child.children as string[]))
        continue
      }
      flush()
      joined.push(child)
    }
    flush()
    node.children = joined
    if (node.children.length === 1 && node.children[0] === node.name) {
      node.children = []
    }
  }

  function hasRef(children: Array<SnapNode | string>): boolean {
    for (const child of children) {
      if (typeof child === "string") continue
      if (child.ref !== undefined || hasRef(child.children)) return true
    }
    return false
  }

  /** Unnamed generic wrappers holding at most one ref'd child give way to it; hidden branches without refs go. */
  function collapse(node: SnapNode): Array<SnapNode | string> {
    const children: Array<SnapNode | string> = []
    for (const child of node.children) {
      if (typeof child === "string") {
        children.push(child)
      } else {
        children.push(...collapse(child))
      }
    }
    if (node.hidden && node.ref === undefined && !hasRef(children)) {
      return []
    }
    const first = children[0]
    const only = children.length === 1 && first !== undefined && typeof first !== "string" ? first : null
    if (node.role === "paragraph" && isBare(node) && only !== null && only.role === "paragraph") {
      return [only]
    }
    if (
      node.role === "generic" &&
      !node.hidden &&
      node.name === "" &&
      node.ref === undefined &&
      children.length <= 1 &&
      children.every((child) => typeof child !== "string" && child.ref !== undefined)
    ) {
      return children
    }
    node.children = children
    return [node]
  }

  /** A ref'd node whose few children are only short text becomes one line: `button "Save"`. */
  function mergeTextLeaves(node: SnapNode): void {
    for (const child of node.children) {
      if (typeof child !== "string") mergeTextLeaves(child)
    }
    if (node.hidden || node.ref === undefined || node.children.length === 0 || node.children.length > 3)
      return
    const texts: string[] = []
    for (const child of node.children) {
      if (typeof child === "string") {
        const text = normalizeWhitespace(child)
        if (text === "") return
        texts.push(text)
      } else if (
        (child.role === "generic" ||
          child.role === "heading" ||
          child.role === "paragraph" ||
          child.role === "label") &&
        !child.hidden &&
        child.name !== "" &&
        child.children.length === 0 &&
        child.ref === undefined
      ) {
        texts.push(child.name)
      } else {
        return
      }
    }
    const merged = normalizeWhitespace(texts.join(" "))
    if (merged === "") return
    if (node.name === "") {
      node.name = merged
      node.children = []
    } else if (node.name.replace(/\s+/g, "") === merged.replace(/\s+/g, "")) {
      node.children = []
    }
  }

  // --- Writing it out -----------------------------------------------------------------

  function quote(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  }

  function lineFor(node: SnapNode): string {
    const parts = [node.role]
    if (node.name !== "") parts.push(`"${quote(node.name)}"`)
    if (node.ref !== undefined) parts.push(`[ref=${node.ref}]`)
    if (node.level) parts.push(`[level=${node.level}]`)
    if (node.hidden) parts.push("[hidden]")
    if (node.scrollable) parts.push("[scrollable]")
    if (node.checked) parts.push("[checked]")
    if (node.disabled) parts.push("[disabled]")
    if (node.focused) parts.push("[focused]")
    if (node.selected) parts.push("[selected]")
    if (node.placeholder !== undefined) parts.push(`[placeholder="${quote(node.placeholder)}"]`)
    if (node.size !== undefined) parts.push(`[size=${node.size}]`)
    if (node.hints.length > 0) parts.push(node.hints.join(" "))
    return parts.join(" ")
  }

  function render(node: SnapNode, depth: number, lines: string[]): void {
    const isRoot = node.role === "fragment"
    const childDepth = isRoot ? depth : depth + 1
    const indent = "  ".repeat(depth)
    const childIndent = "  ".repeat(childDepth)

    if (!isRoot) {
      const isSelect = node.element instanceof HTMLSelectElement
      const texts = node.children.filter((child) => typeof child === "string")
      if (texts.length === 1 && node.children.length === 1 && !isSelect) {
        lines.push(`${indent}- ${lineFor(node)}: "${quote(normalizeWhitespace(texts[0] as string))}"`)
        return
      }
      const hasChildren = node.children.length > 0 || isSelect
      lines.push(`${indent}- ${lineFor(node)}${hasChildren ? ":" : ""}`)
      if (node.element instanceof HTMLSelectElement) {
        for (const option of Array.from(node.element.options)) {
          const text = normalizeWhitespace(option.textContent ?? "").slice(0, 100)
          let line = `${childIndent}- option`
          if (text !== "") line += ` "${quote(text)}"`
          if (option.selected) line += " (selected)"
          if (option.value !== "" && option.value !== text) line += ` value="${quote(option.value)}"`
          lines.push(line)
        }
      }
    }

    for (const child of node.children) {
      if (typeof child === "string") {
        const text = normalizeWhitespace(child)
        if (text !== "") lines.push(`${childIndent}- text: "${quote(text)}"`)
      } else {
        render(child, childDepth, lines)
      }
    }
  }

  function snapshot(options: SnapshotOptions = {}): { tree: string; error?: string } {
    nameCache = new Map()
    visibilityCache = new Map()
    try {
      let start: Element | null
      if (options.ref !== undefined) {
        start = deref(options.ref)
        if (start === null) {
          return {
            tree: "",
            error: `There's no element ${options.ref} on the page any more. Take a snapshot without "ref" to see the page now.`,
          }
        }
      } else if (options.selector !== undefined) {
        start = document.querySelector(options.selector)
        if (start === null) {
          return {
            tree: "",
            error: `Nothing matches "${options.selector}". It takes a CSS selector, like [role="dialog"], not a role name.`,
          }
        }
      } else {
        start = document.body
      }
      if (start === null) {
        return { tree: "" }
      }

      // A full snapshot starts the refs afresh; a part of the page adds to them.
      if (options.ref === undefined && options.selector === undefined) {
        registry.clear()
        lastRefs = {}
      }
      const root = build(start, options)
      joinText(root)
      collapse(root)
      mergeTextLeaves(root)
      const lines: string[] = []
      render(root, 0, lines)
      return { tree: lines.join("\n") }
    } finally {
      nameCache = null
      visibilityCache = null
    }
  }

  // --- Finding elements again ------------------------------------------------------

  /** The element behind a ref. If it was replaced, the element with the same role, name and place. */
  function deref(ref: string): Element | null {
    const element = registry.get(ref)
    if (element?.isConnected) {
      return element
    }
    const meta = lastRefs[ref]
    if (meta === undefined) {
      return null
    }
    const candidates: Element[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let visited = 0
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      visited++
      if (visited > 5000) break
      const candidate = node as Element
      if (roleOf(candidate) === meta.role && nameOf(candidate).slice(0, 100) === meta.name) {
        candidates.push(candidate)
      }
    }
    const found = candidates.length === 1 ? candidates[0] : candidates[meta.nth]
    if (found !== undefined) {
      registry.set(ref, found)
      return found
    }
    return null
  }

  function refOf(element: Element): string | null {
    const holder = element as unknown as Record<symbol, { ref: string } | undefined>
    return holder[REF_KEY]?.ref ?? null
  }

  // --- Is the page ready, has it stopped changing ------------------------------

  let mutations = 0
  let observer: MutationObserver | null = null

  function watchMutations(): void {
    if (observer !== null) return
    observer = new MutationObserver((records) => {
      mutations += records.length
    })
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  }

  function readMutations(): { mutations: number; nodes: number } {
    const counted = mutations
    mutations = 0
    return { mutations: counted, nodes: Math.max(1, document.getElementsByTagName("*").length) }
  }

  function probe(): {
    bodyExists: boolean
    interactiveCount: number
    landmarkCount: number
    textChars: number
  } {
    const body = document.body
    if (body === null) {
      return { bodyExists: false, interactiveCount: 0, landmarkCount: 0, textChars: 0 }
    }
    return {
      bodyExists: true,
      interactiveCount: body.querySelectorAll(
        "a[href], button, input, select, textarea, [role=button], [role=link], [tabindex]",
      ).length,
      landmarkCount: body.querySelectorAll("main, nav, header, footer, [role]").length,
      textChars: (body.innerText ?? "").trim().length,
    }
  }

  // --- Labels for annotatedScreenshot -----------------------------------------------

  const OVERLAY_ID = "__browserheap-annotations"

  /** Draws each ref from the last snapshot on its element, where it's in view. Returns how many. */
  function annotate(): number {
    unannotate()
    const overlay = document.createElement("div")
    overlay.id = OVERLAY_ID
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
    let drawn = 0
    for (const [ref, element] of registry) {
      if (!element.isConnected) continue
      const rect = element.getBoundingClientRect()
      if (
        rect.width === 0 ||
        rect.height === 0 ||
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.top > innerHeight ||
        rect.left > innerWidth
      ) {
        continue
      }
      const box = document.createElement("div")
      box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid #e8590c;outline-offset:-1px`
      const label = document.createElement("div")
      label.textContent = ref
      label.style.cssText = `position:fixed;left:${Math.max(0, rect.left)}px;top:${Math.max(0, rect.top - 14)}px;background:#e8590c;color:#fff;font:600 10px/14px monospace;padding:0 3px;border-radius:2px`
      overlay.append(box, label)
      drawn++
    }
    document.documentElement.append(overlay)
    return drawn
  }

  function unannotate(): void {
    document.getElementById(OVERLAY_ID)?.remove()
  }

  g.__browserheap = { snapshot, deref, refOf, watchMutations, readMutations, probe, annotate, unannotate }
}
