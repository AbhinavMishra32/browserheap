/**
 * Where the CLI keeps its things: ~/.agent-tabs/
 *
 *   <name>.json      how to reach a running background browser: { port, token, pid } (mode 600)
 *   <name>.log       what that browser printed
 *   images/          screenshots and other images the agent's code displayed
 *
 * Used by: server.ts, client.ts, main.ts
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOME = join(homedir(), ".agent-tabs")

function inHome(...parts: string[]): string {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  return join(HOME, ...parts)
}

/** A session's name, made safe for a file name. */
function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-")
}

export function serverFile(name: string): string {
  return inHome(`${safe(name)}.json`)
}

export function logFile(name: string): string {
  return inHome(`${safe(name)}.log`)
}

export function imagesFolder(): string {
  const folder = inHome("images")
  mkdirSync(folder, { recursive: true })
  return folder
}
