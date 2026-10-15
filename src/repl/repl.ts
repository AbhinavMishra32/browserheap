/**
 * The agent's JavaScript REPL: Playwright-style code, run in a QuickJS sandbox,
 * one per agent session, the way Aside's is.
 *
 *   const repl = await Repl.start(host)
 *   await repl.run(`const s1 = await snapshot(page); console.log(s1.tree)`, signal)
 *     → { content: [{ type: "text", text: "- title: …" }] }
 *   await repl.run(`await page.locator('e3').click(); console.log((await snapshot(page)).diff)`, signal)
 *
 * What the code has (and nothing else: no Node, no modules, no network):
 *
 *   page, tabs                    the session's current tab and all its tabs (AgentPage)
 *   openTab(url), closeTab(tab)   tabs come and go only through these
 *   snapshot(page, options?)      the page as a tree with refs, and what changed (snapshot.ts)
 *   annotatedScreenshot(page)     a screenshot with each ref drawn on its element
 *   console.log(…)                what the agent reads back
 *   display(image)                an image for the model to look at (bytes, base64, or a data: URL)
 *   sleep(ms)
 *   URL, URLSearchParams
 *
 * One scope for the whole session: what one call declares, the next can use
 * (prepare-code.ts). A call runs for at most 120 s, and Stop ends it. What it
 * prints is capped at 16 KB; images always come back.
 *
 * The sandbox: QuickJS, a separate JavaScript engine compiled to WebAssembly,
 * with its own memory (128 MB at most). The code there can only reach what's
 * handed in. Host objects (AgentPage, AgentLocator, URL) appear as proxies
 * whose calls come back here; "constructor", "__proto__" and "prototype" are
 * blocked on them, since those lead to the host's Function. Values cross by
 * copy: strings, numbers, arrays, plain objects, bytes (Uint8Array), dates,
 * errors; host promises become sandbox promises; a function passed to
 * page.evaluate() crosses as its source text.
 *
 * Uses:    quickjs-emscripten-core, @jitl/quickjs-wasmfile-release-sync, prepare-code.ts,
 *          snapshot.ts, agent-page.ts
 * Used by: session.ts
 * Built:   in O first (5.6), copied into browserheap
 */
import { inspect } from "node:util"
import variant from "@jitl/quickjs-wasmfile-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core"
import { AgentPage } from "./agent-page.ts"
import { CodeError, prepareCode } from "./prepare-code.ts"
import { type SnapshotOptions, snapshot } from "./snapshot.ts"

/** What a REPL call gives back: text it printed, and images it displayed. */
export type ReplPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }

export const REPL_TIMEOUT_MS = 120_000
/** The most text the agent reads back from one call. Images always come through. */
export const REPL_OUTPUT_MAX_BYTES = 16_384
const TRUNCATED = "\n... [REPL output truncated for context. Save less, or print a part.]"
const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024

