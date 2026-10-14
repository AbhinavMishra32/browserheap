/**
 * What the runner needs from O's database that O's API doesn't show: how a
 * run ended, and which machine is the cloud computer. Opened read-only.
 *
 *   runOutcome(runId)   → { status: "failed", error: "Usage limit reached…" }
 *   cloudMachine()      → { provider: "e2b", machineId: "i9x…" } or null
 *
 * Uses:    node:sqlite, ~/.o/data.db
 * Used by: run.ts
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const DATABASE = join(homedir(), ".o", "data.db")

function open(): DatabaseSync {
  return new DatabaseSync(DATABASE, { readOnly: true })
}

export interface RunOutcome {
  /** "completed", "failed" or "cancelled". */
  status: string
  error: string | null
}

export function runOutcome(runId: string): RunOutcome | null {
  const database = open()
  try {
    const row = database.prepare("SELECT status, error FROM run WHERE id = ?").get(runId)
    if (row === undefined) {
      return null
    }
    return { status: String(row.status), error: row.error === null ? null : String(row.error) }
  } finally {
    database.close()
  }
}

export interface CloudMachine {
  provider: string
  machineId: string
}

/** Your cloud computer's machine (there's one per account), once it has one. */
export function cloudMachine(): CloudMachine | null {
  const database = open()
  try {
    const row = database
      .prepare("SELECT provider, machine_id FROM computer WHERE kind = 'cloud' AND machine_id IS NOT NULL")
      .get()
    if (row === undefined) {
      return null
    }
    return { provider: String(row.provider), machineId: String(row.machine_id) }
  } finally {
    database.close()
  }
}
