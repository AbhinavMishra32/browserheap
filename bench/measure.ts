/**
 * How much memory a browser uses, all its processes together.
 *
 *   footprintMb([123, 456, 789])   → 3866
 *
 * Both ways count memory the processes share only once:
 *   macOS   the `footprint` tool on every process at once (what Activity
 *           Monitor calls "Memory", not the bigger "Real Memory" sum)
 *   Linux   each process's PSS from /proc (shared pages split between the
 *           processes sharing them), added up
 *
 * A browser is many processes. Chromium's are its children; WebKit's page
 * processes belong to macOS's launchd instead, so they're found by the
 * folder they run from.
 *
 * Used by: run.ts
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** A process and every process under it. */
export function processTree(pid: number): number[] {
  const all = [pid]
  let children = ""
  try {
    children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
  } catch {
    // pgrep exits with an error when there are no children.
    return all
  }
  for (const line of children.split("\n")) {
    if (line.trim() !== "") {
      all.push(...processTree(Number(line)))
    }
  }
  return all
}

/** Every process whose command line contains `text`. */
export function processesMatching(text: string): number[] {
  let found = ""
  try {
    found = execFileSync("pgrep", ["-f", text], { encoding: "utf8" })
  } catch {
    return []
  }
  const pids: number[] = []
  for (const line of found.split("\n")) {
    if (line.trim() !== "") {
      pids.push(Number(line))
    }
  }
  return pids
}

/** The memory these processes use together, in MB. */
export function footprintMb(pids: number[]): number {
  // No browser yet (some tools only start one with the first page).
  if (pids.length === 0) {
    return 0
  }
  if (process.platform === "linux") {
    return pssMb(pids)
  }
  const args = ["-f", "bytes"]
  for (const pid of pids) {
    args.push("-p", String(pid))
  }
  // A process can exit while we measure; footprint then complains on stderr but still reports the rest.
  const out = execFileSync("footprint", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

  // One process: "Footprint: N B". Several: one line each, then "Summary Footprint: N B" last.
  const totals = out.match(/Footprint:\s+(\d+) B/g)
  if (totals === null) {
    return 0
  }
  const last = totals[totals.length - 1] ?? ""
  const bytes = Number(last.replace(/\D+/g, " ").trim().split(" ")[0])
  return Math.round(bytes / 1024 / 1024)
}

/** Linux: the processes' PSS added up, in MB. */
function pssMb(pids: number[]): number {
  let kilobytes = 0
  for (const pid of pids) {
    let rollup = ""
    try {
      rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")
    } catch {
      // The process exited while we measured.
      continue
    }
    const pss = rollup.match(/^Pss:\s+(\d+) kB/m)
    if (pss !== null) {
      kilobytes += Number(pss[1])
    }
  }
  return Math.round(kilobytes / 1024)
}