const SLICE_WARNING = /tree\.(substring|slice|split)\s*\(/

/** What the REPL needs from its session's browser. */
export interface ReplHost {
  /** The tab the agent is on, or null when it has none. */
  currentPage(): AgentPage | null
  tabs(): AgentPage[]
  openTab(url: string): Promise<AgentPage>
  closeTab(tab: AgentPage): Promise<void>
  /** A screenshot of the current viewport with each ref drawn on its element. */
  annotatedScreenshot(page: AgentPage): Promise<Buffer>
}

export interface ReplResult {
  content: ReplPart[]
  /** Set when the code threw, timed out or was stopped; `content` is what it printed before. */
  error?: string
}

let quickjs: Promise<QuickJSWASMModule> | null = null

function loadQuickJS(): Promise<QuickJSWASMModule> {
  quickjs ??= newQuickJSWASMModuleFromVariant(variant)
  return quickjs
}

/**
 * The sandbox's side of the bridge: proxies for host objects, and telling
 * values apart. It runs once, inside QuickJS, with `host` (the functions
 * below) and leaves `__bridge` behind for the host to call.
 */
const PRELUDE = `(host) => {
  const REF = Symbol("ref")
  const BLOCKED = new Set(["constructor", "__proto__", "prototype"])
  const blocked = (key) => typeof key === "symbol" || BLOCKED.has(key)
  const proxies = new Map()

  function ref(id, isFunction) {
    const known = proxies.get(id)
    if (known) return known
    const target = isFunction ? function () {} : {}
    const proxy = new Proxy(target, {
      get(_, key) {
        if (key === REF) return id
        if (key === Symbol.iterator) return () => host.items(id)[Symbol.iterator]()
        if (blocked(key)) return undefined
        return host.get(id, key)
      },
      set: () => false,
      has: (_, key) => !blocked(key) && host.has(id, key),
      deleteProperty: () => false,
      ownKeys: () => (isFunction ? [...host.keys(id), "prototype"] : host.keys(id)),
      getOwnPropertyDescriptor(t, key) {
        if (isFunction && key === "prototype") return Reflect.getOwnPropertyDescriptor(t, key)
        if (blocked(key) || !host.has(id, key)) return undefined
        return { value: host.get(id, key), writable: false, enumerable: true, configurable: true }
      },
      apply: (_, self, args) => host.apply(id, self && self[REF] !== undefined ? self[REF] : -1, args),
      construct: (_, args) => host.construct(id, args),
    })
    proxies.set(id, proxy)
    return proxy
  }

  function kind(value) {
    if (value === null) return "null"
    if (value[REF] !== undefined) return "ref:" + value[REF]
    if (Array.isArray(value)) return "array"
    if (value instanceof Promise) return "promise"
    if (ArrayBuffer.isView(value)) return "bytes"
    if (value instanceof ArrayBuffer) return "arraybuffer"
    if (value instanceof Date) return "date"
    if (value instanceof RegExp) return "regexp"
    if (value instanceof Error) return "error"
    if (typeof value === "function") return "function"
    return "object"
  }

  globalThis.__bridge = {
    ref,
    kind,
    keys: (value) => Object.keys(value),
    source: (fn) => String(fn),
    bytes: (buffer) => new Uint8Array(buffer),
    bytesOf: (view) => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    date: (ms) => new Date(ms),
    regexp: (source, flags) => new RegExp(source, flags),
    regexpParts: (value) => [value.source, value.flags],
  }
  Object.defineProperty(globalThis, "page", { get: () => host.page(), enumerable: true })
  Object.defineProperty(globalThis, "tabs", { get: () => host.tabs(), enumerable: true })
}`

export class Repl {
  private runtime: QuickJSRuntime
  private ctx: QuickJSContext
  private host: ReplHost
  /** Host values the sandbox holds proxies for, by id. */
  private refs = new Map<number, unknown>()
  private refIds = new Map<unknown, number>()
  /** Methods read off host objects, bound, so each object's method is one proxy. */
  private boundMethods = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>()
  private bridge: Record<string, QuickJSHandle> = {}
  /** The call running now: what it printed, and its end. */
  private outputs: ReplPart[] = []
  private running: AbortController | null = null
  private disposed = false

  private constructor(runtime: QuickJSRuntime, host: ReplHost) {
    this.runtime = runtime
    this.ctx = runtime.newContext()
    this.host = host
    this.installBridge()
    this.installGlobals()
  }

  static async start(host: ReplHost): Promise<Repl> {
    const module = await loadQuickJS()
    const runtime = module.newRuntime()
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES)
    runtime.setMaxStackSize(1024 * 1024)
    return new Repl(runtime, host)
  }

  /** Runs one call's code. Never throws: failures come back as `error`. */
  async run(code: string, signal: AbortSignal): Promise<ReplResult> {
    if (this.disposed) {
      return { content: [], error: "This browser was closed. Run the code again." }
    }
    this.outputs = []
    const running = new AbortController()
    this.running = running
    if (SLICE_WARNING.test(code)) {
      this.print(
        "[system][warning] DO NOT USE tree.slice()/substring()/split() - you're hiding important context from the snapshot. Print the full tree or the diff.",
      )
    }

    let script: string
    try {
      script = prepareCode(code)
    } catch (error) {
      return { content: [], error: error instanceof CodeError ? error.message : String(error) }
    }

    const deadline = Date.now() + REPL_TIMEOUT_MS
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => running.abort(new Error("Stopped."))
    signal.addEventListener("abort", onAbort)

    try {
      const evaluated = this.ctx.evalCode(script, "repl.js")
      if (evaluated.error) {
        throw this.toHostError(evaluated.error)
      }
      const settled = this.ctx.resolvePromise(evaluated.value)
      evaluated.value.dispose()
      this.pump()

      const ended = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            running.abort(new Error(`Timed out after ${REPL_TIMEOUT_MS / 1000} s.`))
          },
          Math.max(0, deadline - Date.now()),
        )
        running.signal.addEventListener("abort", () => reject(running.signal.reason))
      })
      const outcome = await Promise.race([settled, ended])
      if (outcome.error) {
        throw this.toHostError(outcome.error)
      }
      outcome.value.dispose()
      return { content: capOutput(this.outputs) }
    } catch (error) {
      const message = errorText(error)
      const shown = code.length > 120 ? `${code.slice(0, 120)}…` : code
      const stopped = running.signal.aborted ? `\n[stopped while running: ${shown}]` : ""
      return { content: capOutput(this.outputs), error: message + stopped }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      // Anything still pending from this call is dropped: it can't act after the call ended.
      running.abort(new Error("The call ended."))
      this.running = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.running?.abort(new Error("The browser closed."))
    try {
      for (const handle of Object.values(this.bridge)) handle.dispose()
      this.ctx.dispose()
      this.runtime.dispose()
    } catch {
      // QuickJS complains about handles still held by pending promises; the memory goes with it anyway.
    }
    this.refs.clear()
    this.refIds.clear()
  }

  // --- Globals -------------------------------------------------------------------

  private installGlobals(): void {
    this.setGlobal(
      "console",
      this.hostObject({
        log: (...values: unknown[]) => this.print(values.map(formatValue).join(" ")),
        info: (...values: unknown[]) => this.print(values.map(formatValue).join(" ")),
        warn: (...values: unknown[]) => this.print(values.map(formatValue).join(" ")),
        error: (...values: unknown[]) => this.print(values.map(formatValue).join(" ")),
      }),
    )
    this.setGlobalFunction("display", (input: unknown) => {
      this.outputs.push(imageOf(input))
    })
    this.setGlobalFunction("sleep", (ms: unknown) =>
      this.guarded(() => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0))),
    )
    this.setGlobalFunction("snapshot", (page: unknown, options?: unknown) =>
      this.guarded(async () =>
        snapshot(await AgentPage.unwrap(asPage(page)), (options ?? {}) as SnapshotOptions),
      ),
    )
    this.setGlobalFunction("annotatedScreenshot", (page: unknown) =>
      this.guarded(async () => ({
        base64Image: (await this.host.annotatedScreenshot(asPage(page))).toString("base64"),
      })),
    )
    this.setGlobalFunction("openTab", (url: unknown) => this.guarded(() => this.host.openTab(String(url))))
    this.setGlobalFunction("closeTab", (tab: unknown) => this.guarded(() => this.host.closeTab(asPage(tab))))
    this.setGlobal("URL", this.toGuest(URL))
    this.setGlobal("URLSearchParams", this.toGuest(URLSearchParams))
  }

  private print(text: string): void {
    this.outputs.push({ type: "text", text })
  }

  /** Host work for the running call; refused once that call has ended. */
  private guarded<T>(work: () => Promise<T>): Promise<T> {
    const running = this.running
    if (running === null || running.signal.aborted) {
      return Promise.reject(new Error("This call has ended."))
    }
    return work()
  }

  private setGlobal(name: string, value: QuickJSHandle): void {
    this.ctx.setProp(this.ctx.global, name, value)
    value.dispose()
  }

  private setGlobalFunction(name: string, fn: (...args: unknown[]) => unknown): void {
    this.setGlobal(name, this.toGuest(fn))
  }

  /** A plain object of host functions, as a sandbox object (not a proxy): `console`. */
  private hostObject(functions: Record<string, (...args: unknown[]) => unknown>): QuickJSHandle {
    const object = this.ctx.newObject()
    for (const [name, fn] of Object.entries(functions)) {
      const handle = this.toGuest(fn)
      this.ctx.setProp(object, name, handle)
      handle.dispose()
    }
    return object
  }

  // --- The bridge -----------------------------------------------------------------

  private installBridge(): void {
    const ctx = this.ctx
    const host = ctx.newObject()
    const add = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined) => {
      const handle = ctx.newFunction(name, (...args) => {
        try {
          return fn(...args)
        } catch (error) {
          return { error: this.guestError(error) }
        }
      })
      ctx.setProp(host, name, handle)
      handle.dispose()
    }

    add("get", (id, key) => this.toGuest(this.getMember(this.refOf(id), ctx.getString(key))))
    add("has", (id, key) => (this.memberExists(this.refOf(id), ctx.getString(key)) ? ctx.true : ctx.false))
    add("keys", (id) => this.toGuest(publicKeys(this.refOf(id))))
    add("items", (id) => this.toGuest(Array.from(this.refOf(id) as Iterable<unknown>)))
    add("apply", (id, self, args) => {
      const fn = this.refOf(id)
      if (typeof fn !== "function") throw new TypeError("Not a function.")
      const selfId = ctx.getNumber(self)
      const thisValue = selfId === -1 ? undefined : this.refs.get(selfId)
      return this.toGuest(Reflect.apply(fn, thisValue, this.toHost(args) as unknown[]))
    })
    add("construct", (id, args) => {
      const made = this.refOf(id)
      if (made !== URL && made !== URLSearchParams) throw new TypeError("Can't construct that.")
      return this.toGuest(
        Reflect.construct(made as new (...a: unknown[]) => unknown, this.toHost(args) as unknown[]),
      )
    })
    add("page", () => this.toGuest(this.host.currentPage()))
    add("tabs", () => this.toGuest(this.host.tabs()))

    const prelude = ctx.unwrapResult(ctx.evalCode(PRELUDE, "prelude.js"))
    ctx.unwrapResult(ctx.callFunction(prelude, ctx.undefined, host)).dispose()
    prelude.dispose()
    host.dispose()

    const bridge = ctx.getProp(ctx.global, "__bridge")
    for (const name of [
      "ref",
      "kind",
      "keys",
      "source",
      "bytes",
      "bytesOf",
      "date",
      "regexp",
      "regexpParts",
    ]) {
      this.bridge[name] = ctx.getProp(bridge, name)
    }
    bridge.dispose()
    // The sandbox's code doesn't need to see it.
    ctx.setProp(ctx.global, "__bridge", ctx.undefined)
  }

  private callBridge(name: string, ...args: QuickJSHandle[]): QuickJSHandle {
    const fn = this.bridge[name]
    if (fn === undefined) throw new Error(`No bridge function ${name}`)
    const result = this.ctx.callFunction(fn, this.ctx.undefined, ...args)
    for (const arg of args) arg.dispose()
    if (result.error) throw this.toHostError(result.error)
    return result.value
  }

  private refOf(idHandle: QuickJSHandle): unknown {
    const id = this.ctx.getNumber(idHandle)
    if (!this.refs.has(id)) throw new Error("That object is gone.")
    return this.refs.get(id)
  }

  private idFor(value: unknown): number {
    let id = this.refIds.get(value)
    if (id === undefined) {
      id = this.refs.size + 1
      this.refs.set(id, value)
      this.refIds.set(value, id)
    }
    return id
  }

  /** A public member of a host object; methods come bound to it. Private (#) fields can't be named. */
  private getMember(target: unknown, key: string): unknown {
    if (
      BLOCKED_KEYS.has(key) ||
      target === null ||
      (typeof target !== "object" && typeof target !== "function")
    ) {
      return undefined
    }
    const value = (target as Record<string, unknown>)[key]
    if (typeof value !== "function" || typeof target === "function") {
      return value
    }
    let bound = this.boundMethods.get(target)
    if (bound === undefined) {
      bound = new Map()
      this.boundMethods.set(target, bound)
    }
    let method = bound.get(key)
    if (method === undefined) {
      method = (value as (...args: unknown[]) => unknown).bind(target)
      bound.set(key, method)
    }
    return method
  }

  private memberExists(target: unknown, key: string): boolean {
    if (
      BLOCKED_KEYS.has(key) ||
      target === null ||
      (typeof target !== "object" && typeof target !== "function")
    ) {
      return false
    }
    return key in (target as object)
  }

  /** A host value, as a sandbox value. */
  private toGuest(value: unknown): QuickJSHandle {
    const ctx = this.ctx
    if (value === undefined) return ctx.undefined
    if (value === null) return ctx.null
    if (typeof value === "boolean") return value ? ctx.true : ctx.false
    if (typeof value === "number") return ctx.newNumber(value)
    if (typeof value === "string") return ctx.newString(value)
    if (typeof value === "bigint") return ctx.newString(String(value))
    if (value instanceof Uint8Array) {
      const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      return this.callBridge("bytes", ctx.newArrayBuffer(copy as ArrayBuffer))
    }
    if (Array.isArray(value)) {
      const array = ctx.newArray()
      value.forEach((item, index) => {
        const handle = this.toGuest(item)
        ctx.setProp(array, index, handle)
        handle.dispose()
      })
      return array
    }
    if (value instanceof Promise) {
      return this.guestPromise(value)
    }
    if (value instanceof Error) {
      return this.guestError(value)
    }
    if (value instanceof Date) {
      return this.callBridge("date", ctx.newNumber(value.getTime()))
    }
    if (value instanceof RegExp) {
      return this.callBridge("regexp", ctx.newString(value.source), ctx.newString(value.flags))
    }
    if (typeof value === "function") {
      return this.callBridge("ref", ctx.newNumber(this.idFor(value)), ctx.true)
    }
    if (isPlainObject(value)) {
      const object = ctx.newObject()
      for (const [key, item] of Object.entries(value)) {
        const handle = this.toGuest(item)
        ctx.setProp(object, key, handle)
        handle.dispose()
      }
      return object
    }
    // Anything else (AgentPage, AgentLocator, URL…) stays here; the sandbox gets a proxy.
    return this.callBridge("ref", ctx.newNumber(this.idFor(value)), ctx.false)
  }

  /** A sandbox value, as a host value. Handles stay the caller's to dispose. */
  private toHost(handle: QuickJSHandle): unknown {
    const ctx = this.ctx
    const type = ctx.typeof(handle)
    if (type === "undefined" || type === "boolean" || type === "number" || type === "string") {
      return ctx.dump(handle)
    }
    const kindHandle = this.callBridge("kind", handle.dup())
    const kind = ctx.getString(kindHandle)
    kindHandle.dispose()

    if (kind.startsWith("ref:")) return this.refs.get(Number(kind.slice(4)))
    if (kind === "null") return null
    if (kind === "function") {
      // A function for page.evaluate(): it runs in the page, so its source is what crosses.
      const source = this.callBridge("source", handle.dup())
      const text = ctx.getString(source)
      source.dispose()
      return text
    }
    if (kind === "array") {
      const length = ctx.getNumber(ctx.getProp(handle, "length"))
      const items: unknown[] = []
      for (let i = 0; i < length; i++) {
        const item = ctx.getProp(handle, i)
        items.push(this.toHost(item))
        item.dispose()
      }
      return items
    }
    if (kind === "bytes" || kind === "arraybuffer") {
      const buffer = kind === "bytes" ? this.callBridge("bytesOf", handle.dup()) : handle.dup()
      const lifetime = ctx.getArrayBuffer(buffer)
      const bytes = Buffer.from(lifetime.value)
      lifetime.dispose()
      buffer.dispose()
      return bytes
    }
    if (kind === "date") return new Date(ctx.dump(handle) as string)
    if (kind === "regexp") {
      const parts = this.callBridge("regexpParts", handle.dup())
      const [source, flags] = ctx.dump(parts) as [string, string]
      parts.dispose()
      return new RegExp(source, flags)
    }
    if (kind === "error") return this.toHostError(handle.dup())
    if (kind === "promise") return undefined

    const keysHandle = this.callBridge("keys", handle.dup())
    const keys = ctx.dump(keysHandle) as string[]
    keysHandle.dispose()
    const object: Record<string, unknown> = {}
    for (const key of keys) {
      const item = ctx.getProp(handle, key)
      object[key] = this.toHost(item)
      item.dispose()
    }
    return object
  }

  /** A host promise as a sandbox promise. It settles only while its call is still running. */
  private guestPromise(promise: Promise<unknown>): QuickJSHandle {
    const ctx = this.ctx
    const deferred = ctx.newPromise()
    const running = this.running
    const settle = (ok: boolean, value: unknown) => {
      if (!ctx.alive || this.disposed || running === null || running.signal.aborted) {
        deferred.dispose()
        return
      }
      const handle = ok ? this.toGuest(value) : this.guestError(value)
      if (ok) deferred.resolve(handle)
      else deferred.reject(handle)
      handle.dispose()
      deferred.dispose()
      this.pump()
    }
    promise.then(
      (value) => settle(true, value),
      (error) => settle(false, error),
    )
    return deferred.handle.dup()
  }

  private guestError(error: unknown): QuickJSHandle {
    if (error instanceof Error) {
      return this.ctx.newError({ name: error.name, message: error.message })
    }
    return this.ctx.newError({ name: "Error", message: String(error) })
  }

  /** A sandbox error as a host Error, with the sandbox's stack (repl.js:line:column). Disposes the handle. */
  private toHostError(handle: QuickJSHandle): Error {
    const dumped = this.ctx.dump(handle) as { name?: string; message?: string; stack?: string } | string
    handle.dispose()
    if (typeof dumped !== "object" || dumped === null) {
      return new Error(String(dumped))
    }
    const error = new Error(dumped.message ?? "")
    error.name = dumped.name ?? "Error"
    error.stack = `${error.name}: ${error.message}\n${(dumped.stack ?? "").trimEnd()}`
    return error
  }

  /** Runs the sandbox's queued promise work. */
  private pump(): void {
    if (!this.ctx.alive) return
    const result = this.runtime.executePendingJobs()
    if (result.error) {
      result.error.dispose()
    }
  }
}

