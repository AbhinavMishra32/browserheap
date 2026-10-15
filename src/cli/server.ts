/**
 * The background browser behind the CLI: one session (../repl/session.ts)
 * that lives between commands, so the agent's tabs and REPL variables are
 * still there on its next command.
 *
 *   node src/cli/server.ts <name>     started by client.ts; you don't run it yourself
 *
 * It listens on 127.0.0.1 on a free port and answers only requests with its
 * token. Both are in ~/.agent-tabs/<name>.json, readable only by you, which
 * is how the CLI finds it. It stops itself after 30 minutes without a
 * command, or on `agent-tabs stop`.
 *
 *   POST /run    { code }   → the REPL's result: { content, error? }
 *   POST /stop             → closes the browser and exits
 *
 * Settings come from the environment the CLI starts it with:
 *   AGENT_TABS_MAX_LIVE   tabs live at once (default 2)
 *   AGENT_TABS_BLOCK      "ads" (default: ads and trackers), "all" (also images, video, fonts), "none"
 *
 * Uses:    ../repl/session.ts, paths.ts
 * Used by: client.ts
 */
import { randomBytes } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { BlockingOptions } from "../blocking.ts"
import { startSession } from "../repl/session.ts"
import { serverFile } from "./paths.ts"

const IDLE_MS = 30 * 60_000

const name = process.argv[2] ?? "default"
const file = serverFile(name)
const token = randomBytes(24).toString("hex")

const session = await startSession({
  maxLive: Number(process.env.AGENT_TABS_MAX_LIVE ?? 2),
  block: blockingFrom(process.env.AGENT_TABS_BLOCK ?? "ads"),
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
    return
  }
  response.statusCode = 404
  response.end()
})

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
})

async function stop(): Promise<void> {
  rmSync(file, { force: true })
  server.close()
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

function blockingFrom(setting: string): BlockingOptions | false {
  if (setting === "none") {
    return false
  }
  return { ads: true, media: setting === "all" }
}
