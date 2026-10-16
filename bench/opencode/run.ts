/**
 * BU Bench with opencode as the agent: the same tasks, the same model
 * (gpt-6-luna) and the same grader as bench/o/run.ts, but the agent is
 * opencode with one browser skill, the way people use these tools.
 *
 *   node --env-file=../../.env bench/opencode/run.ts [--tasks 20] [--parallel 10] [--only browserheap]
 *
 * Setups:
 *   browserheap     Browserheap's skill and CLI (this repo's code), its defaults
 *   agent-browser   agent-browser's skill and CLI (0.39.1, as measured), its defaults
 *
 * Each task runs in its own fresh E2B sandbox (template "browserheap-bench",
 * which has both browsers), deleted after. opencode signs in to ChatGPT with
 * the access token from pi's sign-in (~/.pi/agent/auth.json) and no refresh
 * token, so a sandbox can never rotate your sign-in. Grading runs here.
 *
 * Results: bench/results/bu-opencode-progress.json, saved after every task;
 * a stopped run carries on where it left off. Out of git: it holds the tasks.
 *
 * Uses:    ../o/grade.ts, ../o/model.ts, e2b
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Sandbox } from "e2b"
import { type BenchTask, type Grade, gradeTask } from "../o/grade.ts"
import { usageNow } from "../o/model.ts"

const REPO = resolve(import.meta.dirname, "..", "..")
const DATASET = join(REPO, "bench", "o", "data", "BU-Bench-v1-dataset.json.enc")
const PROGRESS_FILE = join(REPO, "bench", "results", "bu-opencode-progress.json")
const CATEGORIES = ["WebBenchREAD", "OM2W2", "InteractionTests", "GAIA", "BrowseComp"]

const TEMPLATE = "browserheap-bench"
const OPENCODE = "opencode-ai@1.19.2"
const MODEL = "openai/gpt-6-luna"
const TASK_MINUTES = 15
/** How much of each tool result goes into the trajectory the grader reads. */
const TRAJECTORY_RESULT_CHARS = 1_500

/** The same instructions the O agent had, naming the skill to use. */
function instructions(skill: string): string {
  return `You complete web tasks with your browser: use the ${skill} skill. Work only from what you see on the pages.
When you're done, give the complete answer the task asks for.`
}

/** E2B doesn't pass the Dockerfile's ENV to the commands it runs. */
const ENV = {
  PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
  HOME: "/root",
}

/** Browserheap's code the CLI needs (its packages are in the template). */
const BROWSERHEAP_CODE = [
  "src/blocking.ts",
  "src/browser.ts",
  "src/engine.ts",
  "src/index.ts",
  "src/find.ts",
  "src/page-state.ts",
  "src/sleep.ts",
  "src/tab.ts",
  "src/cli/client.ts",
  "src/cli/main.ts",
  "src/cli/paths.ts",
  "src/cli/server.ts",
  "src/repl/agent-page.ts",
  "src/repl/page-world.ts",
  "src/repl/prepare-code.ts",
  "src/repl/repl.ts",
  "src/repl/session.ts",
  "src/repl/settle.ts",
  "src/repl/snapshot.ts",
  "skills/browserheap/SKILL.md",
]

interface Setup {
  skill: string
  /** Shell run as root once the files are in place: puts the CLI on PATH and the skill where opencode looks. */
  prepare: string
}

const SKILLS = "/root/.config/opencode/skills"

const SETUPS: Record<string, Setup> = {
  browserheap: {
    skill: "browserheap",
    prepare: [
      `printf '#!/bin/sh\\nexec node /opt/bench/src/cli/main.ts "$@"\\n' > /usr/local/bin/browserheap`,
      "chmod +x /usr/local/bin/browserheap",
      `mkdir -p ${SKILLS}/browserheap`,
      // Installed globally, so the skill's `npx browserheap` is just `browserheap`.
      `sed 's/npx browserheap/browserheap/g' /opt/bench/skills/browserheap/SKILL.md > ${SKILLS}/browserheap/SKILL.md`,
    ].join(" && "),
  },
  "agent-browser": {
    skill: "agent-browser",
    prepare: [
      "ln -sf /opt/bench/bench/others/node_modules/.bin/agent-browser /usr/local/bin/agent-browser",
      `mkdir -p ${SKILLS}/agent-browser`,
      `cp /opt/bench/bench/others/node_modules/agent-browser/skills/agent-browser/SKILL.md ${SKILLS}/agent-browser/`,
    ].join(" && "),
  },
}

