/**
 * snapshot(page): the agent's main way of reading a page, as Aside's.
 *
 *   const s1 = await snapshot(page)                       { tree, diff }
 *   const s2 = await snapshot(page, { interactive: true }) only what can be clicked, typed in, scrolled
 *   await snapshot(page, { ref: "e31" })                   one part of the page
 *   await snapshot(page, { selector: '[role="dialog"]' })
 *
 *   tree   a header, then the page as a compact accessibility tree (page-world.ts):
 *            - title: "Example" [url=https://example.com/]
 *            - heading "Plans" [ref=e7] [level=2]
 *          iframes are inside it, under their `iframe [ref=…]` line, with refs of their own (f1e3)
 *   diff   what changed since this tab's previous snapshot, as unified diff hunks; the whole
 *          tree when that's shorter. After an action the agent reads the diff, not the page again.
 *
 * Refs are Playwright selectors too: page.locator("e12") (agent-page.ts) is
 * page.locator("tabref=e12"), and the "tabref" engine asks the page's __agentTabs.deref.
 *
 * Uses:    page-world.ts, playwright-core (selectors, Frame), diff
 * Used by: agent-page.ts, repl.ts
 * Built:   in O first (5.6), copied into agent-tabs
 */
import { structuredPatch } from "diff"
import { type Frame, type Page, selectors } from "playwright-core"
import { pageWorld } from "./page-world.ts"

export interface SnapshotOptions {
  /** Only interactive elements (clickable, focusable, scrollable) and landmarks. */
  interactive?: boolean
  /** Hidden elements too (a collapsed menu, aria-hidden). */
  showHidden?: boolean
  /** Only the part of the page under this ref. */
  ref?: string
  /** Only the part of the page under this CSS selector. */
  selector?: string
}

export interface Snapshot {
  tree: string
  diff: string
}

const WORLD_SOURCE = `(${pageWorld.toString()})()`

/** Each page's frames by number (f1, f2…), and its last tree, for the diff. */
interface PageMemory {
  frames: Map<Frame, number>
  lastTree: string
}

const memory = new WeakMap<Page, PageMemory>()

function memoryOf(page: Page): PageMemory {
  let remembered = memory.get(page)
  if (remembered === undefined) {
    remembered = { frames: new Map(), lastTree: "" }
    memory.set(page, remembered)
  }
  return remembered
}

let registering: Promise<void> | null = null

/**
 * Makes "tabref=e12" a Playwright selector. Must happen before the browser
 * starts; once is enough (it's for the whole program).
 */
export function registerRefSelector(): Promise<void> {
  if (registering === null) {
    registering = selectors.register(
      "tabref",
      `({
        query(root, ref) { return globalThis.__agentTabs ? globalThis.__agentTabs.deref(ref) : null },
        queryAll(root, ref) { const el = globalThis.__agentTabs ? globalThis.__agentTabs.deref(ref) : null; return el ? [el] : [] },
      })`,
    )
  }
  return registering
}

/** Puts page-world.ts into a frame, if it isn't there yet. */
export async function ensureWorld(frame: Frame): Promise<void> {
  await frame.evaluate(WORLD_SOURCE)
}

/** Is this a ref, like e12 or f1e3? */
export function isRef(text: string): boolean {
  return /^(f\d+)?e\d+$/.test(text)
}

/** The frame a ref belongs to: f1e3 → frame 1, e12 → the main frame. */
export function frameOfRef(page: Page, ref: string): Frame {
  const match = ref.match(/^f(\d+)e\d+$/)
  if (match === null) {
    return page.mainFrame()
  }
  const wanted = Number(match[1])
  for (const [frame, number] of memoryOf(page).frames) {
    if (number === wanted && !frame.isDetached()) {
      return frame
    }
  }
  throw new Error(`The frame of ${ref} is gone. Take a new snapshot.`)
}

export async function snapshot(page: Page, options: SnapshotOptions = {}): Promise<Snapshot> {
  const remembered = memoryOf(page)

  let body: string
  if (options.ref !== undefined) {
    body = await frameTree(frameOfRef(page, options.ref), options, prefixOf(options.ref))
  } else if (options.selector !== undefined) {
    body = await frameTree(page.mainFrame(), options, "")
  } else {
    body = await treeWithFrames(page, page.mainFrame(), options, "", remembered)
  }

  const title = await page.title().catch(() => "")
  const header: string[] = []
  if (options.interactive) header.push("# note: interactive (clickable / focusable) elements only.")
  if (options.showHidden) header.push("# note: hidden elements are shown.")
  header.push(`- title: "${title.replace(/"/g, '\\"')}" [url=${shortUrl(page.url())}]`)
  const tree = [...header, body].filter((part) => part !== "").join("\n")

  const diff = diffOf(remembered.lastTree, body)
  remembered.lastTree = body
  return { tree, diff: diff.length > tree.length ? tree : diff }
}

