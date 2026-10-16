/**
 * The background browser behind the CLI: one session (../repl/session.ts)
 * that lives between commands, so the agent's tabs and REPL variables are
 * still there on its next command.
 *
 *   node src/cli/server.ts <name>     started by client.ts; you don't run it yourself
 *
 * It listens on 127.0.0.1 on a free port and answers only requests with its
 * token. Both are in ~/.browserheap/<name>.json, readable only by you, which
 * is how the CLI finds it. It stops itself after 30 minutes without a
 * command, or on `browserheap stop`.
 *
 *   POST /run    { code }   → the REPL's result: { content, error? }
 *   POST /stop             → closes the browser and exits
 *
 * Its cookies and site storage are saved to ~/.browserheap/<name>-state.json
 * after every command and when it stops, and loaded when it starts: sites
 * that let it in once (a Cloudflare check, a sign-in) still know it next time,
 * as they would a person's browser.
 *
 * Settings come from the environment the CLI starts it with:
 *   BROWSERHEAP_MAX_LIVE   tabs live at once (default 2)
 *   BROWSERHEAP_BLOCK      "ads" (default: ads and trackers), "all" (also images, video, fonts), "none"
 *   BROWSERHEAP_STATE      "off": start with no cookies and save none
 *   BROWSERHEAP_HEADED     "1": the browser opens a window
 *   BROWSERHEAP_HEADLESS_SHELL  "1": Chromium's headless shell (less memory, more bot checks)
 *   BROWSERHEAP_CONNECT    a Chrome DevTools URL: use that running browser instead of starting one
 *
 * Uses:    ../repl/session.ts, paths.ts
 * Used by: client.ts
 */
import { randomBytes } from "node:crypto"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { BlockingOptions } from "../blocking.ts"
import type { EngineOptions } from "../engine.ts"
import { startSession } from "../repl/session.ts"
import { serverFile, stateFile } from "./paths.ts"

const IDLE_MS = 30 * 60_000

const name = process.argv[2] ?? "default"
const file = serverFile(name)
const token = randomBytes(24).toString("hex")
const keepState = process.env.BROWSERHEAP_STATE !== "off"
const state = stateFile(name)

const session = await startSession({
  engine: engineFrom(process.env),
  maxLive: Number(process.env.BROWSERHEAP_MAX_LIVE ?? 2),
  block: blockingFrom(process.env.BROWSERHEAP_BLOCK ?? "ads"),
  context: keepState && existsSync(state) ? { storageState: state } : {},
})

let idleTimer = setTimeout(stop, IDLE_MS)
// One command at a time: the REPL has one scope.
let queue: Promise<unknown> = Promise.resolve()

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.statusCode = 401
    response.end()
    return
  }
  clearTimeout(idleTimer)
  idleTimer = setTimeout(stop, IDLE_MS)

  if (request.method === "POST" && request.url === "/stop") {
    response.end("{}")
    await stop()
    return
  }
  if (request.method === "POST" && request.url === "/run") {
    const body = JSON.parse(await readBody(request)) as { code?: unknown }
    const code = String(body.code ?? "")
    const result = queue.then(() => session.run(code))
    queue = result.catch(() => {})
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(await result))
    await saveState()
    return
  }
  response.statusCode = 404
  response.end()
})

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
})

/** Writes the browser's cookies and site storage for the next session. */
async function saveState(): Promise<void> {
  if (!keepState) {
    return
  }
  try {
    const saved = await session.browser.context.storageState()
    writeFileSync(state, JSON.stringify(saved), { mode: 0o600 })
  } catch {
    // The browser is closing; the last save stands.
  }
}

async function stop(): Promise<void> {
  rmSync(file, { force: true })
  server.close()
  await saveState()
  await session.close().catch(() => {})
  process.exit(0)
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ""
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString()
    })
    request.on("end", () => resolve(text))
    request.on("error", reject)
  })
}

function engineFrom(env: NodeJS.ProcessEnv): EngineOptions {
  if (env.BROWSERHEAP_CONNECT) {
    return { kind: "cdp", url: env.BROWSERHEAP_CONNECT }
  }
  return {
    kind: "chromium",
    headed: env.BROWSERHEAP_HEADED === "1",
    shell: env.BROWSERHEAP_HEADLESS_SHELL === "1",
  }
}

function blockingFrom(setting: string): BlockingOptions | false {
  if (setting === "none") {
    return false
  }
  return { ads: true, media: setting === "all" }
}
