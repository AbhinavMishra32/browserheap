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

/**
 * Linux: the CPU time each process has used so far, in seconds.
 *
 *   const before = cpuSeconds(pids)
 *   … 15 s later …
 *   cpuPercent(before, cpuSeconds(pids), 15)   → 37 (37% of one core)
 */
export function cpuSeconds(pids: number[]): Map<number, number> {
  const used = new Map<number, number>()
  for (const pid of pids) {
    let stat = ""
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    } catch {
      continue
    }
    // The command name is in brackets and can hold spaces; the numbers come after it.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    // utime and stime, fields 14 and 15 of the whole line, counted in clock ticks.
    const ticks = Number(fields[11]) + Number(fields[12])
    used.set(pid, ticks / CLOCK_TICKS)
  }
  return used
}

/** The CPU the processes used between two samples, as a percentage of one core. */
export function cpuPercent(before: Map<number, number>, after: Map<number, number>, seconds: number): number {
  let used = 0
  for (const [pid, total] of after) {
    // A process that started between the samples counts from zero.
    used += total - (before.get(pid) ?? 0)
  }
  return Math.round((used / seconds) * 100)
}

export interface IdleSample {
  /** Seconds since the watch began. */
  seconds: number
  mb: number
  /** CPU over the last interval, as a percentage of one core. */
  cpuPercent: number
}

/**
 * Leaves the browser alone with its tabs open and samples its memory and CPU
 * every `everySeconds`: what idle tabs cost while the agent does something else.
 */
export async function watchIdle(
  pids: () => number[],
  minutes: number,
  everySeconds = 15,
): Promise<IdleSample[]> {
  const samples: IdleSample[] = []
  const startedAt = Date.now()
  let before = cpuSeconds(pids())
  while (Date.now() - startedAt < minutes * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, everySeconds * 1000))
    const now = pids()
    const after = cpuSeconds(now)
    const sample = {
      seconds: Math.round((Date.now() - startedAt) / 1000),
      mb: footprintMb(now),
      cpuPercent: cpuPercent(before, after, everySeconds),
    }
    samples.push(sample)
    console.log(
      `idle ${String(sample.seconds).padStart(4)} s  ${String(sample.mb).padStart(6)} MB  ${sample.cpuPercent}% CPU`,
    )
    before = after
  }
  return samples
}

/** The sites to open: the list repeated as many times as it takes to reach `count`. */
export function sitesFor(sites: readonly string[], count: number): string[] {
  const list: string[] = []
  for (let i = 0; i < count; i++) {
    list.push(sites[i % sites.length] ?? "")
  }
  return list
}

/** Linux counts CPU time in ticks: 100 a second on almost every machine. */
const CLOCK_TICKS = clockTicks()

function clockTicks(): number {
  if (process.platform !== "linux") {
    return 100
  }
  try {
    return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100
  } catch {
    return 100
  }
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