const BLOCKED_KEYS = new Set(["constructor", "__proto__", "prototype", "then"])

/** The public names on a host object: own fields and its class's methods. */
function publicKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return []
  const keys = new Set(Object.keys(value))
  for (
    let proto = Object.getPrototypeOf(value);
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!BLOCKED_KEYS.has(key)) keys.add(key)
    }
  }
  return [...keys]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function asPage(value: unknown): AgentPage {
  if (value instanceof AgentPage) return value
  throw new TypeError("Expected a page (page, or one of tabs).")
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { depth: 6, breakLength: 120 })
}

/** display(): bytes, base64 or a data: URL, as an image part, its type read from its first bytes. */
function imageOf(input: unknown): ReplPart {
  let bytes: Buffer
  if (input instanceof Uint8Array) {
    bytes = Buffer.from(input)
  } else if (typeof input === "string") {
    const base64 = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input
    bytes = Buffer.from(base64, "base64")
  } else if (
    input !== null &&
    typeof input === "object" &&
    typeof (input as { base64Image?: unknown }).base64Image === "string"
  ) {
    bytes = Buffer.from((input as { base64Image: string }).base64Image, "base64")
  } else {
    throw new TypeError("display() takes image bytes, base64, or a data: URL.")
  }
  return { type: "image", data: bytes.toString("base64"), mimeType: mimeOf(bytes) }
}

