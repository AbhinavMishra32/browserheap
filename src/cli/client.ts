/**
 * Talks to the background browser (server.ts), starting it first if it isn't
 * running.
 *
 *   const result = await runCode("default", `console.log(await page.title())`)
 *   await stopServer("default")
 *
 * Uses:    paths.ts, server.ts (started as its own process)
 * Used by: main.ts
 */
import { spawn } from "node:child_process"
import { existsSync, openSync, readFileSync, rmSync } from "node:fs"
import type { ReplResult } from "../repl/repl.ts"
import { logFile, serverFile } from "./paths.ts"

interface ServerInfo {
  port: number
  token: string
  pid: number
}

/** Settings for a background browser, used only when this command starts it. */
export interface StartSettings {
  maxLive?: string
  block?: string
  headed?: boolean
  headlessShell?: boolean
  connect?: string
}

function readInfo(name: string): ServerInfo | null {
  const file = serverFile(name)
  if (!existsSync(file)) {
    return null
  }
  const info = JSON.parse(readFileSync(file, "utf8")) as ServerInfo
  try {
    // Signal 0 only checks the process is there.
    process.kill(info.pid, 0)
    return info
  } catch {
    // It died without cleaning up.
    rmSync(file, { force: true })
    return null
  }
}

/** Starts the background browser and waits until it's listening. */
async function start(name: string, settings: StartSettings): Promise<ServerInfo> {
  const log = openSync(logFile(name), "a")
  // server.ts from a checkout, server.js once built (dist/).
  const built = import.meta.url.endsWith(".js")
  const program = new URL(built ? "./server.js" : "./server.ts", import.meta.url).pathname
  const child = spawn(process.execPath, [program, name], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      BROWSERHEAP_MAX_LIVE: settings.maxLive ?? process.env.BROWSERHEAP_MAX_LIVE,
      BROWSERHEAP_BLOCK: settings.block ?? process.env.BROWSERHEAP_BLOCK,
      BROWSERHEAP_HEADED: settings.headed ? "1" : process.env.BROWSERHEAP_HEADED,
      BROWSERHEAP_HEADLESS_SHELL: settings.headlessShell ? "1" : process.env.BROWSERHEAP_HEADLESS_SHELL,
      BROWSERHEAP_CONNECT: settings.connect ?? process.env.BROWSERHEAP_CONNECT,
    },
  })
  child.unref()
  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const info = readInfo(name)
    if (info !== null) {
      return info
    }
  }
  throw new Error(`The browser didn't start in 30 s. See ${logFile(name)}.`)
}

async function call(info: ServerInfo, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`The background browser answered ${response.status}.`)
  }
  return response.json()
}

export async function runCode(name: string, code: string, settings: StartSettings = {}): Promise<ReplResult> {
  const info = readInfo(name) ?? (await start(name, settings))
  return (await call(info, "/run", { code })) as ReplResult
}

/** Stops the background browser; true if one was running. */
export async function stopServer(name: string): Promise<boolean> {
  const info = readInfo(name)
  if (info === null) {
    return false
  }
  await call(info, "/stop", {}).catch(() => {})
  return true
}
