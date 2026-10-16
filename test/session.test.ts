/**
 * The REPL session on a real Chromium against a local site: what the agent's
 * code can do, and that its pages and locators keep working while their tabs
 * sleep and wake underneath.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Session, startSession } from "../src/repl/session.ts"

const PAGE = (name: string) => `<!doctype html><title>${name}</title>
<h1>${name}</h1>
<button onclick="document.getElementById('status').textContent='Saved ${name}'">Save</button>
<p id="status"></p>
<p>${"Some words on the page. ".repeat(20)}</p>`

describe("session", () => {
  let server: Server
  let site = ""
  let session: Session | null = null

  beforeAll(async () => {
    server = createServer((request, response) => {
      const name = (request.url ?? "/").slice(1) || "home"
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(PAGE(name))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await session?.close()
    session = null
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** Runs code and returns what it printed; fails the test if the code threw. */
  async function run(code: string): Promise<string> {
    if (session === null) {
      throw new Error("No session started")
    }
    const result = await session.run(code)
    expect(result.error).toBeUndefined()
    return result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n")
  }

  it("opens a tab and shows it as a tree with refs", async () => {
    session = await startSession({ block: false })
    const printed = await run(`await openTab("${site}/docs"); console.log((await snapshot(page)).tree)`)
    expect(printed).toContain("docs")
    expect(printed).toMatch(/button "Save" \[ref=e\d+\]/)
  })

  it("keeps a page working after its tab slept and woke", async () => {
    session = await startSession({ block: false, maxLive: 2 })
    await run(`await openTab("${site}/first"); const first = page`)
    await run(`await openTab("${site}/second"); await openTab("${site}/third")`)
    expect(session.browser.tabs[0]?.state).toBe("asleep")

    // The same `first` object, many calls later: its tab wakes and the click lands.
    const printed = await run(
      `await first.getByRole("button", { name: "Save" }).click(); console.log(await first.locator("#status").textContent())`,
    )
    expect(printed).toBe("Saved first")
    expect(session.browser.tabs[0]?.state).toBe("live")
  })

  it("keeps a locator made before the tab slept", async () => {
    session = await startSession({ block: false, maxLive: 2 })
    await run(`await openTab("${site}/first"); const save = page.getByRole("button", { name: "Save" })`)
    await run(`await openTab("${site}/second"); await openTab("${site}/third")`)
    expect(session.browser.tabs[0]?.state).toBe("asleep")

    const printed = await run(
      `await save.click(); console.log(await tabs[0].locator("#status").textContent())`,
    )
    expect(printed).toBe("Saved first")
  })

  it("reads a sleeping tab's title without waking it", async () => {
    session = await startSession({ block: false, maxLive: 2 })
    await run(
      `await openTab("${site}/first"); await openTab("${site}/second"); await openTab("${site}/third")`,
    )
    const printed = await run(`console.log(await tabs[0].title())`)
    expect(printed).toBe("first")
    expect(session.browser.tabs[0]?.state).toBe("asleep")
  })

  it("reads a sleeping tab's text without waking it", async () => {
    session = await startSession({ block: false, maxLive: 2 })
    await run(
      `await openTab("${site}/first"); await openTab("${site}/second"); await openTab("${site}/third")`,
    )
    const printed = await run(`console.log(tabs[0].isAsleep(), (await tabs[0].text()).includes("first"))`)
    expect(printed).toBe("true true")
    expect(session.browser.tabs[0]?.state).toBe("asleep")
  })

  it("keeps a ref from before the tab slept: it still clicks the same element", async () => {
    session = await startSession({ block: false, maxLive: 2 })
    const tree = await run(
      `await openTab("${site}/first"); const first = page; console.log((await snapshot(page)).tree)`,
    )
    const ref = tree.match(/button "Save" \[ref=(e\d+)\]/)?.[1]
    expect(ref).toBeDefined()
    await run(`await openTab("${site}/second"); await openTab("${site}/third")`)
    expect(session.browser.tabs[0]?.state).toBe("asleep")

    const printed = await run(
      `await first.locator("${ref}").click(); console.log(await first.locator("#status").textContent())`,
    )
    expect(printed).toBe("Saved first")
  })
})