function mimeOf(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif"
  return "image/png"
}

/** Neighbouring text joined; at most REPL_OUTPUT_MAX_BYTES of it, images always kept. */
export function capOutput(outputs: ReplPart[]): ReplPart[] {
  const joined: ReplPart[] = []
  let texts: string[] = []
  const flush = () => {
    if (texts.length > 0) joined.push({ type: "text", text: texts.join("\n") })
    texts = []
  }
  for (const part of outputs) {
    if (part.type === "text") {
      texts.push(part.text)
    } else {
      flush()
      joined.push(part)
    }
  }
  flush()

  let budget = REPL_OUTPUT_MAX_BYTES
  let truncated = false
  const kept: ReplPart[] = []
  for (const part of joined) {
    // Images always come back, and don't use up the text's room: the model reads them separately.
    if (part.type === "image") {
      kept.push(part)
      continue
    }
    const size = Buffer.byteLength(part.text, "utf8")
    if (size <= budget) {
      kept.push(part)
      budget -= size
    } else {
      truncated = true
      if (budget > 0) {
        kept.push({
          type: "text",
          text: Buffer.from(part.text, "utf8").subarray(0, budget).toString("utf8") + TRUNCATED,
        })
        budget = 0
      }
    }
  }
  if (truncated && !kept.some((part) => part.type === "text" && part.text.endsWith(TRUNCATED))) {
    kept.push({ type: "text", text: TRUNCATED.trim() })
  }
  return kept
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? "")
      .split("\n")
      .slice(1)
      .filter((line) => line.includes("repl.js"))
      .join("\n")
    return stack === "" ? `${error.name}: ${error.message}` : `${error.name}: ${error.message}\n${stack}`
  }
  return String(error)
}
