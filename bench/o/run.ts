/**
 * Does an agent still succeed with sleeping tabs? Runs a pi agent (O's
 * agent loop is pi's: pi-agent-core and pi-ai) on BU Bench V1's 100 tasks,
 * once with a plain headless Chrome and once with browserheap, and measures
 * success, memory, time and your ChatGPT usage.
 *
 *   node --env-file=../../.env bench/o/run.ts                  all 100 tasks, browser on E2B, 10 at a time
 *   node --env-file=../../.env bench/o/run.ts --tasks 2 --batch 2 --parallel 2     a quick try
 *   node bench/o/run.ts --where local                          the browser on this Mac instead
 *
 *   chrome      every tab live, nothing blocked: a plain headless Chrome
 *   blocking    every tab live, ads and trackers blocked (not run unless asked: --setups)
 *   browserheap  ads and trackers blocked, 2 tabs live per chat
 *
 * In batches: 10 tasks with Chrome, the same 10 with browserheap, then the
 * next 10, so the two always cover the same tasks. Tasks take turns by
 * category, so any number of batches covers all five evenly. Every task is
 * saved the moment it's graded (progress.ts); run again and it carries on.
 *
 * Usage: before each batch it reads your ChatGPT usage (model.ts usageNow)
 * and stops once the 5-hour or the weekly window is past --stop-at percent
 * (default 80), saying when it resets. A task cut short by a usage limit
 * isn't saved, so it runs again next time.
 *
 * Where the browser runs (--where):
 *   e2b    O's cloud computer in an E2B sandbox (template "o-computer-bench",
 *          pnpm --filter @app/computer-program template with COMPUTER_IMAGE=o-computer-bench),
 *          reaching O's server here through a cloudflared tunnel (cloud-computer.ts).
 *          A fresh sandbox for each setup and batch, deleted after.
 *   local  O's browser-only computer on this Mac.
 * Either way O's server runs here, with your ChatGPT sign-in; it never leaves this Mac.
 * Port 3000 must be free: stop the dev server first.
 *
 * Each task is a new chat with one agent made for this ("BU Bench"), on
 * gpt-6-luna (O runs every model on medium reasoning), told not to use its
 * memory. The runner checks no memory document changed and says if one did.
 *
 * Signs in with your O token from ~/.o/bench-token (mode 600).
 * Tasks: bench/o/data/BU-Bench-v1-dataset.json.enc, out of git; never printed in plain text.
 * Results: bench/results/bu-bench-progress.json while it runs; bench/results/o-<time>.json at the end.
 *
 * Uses:    grade.ts, model.ts, progress.ts, cloud-computer.ts, o-database.ts, ../measure.ts, O's HTTP API
 */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { footprintMb, processesMatching, processTree } from "../measure.ts"
import {
  currentSandboxId,
  deleteSandbox,
  SandboxMemory,
  startTunnel,
  TEMPLATE,
  type Tunnel,
} from "./cloud-computer.ts"
import { type BenchTask, gradeTask } from "./grade.ts"
import { MODEL_ID, usageNow } from "./model.ts"
import { runOutcome } from "./o-database.ts"
import {
  type BatchRecord,
  loadProgress,
  PROGRESS_FILE,
  type Progress,
  saveProgress,
  type TaskRun,
} from "./progress.ts"

const O_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..")
const API = "http://127.0.0.1:3000/api"
const TOKEN_FILE = join(homedir(), ".o", "bench-token")
const DATASET = join(import.meta.dirname, "data", "BU-Bench-v1-dataset.json.enc")
const CATEGORIES = ["WebBenchREAD", "OM2W2", "InteractionTests", "GAIA", "BrowseComp"]

/** What ran the tasks, for the results and the announcement. */
const HARNESS =
  "pi agent (pi-agent-core 1.0.4, pi-ai 1.0.4) with a JavaScript REPL browser tool over Playwright"

const AGENT_NAME = "BU Bench"
const AGENT_INSTRUCTIONS = `You complete web tasks with your browser. Work only from what you see on the pages.
Don't read or write your memory: every task is separate. When you're done, give the complete answer the task asks for.`

const TASK_MINUTES = 15
const POLL_MS = 3_000
const SAMPLE_EVERY_MS = 2_000
/** How much of each tool result goes into the trajectory the grader reads. */
const TRAJECTORY_RESULT_CHARS = 1_500
/** Words in an error that mean a usage or rate limit, not a failed task. */
const LIMIT_WORDS = /usage limit|rate limit|429|too many requests|quota/i

