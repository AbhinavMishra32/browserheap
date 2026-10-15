/**
 * Where a BU Bench run has got to, saved after every task, so a run stopped
 * by your ChatGPT usage limit (or anything else) carries on where it left off.
 *
 *   const progress = loadProgress()
 *   progress.runs["browserheap"][taskId]     a finished task, graded
 *   saveProgress(progress)
 *
 * Lives in bench/results/bu-bench-progress.json, out of git: it holds the
 * tasks' text in their trajectories, and BU Bench's tasks stay private.
 * Delete it to start over.
 *
 * Used by: run.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Grade } from "./grade.ts"

export const PROGRESS_FILE = join(import.meta.dirname, "..", "results", "bu-bench-progress.json")

export interface TaskRun {
  taskId: string
  category: string
  setup: string
  answer: string | null
  /** "done", or why not: "timeout", "error: …". */
  stoppedBy: string
  steps: number
  /** Characters of tool results the agent read. */
  readChars: number
  durationMs: number
  trajectory: string
  grade: Grade
}

/** One setup's go at one batch of tasks: its memory and time. */
export interface BatchRecord {
  setup: string
  where: string
  tasks: number
  peakMb: number
  averageMb: number
  minutes: number
  /** Your ChatGPT usage before and after, as its headers report it (percent of each window). */
  usageBefore: Record<string, string>
  usageAfter: Record<string, string>
  finishedAt: string
}

export interface Progress {
  model: string
  harness: string
  where: string
  startedAt: string
  /** Finished tasks: setup → task id → its run. */
  runs: Record<string, Record<string, TaskRun>>
  batches: BatchRecord[]
  /** E2B sandboxes this runner made: the only ones it may delete. */
  sandboxes: string[]
}

export function loadProgress(
  fresh: Omit<Progress, "runs" | "batches" | "sandboxes" | "startedAt">,
): Progress {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf8")) as Progress
  }
  return { ...fresh, startedAt: new Date().toISOString(), runs: {}, batches: [], sandboxes: [] }
}

export function saveProgress(progress: Progress): void {
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true })
  writeFileSync(PROGRESS_FILE, `${JSON.stringify(progress, null, 2)}\n`)
}