/** One frame's tree, from its page-world. */
async function frameTree(frame: Frame, options: SnapshotOptions, refPrefix: string): Promise<string> {
  await ensureWorld(frame)
  const result = await frame.evaluate(
    (args) => {
      const world = (
        globalThis as unknown as { __agentTabs: { snapshot(o: unknown): { tree: string; error?: string } } }
      ).__agentTabs
      return world.snapshot(args)
    },
    { ...options, refPrefix },
  )
  if (result.error !== undefined) {
    throw new Error(result.error)
  }
  return result.tree
}

/** A frame's tree with its child frames' trees put in, under their iframe lines. */
async function treeWithFrames(
  page: Page,
  frame: Frame,
  options: SnapshotOptions,
  refPrefix: string,
  remembered: PageMemory,
): Promise<string> {
  const tree = await frameTree(frame, options, refPrefix)
  let lines = tree === "" ? [] : tree.split("\n")

  for (const child of frame.childFrames()) {
    if (child.isDetached()) {
      continue
    }
    try {
      const iframeRef = await refOfFrameElement(child)
      if (iframeRef === null) {
        continue
      }
      let number = remembered.frames.get(child)
      if (number === undefined) {
        number = remembered.frames.size + 1
        remembered.frames.set(child, number)
      }
      const childTree = await treeWithFrames(page, child, options, `f${number}`, remembered)
      lines = placeUnder(lines, iframeRef, childTree)
    } catch {
      // A frame that navigated or closed meanwhile: leave it out.
    }
  }
  return lines.join("\n")
}

/** The ref the parent frame gave this frame's <iframe>. */
async function refOfFrameElement(frame: Frame): Promise<string | null> {
  const element = await frame.frameElement()
  try {
    return await element.evaluate((node) => {
      const world = (globalThis as unknown as { __agentTabs?: { refOf(e: Element): string | null } })
        .__agentTabs
      return world ? world.refOf(node as Element) : null
    })
  } finally {
    await element.dispose()
  }
}

/** Puts `child` under the line holding `[ref=<ref>]`, one level deeper. */
function placeUnder(lines: string[], ref: string, child: string): string[] {
  if (child === "") {
    return lines
  }
  const index = lines.findIndex((line) => line.includes(`[ref=${ref}]`))
  if (index === -1) {
    return lines
  }
  const line = lines[index] as string
  const indent = `${line.match(/^\s*/)?.[0] ?? ""}  `
  const childLines = child.split("\n").map((childLine) => indent + childLine)
  const opened = line.endsWith(":") ? line : `${line}:`
  return [...lines.slice(0, index), opened, ...childLines, ...lines.slice(index + 1)]
}

function prefixOf(ref: string): string {
  return ref.match(/^(f\d+)e\d+$/)?.[1] ?? ""
}

/**
 * What changed between two trees, as unified diff hunks without context:
 *
 *   @@ -4 +4,2 @@
 *   -  - button "Save" [ref=e9]
 *   +  - button "Saved" [ref=e9] [disabled]
 *   +  - status: "Your changes are saved"
 */
export function diffOf(before: string, after: string): string {
  const patch = structuredPatch("", "", `${before.trim()}\n`, `${after.trim()}\n`, "", "", { context: 0 })
  if (patch.hunks.length === 0) {
    return "No changes detected\n"
  }
  const out: string[] = []
  for (const hunk of patch.hunks) {
    out.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`)
    for (const line of hunk.lines) {
      if (!line.startsWith("\\")) {
        out.push(line)
      }
    }
  }
  return `${out.join("\n")}\n`
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}

/** A URL short enough to read: tracking parameters off, at most 128 characters. */
export function shortUrl(url: string): string {
  let shown = url
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|_ga)/.test(key)) {
        parsed.searchParams.delete(key)
      }
    }
    shown = parsed.toString()
  } catch {
    // Not a URL we can read: show it as it is.
  }
  return shown.length > 128 ? `${shown.slice(0, 127)}…` : shown
}