interface Setup {
  maxLive: string
  block: string
}

const SETUPS: Record<string, Setup> = {
  chrome: { maxLive: "1000", block: "none" },
  blocking: { maxLive: "1000", block: "ads" },
  browserheap: { maxLive: "2", block: "ads" },
}

/** The value after `--name` on the command line, if given. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  if (at === -1) {
    return undefined
  }
  return process.argv[at + 1]
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

// O's API, signed in as you.

const token = readFileSync(TOKEN_FILE, "utf8").trim()

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

interface ToolCall {
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: "user" | "assistant" | "tool"
  content?: string | Array<{ type: string; text?: string }>
  toolCalls?: ToolCall[]
}

// The server, one setup at a time.

async function startServer(setup: Setup, where: string, tunnel: Tunnel | null): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    O_BROWSER_MAX_LIVE: setup.maxLive,
    O_BROWSER_BLOCK: setup.block,
  }
  if (where === "e2b" && tunnel !== null) {
    env.COMPUTER_PROVIDER = "e2b"
    env.COMPUTER_IMAGE = TEMPLATE
    env.COMPUTER_SERVER_URL = tunnel.serverUrl
  } else {
    env.COMPUTER_PROVIDER = "local"
  }
  const server = spawn(process.execPath, ["apps/server/src/index.ts"], {
    cwd: O_ROOT,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500)
    try {
      await api("GET", "/agents")
      return server
    } catch {
      // Not listening yet.
    }
  }
  server.kill()
  throw new Error("O's server didn't start. Is something else on port 3000?")
}

async function stopServer(server: ChildProcess): Promise<void> {
  await new Promise<void>((done) => {
    server.once("exit", () => done())
    server.kill()
  })
  // A local computer notices its server is gone within 2 s; make sure.
  await sleep(3_000)
  for (const pid of processesMatching("apps/computer/src/local.ts")) {
    process.kill(pid)
  }
}

/** The benchmark's own agent, made the first time, and on the benchmark's model every time. */
async function benchAgentId(): Promise<string> {
  const { agents } = await api<{ agents: Array<{ id: string; name: string }> }>("GET", "/agents")
  const existing = agents.find((agent) => agent.name === AGENT_NAME)
  if (existing !== undefined) {
    await api("PATCH", `/agents/${existing.id}`, { provider: "openai", model: MODEL_ID })
    return existing.id
  }
  const made = await api<{ id: string }>("POST", "/agents", {
    name: AGENT_NAME,
    description: "Runs BU Bench tasks for the browserheap benchmark.",
    instructions: AGENT_INSTRUCTIONS,
    provider: "openai",
    model: MODEL_ID,
  })
  return made.id
}

/** What's in your memory now, to see if a task changed it. */
async function memoryNow(): Promise<string> {
  const { documents } = await api<{ documents: Array<{ path: string; version: number; deleted: boolean }> }>(
    "GET",
    "/memory",
  )
  return JSON.stringify(documents.map((each) => [each.path, each.version, each.deleted]))
}

// One task.

/** A graded run, or "usage-limit" when a usage limit cut it short (it runs again next time). */
async function runTask(task: BenchTask, setup: string, agentId: string): Promise<TaskRun | "usage-limit"> {
  const startedAt = Date.now()
  const chat = await api<{ id: string }>("POST", `/agents/${agentId}/chats`)
  const run = await api<{ id: string }>("POST", `/chats/${chat.id}/messages`, {
    text: task.confirmed_task,
    clientMessageId: randomUUID(),
  })

  let stoppedBy = "done"
  while (true) {
    await sleep(POLL_MS)
    const { runs } = await api<{ runs: Array<{ id: string }> }>("GET", "/runs/active")
    if (!runs.some((each) => each.id === run.id)) {
      break
    }
    if (Date.now() - startedAt > TASK_MINUTES * 60_000) {
      await api("POST", `/runs/${run.id}/cancel`)
      stoppedBy = "timeout"
      break
    }
  }
  const durationMs = Date.now() - startedAt

  const outcome = runOutcome(run.id)
  if (outcome?.status === "failed" && LIMIT_WORDS.test(outcome.error ?? "")) {
    return "usage-limit"
  }

  const { messages } = await api<{ messages: ChatMessage[] }>("GET", `/chats/${chat.id}/messages`)
  const trajectory: string[] = [`TASK: ${task.confirmed_task}`]
  let answer: string | null = null
  let steps = 0
  let readChars = 0
  for (const message of messages) {
    const text = textOf(message.content)
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        steps++
        trajectory.push(`ACTION ${steps}: ${call.function.name} ${call.function.arguments}`)
      }
      if (text !== "") {
        trajectory.push(`AGENT: ${text}`)
        answer = text
      }
    }
    if (message.role === "tool") {
      readChars += text.length
      trajectory.push(`RESULT: ${text.slice(0, TRAJECTORY_RESULT_CHARS)}`)
    }
  }
  // The answer is the agent's last words, if it ended with words and not mid-task.
  const last = messages.at(-1)
  if (last?.role !== "assistant" || textOf(last.content) === "") {
    answer = null
    if (stoppedBy === "done") {
      stoppedBy = outcome?.error ? `error: ${outcome.error.slice(0, 200)}` : "error: no final answer"
    }
  }
  if (answer !== null) {
    trajectory.push(`FINAL ANSWER: ${answer}`)
  }

  const joined = trajectory.join("\n")
  const grade = await gradeTask(task, joined)
  if (grade.verdict === "error" && LIMIT_WORDS.test(grade.reasoning)) {
    return "usage-limit"
  }
  return {
    taskId: task.task_id,
    category: task.category,
    setup,
    answer,
    stoppedBy,
    steps,
    readChars,
    durationMs,
    trajectory: joined,
    grade,
  }
}