/** opencode's settings: the model, everything allowed, and no fetching or searching the web around the browser. */
const OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  model: MODEL,
  permission: { "*": "allow", webfetch: "deny", websearch: "deny" },
}

interface TaskRun {
  taskId: string
  category: string
  setup: string
  answer: string | null
  stoppedBy: string
  steps: number
  durationMs: number
  trajectory: string
  grade: Grade
}

interface Progress {
  model: string
  harness: string
  startedAt: string
  runs: Record<string, Record<string, TaskRun>>
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf8")) as Progress
  }
  return { model: MODEL, harness: `opencode ${OPENCODE}`, startedAt: new Date().toISOString(), runs: {} }
}

function saveProgress(progress: Progress): void {
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true })
  writeFileSync(PROGRESS_FILE, `${JSON.stringify(progress, null, 2)}\n`)
}

/** BU Bench's tasks, taking turns by category, as bench/o/run.ts orders them. */
function allTasks(count: number): BenchTask[] {
  const all = JSON.parse(Buffer.from(readFileSync(DATASET, "utf8"), "base64").toString("utf8")) as BenchTask[]
  const byCategory = CATEGORIES.map((category) => all.filter((task) => task.category === category))
  const ordered: BenchTask[] = []
  for (let round = 0; ordered.length < count; round++) {
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

/** opencode's sign-in: pi's current access token, without the refresh token. */
function openaiAuth(): string {
  const pi = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["openai-codex"]
  return JSON.stringify({
    openai: { type: "oauth", access: pi.access, refresh: "", expires: pi.expires, accountId: pi.accountId },
  })
}

/** A sandbox ready for one task: both browsers (template), opencode, the setup's skill and CLI. */
async function prepareSandbox(setup: Setup): Promise<Sandbox> {
  const sandbox = await Sandbox.create(TEMPLATE, { timeoutMs: (TASK_MINUTES + 10) * 60_000 })
  for (const file of BROWSERHEAP_CODE) {
    await sandbox.files.write(`/opt/bench/${file}`, readFileSync(join(REPO, file), "utf8"), { user: "root" })
  }
  await sandbox.files.write("/root/.local/share/opencode/auth.json", openaiAuth(), { user: "root" })
  await sandbox.files.write("/root/.config/opencode/opencode.json", JSON.stringify(OPENCODE_CONFIG), {
    user: "root",
  })
  await sandbox.files.write("/workspace/AGENTS.md", instructions(setup.skill), { user: "root" })
  await sandbox.commands.run(`npm install -g ${OPENCODE} > /dev/null 2>&1 && ${setup.prepare}`, {
    user: "root",
    envs: ENV,
    timeoutMs: 300_000,
  })
  return sandbox
}

/** One event of `opencode run --format json`, as much of it as we read. */
interface OpencodeEvent {
  type: string
  part?: {
    text?: string
    tool?: string
    state?: { input?: unknown; output?: string; error?: string }
  }
  error?: unknown
}

async function runTask(task: BenchTask, setupName: string): Promise<TaskRun> {
  const setup = SETUPS[setupName] as Setup
  const startedAt = Date.now()
  const sandbox = await prepareSandbox(setup)
  let output = ""
  let stoppedBy = "done"
  try {
    await sandbox.files.write("/workspace/task.txt", task.confirmed_task, { user: "root" })
    const result = await sandbox.commands.run(
      `cd /workspace && timeout ${TASK_MINUTES * 60} opencode run --format json "$(cat task.txt)" 2>/dev/null`,
      { user: "root", envs: ENV, timeoutMs: (TASK_MINUTES + 2) * 60_000 },
    )
    output = result.stdout
  } catch (error) {
    // A non-zero exit still has what opencode printed.
    const failed = error as { stdout?: string; exitCode?: number; message?: string }
    output = failed.stdout ?? ""
    stoppedBy = failed.exitCode === 124 ? "timeout" : `error: ${String(failed.message).slice(0, 200)}`
  } finally {
    await sandbox.kill().catch(() => {})
  }

  const trajectory: string[] = [`TASK: ${task.confirmed_task}`]
  let answer: string | null = null
  let steps = 0
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) {
      continue
    }
    let event: OpencodeEvent
    try {
      event = JSON.parse(line) as OpencodeEvent
    } catch {
      continue
    }
    if (event.type === "text" && event.part?.text) {
      trajectory.push(`AGENT: ${event.part.text}`)
      answer = event.part.text
    }
    if (event.type === "tool_use" && event.part?.tool) {
      steps++
      const state = event.part.state ?? {}
      trajectory.push(`ACTION ${steps}: ${event.part.tool} ${JSON.stringify(state.input)}`)
      const result = state.output ?? state.error ?? ""
      trajectory.push(`RESULT: ${result.slice(0, TRAJECTORY_RESULT_CHARS)}`)
      // A tool after the last words means the agent wasn't done talking.
      answer = null
    }
    if (event.type === "error" && stoppedBy === "done") {
      stoppedBy = `error: ${JSON.stringify(event.error).slice(0, 200)}`
    }
  }
  if (answer !== null) {
    trajectory.push(`FINAL ANSWER: ${answer}`)
  } else if (stoppedBy === "done") {
    stoppedBy = "error: no final answer"
  }

  const joined = trajectory.join("\n")
  const grade = await gradeTask(task, joined)
  return {
    taskId: task.task_id,
    category: task.category,
    setup: setupName,
    answer,
    stoppedBy,
    steps,
    durationMs: Date.now() - startedAt,
    trajectory: joined,
    grade,
  }
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const count = Number(option("tasks", "20"))
const parallel = Number(option("parallel", "10"))
const only = option("only", "")
const setups = only === "" ? Object.keys(SETUPS) : [only]

const progress = loadProgress()
const tasks = allTasks(count)
const usage = await usageNow()
console.log(`opencode BU Bench: ${tasks.length} tasks × ${setups.join(", ")}, ${parallel} at a time`)
console.log(
  `ChatGPT usage: 5-hour ${usage["x-codex-primary-used-percent"]}%, weekly ${usage["x-codex-secondary-used-percent"]}%`,
)

// Every (setup, task) not yet done, alternating setups so both move together.
const todo: Array<{ task: BenchTask; setup: string }> = []
for (const task of tasks) {
  for (const setup of setups) {
    if (progress.runs[setup]?.[task.task_id] === undefined) {
      todo.push({ task, setup })
    }
  }
}

let next = 0
async function worker(): Promise<void> {
  while (next < todo.length) {
    const job = todo[next] as { task: BenchTask; setup: string }
    next++
    let run: TaskRun
    try {
      run = await runTask(job.task, job.setup)
    } catch (error) {
      console.log(
        `  ${job.setup.padEnd(14)} ${job.task.category.padEnd(16)} failed to run: ${String(error).slice(0, 160)}`,
      )
      continue
    }
    progress.runs[job.setup] ??= {}
    ;(progress.runs[job.setup] as Record<string, TaskRun>)[job.task.task_id] = run
    saveProgress(progress)
    console.log(
      `  ${job.setup.padEnd(14)} ${run.category.padEnd(16)} ${run.grade.verdict.padEnd(10)} ` +
        `${run.steps} steps, ${Math.round(run.durationMs / 1000)} s` +
        (run.stoppedBy === "done" ? "" : ` (${run.stoppedBy.slice(0, 80)})`),
    )
  }
}
const workers: Promise<void>[] = []
for (let i = 0; i < parallel; i++) {
  workers.push(worker())
  await sleep(500)
}
await Promise.all(workers)

for (const setup of setups) {
  const runs = tasks.map((task) => progress.runs[setup]?.[task.task_id]).filter((run) => run !== undefined)
  const passed = runs.filter((run) => run.grade.verdict === "pass").length
  const impossible = runs.filter((run) => run.grade.verdict === "impossible").length
  console.log(`${setup}: ${passed} / ${runs.length} passed, ${impossible} impossible`)
}
const after = await usageNow()
console.log(
  `ChatGPT usage: 5-hour ${after["x-codex-primary-used-percent"]}%, weekly ${after["x-codex-secondary-used-percent"]}%`,
)