function textOf(content: ChatMessage["content"]): string {
  if (content === undefined) {
    return ""
  }
  if (typeof content === "string") {
    return content.trim()
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim()
}

// Your ChatGPT usage.

/** Why to stop now, or null: the 5-hour or weekly window is past `stopAt` percent. */
function overLimit(usage: Record<string, string>, stopAt: number): string | null {
  const windows = [
    { name: "5-hour", used: "x-codex-primary-used-percent", reset: "x-codex-primary-reset-at" },
    { name: "weekly", used: "x-codex-secondary-used-percent", reset: "x-codex-secondary-reset-at" },
  ]
  for (const window of windows) {
    const used = Number(usage[window.used] ?? 0)
    if (used >= stopAt) {
      const resetAt = new Date(Number(usage[window.reset] ?? 0) * 1000)
      return `your ${window.name} ChatGPT usage is at ${used}% (stops at ${stopAt}%); it resets ${resetAt.toLocaleString()}`
    }
  }
  return null
}

function usageLine(usage: Record<string, string>): string {
  const fiveHour = usage["x-codex-primary-used-percent"] ?? "?"
  const weekly = usage["x-codex-secondary-used-percent"] ?? "?"
  return `ChatGPT usage: 5-hour ${fiveHour}%, weekly ${weekly}%`
}

// One setup's go at one batch.

function localComputerMemoryMb(): number {
  const pids: number[] = []
  for (const pid of processesMatching("apps/computer/src/local.ts")) {
    pids.push(...processTree(pid))
  }
  if (pids.length === 0) {
    return 0
  }
  return footprintMb(pids)
}

/** Deletes the E2B cloud computer if this runner made it; refuses to touch one it didn't. */
async function clearCloudComputer(progress: Progress): Promise<void> {
  const id = currentSandboxId()
  if (id === null) {
    return
  }
  if (!progress.sandboxes.includes(id)) {
    throw new Error(
      "Your O account has an E2B cloud computer this runner didn't make. It may hold your own work, " +
        "so the runner won't delete it. Stop it from O (or delete it yourself) and run again.",
    )
  }
  await deleteSandbox(id).catch(() => {})
}

interface BatchOptions {
  tasks: BenchTask[]
  setupName: string
  parallel: number
  where: string
  tunnel: Tunnel | null
  progress: Progress
  usageBefore: Record<string, string>
}

/** Runs the tasks on one setup, saving each as it's graded. True when a usage limit cut it short. */
async function runBatch(options: BatchOptions): Promise<boolean> {
  const { tasks, setupName, parallel, where, tunnel, progress } = options
  const setup = SETUPS[setupName]
  if (setup === undefined) {
    throw new Error(`No setup called ${setupName}`)
  }
  console.log(
    `\n${setupName}: ${tasks.length} tasks, ${setup.maxLive} tabs live per chat, blocking ${setup.block}`,
  )

  if (where === "e2b") {
    await clearCloudComputer(progress)
  }
  // Any sandbox that's the cloud computer after this batch, and not before, is one this runner made.
  const sandboxBefore = currentSandboxId()
  const server = await startServer(setup, where, tunnel)
  const startedAt = Date.now()

  // Memory: inside the sandbox on E2B, with macOS's footprint on this Mac.
  const sandboxMemory = where === "e2b" ? new SandboxMemory() : null
  const localSamples: number[] = []
  const localSampler =
    where === "local"
      ? setInterval(() => {
          try {
            localSamples.push(localComputerMemoryMb())
          } catch {
            // A process ended mid-measure; the next sample will do.
          }
        }, SAMPLE_EVERY_MS)
      : null

  let hitLimit = false
  let finished = 0
  try {
    const agentId = await benchAgentId()
    const memoryBefore = await memoryNow()
    let next = 0
    async function worker(): Promise<void> {
      while (next < tasks.length && !hitLimit) {
        const task = tasks[next]
        next++
        if (task === undefined) {
          return
        }
        const run = await runTask(task, setupName, agentId)
        if (run === "usage-limit") {
          hitLimit = true
          console.log(
            `  ${task.category.padEnd(16)} stopped by a usage limit: not saved, runs again next time`,
          )
          return
        }
        const runsOfSetup = progress.runs[setupName] ?? {}
        runsOfSetup[run.taskId] = run
        progress.runs[setupName] = runsOfSetup
        saveProgress(progress)
        finished++
        console.log(
          `  ${run.category.padEnd(16)} ${run.grade.verdict.padEnd(10)} ${run.steps} steps, ` +
            `${Math.round(run.readChars / 1000)}k chars read, ${Math.round(run.durationMs / 1000)} s` +
            `${run.stoppedBy === "done" ? "" : ` (${run.stoppedBy})`}`,
        )
      }
    }
    const workers: Promise<void>[] = []
    for (let index = 0; index < parallel; index++) {
      workers.push(worker())
    }
    await Promise.all(workers)
    if ((await memoryNow()) !== memoryBefore) {
      console.log("  NOTE: a memory document changed during this batch; later tasks could have seen it.")
    }
  } finally {
    let peakMb = 0
    let averageMb = 0
    if (sandboxMemory !== null) {
      const measured = await sandboxMemory.stop()
      peakMb = measured.peakMb
      averageMb = measured.averageMb
    }
    if (localSampler !== null) {
      clearInterval(localSampler)
      const nonZero = localSamples.filter((sample) => sample > 0)
      peakMb = Math.max(0, ...nonZero)
      let sum = 0
      for (const sample of nonZero) {
        sum += sample
      }
      averageMb = nonZero.length === 0 ? 0 : Math.round(sum / nonZero.length)
    }
    await stopServer(server)
    const sandboxAfter = currentSandboxId()
    if (
      sandboxAfter !== null &&
      sandboxAfter !== sandboxBefore &&
      !progress.sandboxes.includes(sandboxAfter)
    ) {
      progress.sandboxes.push(sandboxAfter)
      saveProgress(progress)
    }
    if (where === "e2b") {
      await clearCloudComputer(progress).catch((error) => console.error(String(error)))
    }
    const record: BatchRecord = {
      setup: setupName,
      where,
      tasks: finished,
      peakMb,
      averageMb,
      minutes: Math.round((Date.now() - startedAt) / 6_000) / 10,
      usageBefore: options.usageBefore,
      usageAfter: await usageNow().catch(() => ({})),
      finishedAt: new Date().toISOString(),
    }
    progress.batches.push(record)
    saveProgress(progress)
    console.log(`  memory: peak ${peakMb} MB, average ${averageMb} MB · ${usageLine(record.usageAfter)}`)
  }
  return hitLimit
}

/** BU Bench's tasks, taking turns by category: the first of each, then the second of each… */
function allTasks(count: number): BenchTask[] {
  if (!existsSync(DATASET)) {
    throw new Error(`Missing ${DATASET}: BU Bench V1's tasks, from github.com/at-inc/aside-benchmarks.`)
  }
  const all = JSON.parse(Buffer.from(readFileSync(DATASET, "utf8"), "base64").toString("utf8")) as BenchTask[]
  const byCategory = CATEGORIES.map((category) => all.filter((task) => task.category === category))
  const ordered: BenchTask[] = []
  for (let round = 0; ordered.length < all.length; round++) {
    let added = false
    for (const tasks of byCategory) {
      const task = tasks[round]
      if (task !== undefined) {
        ordered.push(task)
        added = true
      }
    }
    if (!added) {
      break
    }
  }
  return ordered.slice(0, count)
}

/** The setups' results over the tasks every setup has finished, so they compare like for like. */
function summarize(progress: Progress, setups: string[]) {
  const finishedBy = setups.map((setup) => new Set(Object.keys(progress.runs[setup] ?? {})))
  const common = [...(finishedBy[0] ?? [])].filter((id) => finishedBy.every((set) => set.has(id)))
  return setups.map((setup) => {
    const runs = common.map((id) => progress.runs[setup]?.[id]).filter((run) => run !== undefined)
    const batches = progress.batches.filter((batch) => batch.setup === setup && batch.tasks > 0)
    let readChars = 0
    let minutes = 0
    for (const run of runs) {
      readChars += run.readChars
      minutes += run.durationMs / 60_000
    }
    let averageMb = 0
    for (const batch of batches) {
      averageMb += batch.averageMb / batches.length
    }
    return {
      setup,
      passed: runs.filter((run) => run.grade.verdict === "pass").length,
      impossible: runs.filter((run) => run.grade.verdict === "impossible").length,
      total: runs.length,
      peakMb: Math.max(0, ...batches.map((batch) => batch.peakMb)),
      averageMb: Math.round(averageMb),
      readChars,
      taskMinutes: Math.round(minutes),
    }
  })
}

async function main(): Promise<void> {
  const where = flagValue("--where") ?? "e2b"
  const tasks = allTasks(Number(flagValue("--tasks") ?? 100))
  const batchSize = Number(flagValue("--batch") ?? 10)
  const parallel = Number(flagValue("--parallel") ?? 5)
  const stopAt = Number(flagValue("--stop-at") ?? 80)
  const setups = (flagValue("--setups") ?? "chrome,browserheap").split(",")

  const progress = loadProgress({ model: MODEL_ID, harness: HARNESS, where })
  if (progress.where !== where || progress.model !== MODEL_ID) {
    throw new Error(
      `${PROGRESS_FILE} is a run on ${progress.model}, browser on ${progress.where}. ` +
        "Finish it with the same settings, or delete the file to start over.",
    )
  }
  console.log(
    `BU Bench: ${tasks.length} tasks × ${setups.join(", ")}, ${batchSize} per batch, ${parallel} at once`,
  )
  console.log(`${HARNESS}, ${MODEL_ID} · browser on ${where}`)

  const tunnel = where === "e2b" ? await startTunnel() : null
  let stopReason: string | null = null
  try {
    for (let start = 0; start < tasks.length && stopReason === null; start += batchSize) {
      const batch = tasks.slice(start, start + batchSize)
      for (const setup of setups) {
        const pending = batch.filter((task) => progress.runs[setup]?.[task.task_id] === undefined)
        if (pending.length === 0) {
          continue
        }
        const usage = await usageNow()
        console.log(`\nTasks ${start + 1}–${start + batch.length} · ${usageLine(usage)}`)
        stopReason = overLimit(usage, stopAt)
        if (stopReason !== null) {
          break
        }
        const hitLimit = await runBatch({
          tasks: pending,
          setupName: setup,
          parallel,
          where,
          tunnel,
          progress,
          usageBefore: usage,
        })
        if (hitLimit) {
          stopReason = "a usage limit stopped a task"
          break
        }
      }
    }
  } finally {
    tunnel?.stop()
  }

  const summary = summarize(progress, setups)
  console.log(`\nOver the ${summary[0]?.total ?? 0} tasks every setup has finished:`)
  console.log("| Setup | Passed | Impossible | Peak memory | Average memory | Chars read | Task time |")
  console.log("|---|---|---|---|---|---|---|")
  for (const row of summary) {
    console.log(
      `| ${row.setup} | ${row.passed} / ${row.total} | ${row.impossible} | ${row.peakMb} MB | ${row.averageMb} MB | ` +
        `${Math.round(row.readChars / 1000)}k | ${row.taskMinutes} min |`,
    )
  }

  if (stopReason !== null) {
    console.log(`\nStopped: ${stopReason}.`)
    console.log("Progress is saved. Run the same command again to carry on from here.")
    return
  }
  const measuredAt = new Date().toISOString().replace(/[:.]/g, "-")
  const resultsDir = join(import.meta.dirname, "..", "results")
  mkdirSync(resultsDir, { recursive: true })
  const file = join(resultsDir, `o-${measuredAt}.json`)
  writeFileSync(file, `${JSON.stringify({ ...progress, summary }, null, 2)}\n`)
  console.log(`\nAll done. saved ${file}`)
}

await main()
