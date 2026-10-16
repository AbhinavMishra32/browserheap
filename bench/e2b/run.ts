/**
 * The benchmarks on an E2B sandbox instead of this computer: every browser
 * on the same clean Linux machine, one after another.
 *
 *   node --env-file=../../.env bench/e2b/run.ts template               builds the machine (Dockerfile) on E2B, once
 *   node --env-file=../../.env bench/e2b/run.ts memory 30             memory with 30 tabs, every tool (../run.ts, ../others)
 *   node --env-file=../../.env bench/e2b/run.ts actions               what agents can do, every engine (../actions.ts)
 *   node --env-file=../../.env bench/e2b/run.ts compat                which real sites work, every engine (../compat.ts)
 *   node --env-file=../../.env bench/e2b/run.ts memory 3 --only stagehand    one tool, to try it
 *   node --env-file=../../.env bench/e2b/run.ts idle --each           30 tabs, then 10 idle minutes: memory and CPU, every tool
 *   node --env-file=../../.env bench/e2b/run.ts scale --each          up to 100 tabs or 6.5 GB, every tool
 *   node --env-file=../../.env bench/e2b/run.ts extras --each         waking every tab, 1/4/8 tabs live, 10 agents on one machine
 *
 * --each gives every browser a sandbox of its own, all running at once, so a
 * long job takes as long as its slowest browser. Each line it prints starts
 * with the browser's name.
 *
 * Each job gets a sandbox of its own, so jobs can run at the same time.
 * Needs E2B_API_KEY (O's .env has it). Uploads this folder's code into the
 * sandbox, runs each browser, prints what it prints, and saves the results
 * and what the machine was in bench/results/e2b/<job>/. The sandbox is
 * deleted at the end.
 *
 * Uses:    the e2b SDK, Dockerfile, ../run.ts, ../others, ../actions.ts, ../compat.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { CommandExitError, defaultBuildLogger, Sandbox, Template } from "e2b"

const TEMPLATE = "browserheap-bench"
const repo = resolve(import.meta.dirname, "../..")

const OTHERS = "/opt/bench/bench/others"

interface JobBrowser {
  name: string
  folder: string
  command: string
}

/** Every tool and engine opening TABS tabs, with `extra` flags on each command. */
function everyTool(extra: string): JobBrowser[] {
  return [
    {
      name: "browserheap",
      folder: "/opt/bench",
      command: `node bench/run.ts browserheap TABS --live 2 ${extra}`,
    },
    { name: "chrome-shell", folder: "/opt/bench", command: `node bench/run.ts chrome-shell TABS ${extra}` },
    // The same headless Chrome with Browserheap's blocking: how much of the gap is blocking alone.
    {
      name: "chrome-shell-blocked",
      folder: "/opt/bench",
      command: `node bench/run.ts chrome-shell TABS --block ${extra}`,
    },
    { name: "lightpanda", folder: "/opt/bench", command: `node bench/run.ts lightpanda TABS ${extra}` },
    { name: "obscura", folder: "/opt/bench", command: `node bench/run.ts obscura TABS ${extra}` },
    { name: "agent-browser", folder: OTHERS, command: `node others.mjs agent-browser TABS ${extra}` },
    { name: "playwright-mcp", folder: OTHERS, command: `node others.mjs playwright-mcp TABS ${extra}` },
    { name: "stagehand", folder: OTHERS, command: `node others.mjs stagehand TABS ${extra}` },
    { name: "browser-use", folder: OTHERS, command: `.venv/bin/python browser-use.py TABS ${extra}` },
  ]
}

/** Each job: every browser it runs, and how (TABS is the number of tabs, 30 unless given). */
const JOBS: Record<string, JobBrowser[]> = {
  memory: everyTool(""),
  // 30 tabs, then left alone: what idle tabs cost in memory and CPU over time.
  idle: everyTool("--idle 10"),
  // Past 30 tabs until the browser nears the machine's 8 GB, or dies.
  scale: everyTool("--until-mb 6500").map((browser) => ({
    ...browser,
    command: browser.command.replace("TABS", "100"),
  })),
  extras: [
    {
      name: "wake-all",
      folder: "/opt/bench",
      command: "node bench/run.ts browserheap 30 --live 2 --wake-all",
    },
    { name: "live-1", folder: "/opt/bench", command: "node bench/run.ts browserheap 30 --live 1" },
    { name: "live-4", folder: "/opt/bench", command: "node bench/run.ts browserheap 30 --live 4" },
    { name: "live-8", folder: "/opt/bench", command: "node bench/run.ts browserheap 30 --live 8" },
    {
      name: "agents-browserheap",
      folder: "/opt/bench",
      command: "node bench/agents.ts browserheap 10 10 --until-mb 6500",
    },
    {
      name: "agents-chrome",
      folder: "/opt/bench",
      command: "node bench/agents.ts chrome-shell 10 10 --until-mb 6500",
    },
  ],
  // Which browser setups land on bot checks from a data-centre IP (bot-walls.ts).
  walls: [{ name: "walls", folder: "/opt/bench", command: "node bench/bot-walls.ts" }],
  actions: [
    { name: "browserheap", folder: "/opt/bench", command: "node bench/actions.ts browserheap" },
    { name: "chrome", folder: "/opt/bench", command: "node bench/actions.ts chrome" },
    { name: "lightpanda", folder: "/opt/bench", command: "node bench/actions.ts lightpanda" },
    { name: "obscura", folder: "/opt/bench", command: "node bench/actions.ts obscura" },
  ],
  compat: [
    { name: "chrome", folder: "/opt/bench", command: "node bench/compat.ts chrome" },
    { name: "browserheap", folder: "/opt/bench", command: "node bench/compat.ts browserheap" },
    { name: "lightpanda", folder: "/opt/bench", command: "node bench/compat.ts lightpanda" },
    { name: "obscura", folder: "/opt/bench", command: "node bench/compat.ts obscura" },
  ],
}

/** The code the sandbox needs; its packages and browsers are already in the template. */
const CODE = [
  "src/blocking.ts",
  "src/browser.ts",
  "src/engine.ts",
  "src/index.ts",
  "src/find.ts",
  "src/page-state.ts",
  "src/sleep.ts",
  "src/tab.ts",
  "src/repl/agent-page.ts",
  "src/repl/page-world.ts",
  "src/repl/prepare-code.ts",
  "src/repl/repl.ts",
  "src/repl/session.ts",
  "src/repl/settle.ts",
  "src/repl/snapshot.ts",
  "bench/measure.ts",
  "bench/run.ts",
  "bench/agents.ts",
  "bench/sites.ts",
  "bench/subjects.ts",
  "bench/actions.ts",
  "bench/action-site.ts",
  "bench/png.ts",
  "bench/compat.ts",
  "bench/compat-sites.ts",
  "bench/bot-walls.ts",
  "bench/others/others.mjs",
  "bench/others/browser-use.py",
]

/** E2B doesn't pass the Dockerfile's ENV to the commands it runs. */
const ENV = {
  PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
  HOME: "/root",
  LIGHTPANDA_BIN: "/opt/engines/lightpanda",
  OBSCURA_BIN: "/opt/engines/obscura/obscura",
}

/** What the numbers were measured on. */
const MACHINE_INFO = [
  "uname -srm",
  "nproc",
  "free -m",
  "google-chrome --version",
  "/opt/engines/lightpanda version",
  "/opt/engines/obscura/obscura --version",
  "ls /opt/ms-playwright /root/.agent-browser/browsers",
].join("; ")

const apiKey = process.env.E2B_API_KEY
if (apiKey === undefined || apiKey === "") {
  console.error("E2B_API_KEY isn't set. Run with --env-file pointing at a .env that has it.")
  process.exit(1)
}

const job = process.argv[2] ?? ""
if (job === "template") {
  await buildTemplate()
} else if (JOBS[job] !== undefined) {
  await runJob(job)
} else {
  console.error(`What to run? template, ${Object.keys(JOBS).join(", ")}`)
  process.exit(1)
}

async function buildTemplate(): Promise<void> {
  const dockerfile = readFileSync(resolve(import.meta.dirname, "Dockerfile"), "utf8")
  // The Dockerfile's COPY lines read from the repo (package.json, the lockfiles).
  const template = Template({ fileContextPath: repo }).fromDockerfile(dockerfile)
  console.log(`Building the "${TEMPLATE}" template on E2B…`)
  await Template.build(template, TEMPLATE, {
    apiKey,
    // The most E2B allows without asking: the same for every tool.
    cpuCount: 8,
    memoryMB: 8192,
    onBuildLogs: defaultBuildLogger(),
  })
  console.log(`Built "${TEMPLATE}".`)
}

async function runJob(job: string): Promise<void> {
  const tabsAt = process.argv[3]
  const tabs = tabsAt !== undefined && /^\d+$/.test(tabsAt) ? tabsAt : "30"
  const onlyAt = process.argv.indexOf("--only")
  const only = onlyAt === -1 ? null : process.argv[onlyAt + 1]
  let browsers = JOBS[job] ?? []
  if (only !== null) {
    browsers = browsers.filter((browser) => browser.name === only)
  }

  if (!process.argv.includes("--each")) {
    await runInSandbox(job, browsers, tabs, "")
    return
  }
  // A sandbox per browser, all at once. One failing doesn't stop the rest.
  const runs = browsers.map((browser) => runInSandbox(job, [browser], tabs, `[${browser.name}] `))
  const outcomes = await Promise.allSettled(runs)
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      console.error(`[${browsers[i]?.name}] failed: ${outcome.reason}`)
    }
  })
}

/** Starts a sandbox, runs these browsers in it one after another, saves their results, deletes it. */
async function runInSandbox(
  job: string,
  browsers: JobBrowser[],
  tabs: string,
  prefix: string,
): Promise<void> {
  console.log(`${prefix}Starting a "${TEMPLATE}" sandbox…`)
  const sandbox = await Sandbox.create(TEMPLATE, { apiKey, timeoutMs: 60 * 60_000 })
  try {
    const files = []
    for (const path of CODE) {
      files.push({ path: `/opt/bench/${path}`, data: readFileSync(resolve(repo, path), "utf8") })
    }
    await sandbox.files.write(files)

    const resultsHere = resolve(repo, "bench/results/e2b", job)
    mkdirSync(resultsHere, { recursive: true })
    const machine = await run(sandbox, "/opt/bench", MACHINE_INFO, "")
    writeFileSync(resolve(resultsHere, "machine.txt"), machine)

    for (const browser of browsers) {
      console.log(`\n${prefix}--- ${browser.name}`)
      await run(sandbox, browser.folder, browser.command.replace("TABS", tabs), prefix)
    }

    const folder = "/opt/bench/bench/results"
    for (const entry of await sandbox.files.list(folder)) {
      const text = await sandbox.files.read(`${folder}/${entry.name}`)
      writeFileSync(resolve(resultsHere, entry.name), text)
      console.log(`${prefix}saved bench/results/e2b/${job}/${entry.name}`)
    }
  } finally {
    await sandbox.kill()
  }
}

/** Runs a command as root, printing its output as it comes; a tool failing doesn't stop the others. */
async function run(sandbox: Sandbox, folder: string, command: string, prefix: string): Promise<string> {
  try {
    const result = await sandbox.commands.run(command, {
      cwd: folder,
      user: "root",
      envs: ENV,
      timeoutMs: 30 * 60_000,
      onStdout: (data) => {
        process.stdout.write(withPrefix(data, prefix))
      },
      onStderr: (data) => {
        process.stderr.write(withPrefix(data, prefix))
      },
    })
    return result.stdout
  } catch (error) {
    if (error instanceof CommandExitError) {
      console.error(`${prefix}Failed with exit code ${error.exitCode}.`)
      return error.stdout
    }
    throw error
  }
}

/** Puts the browser's name before every line, so parallel runs can be told apart. */
function withPrefix(text: string, prefix: string): string {
  if (prefix === "") {
    return text
  }
  const lines = text.split("\n")
  const last = lines.pop()
  let out = ""
  for (const line of lines) {
    out += `${prefix}${line}\n`
  }
  if (last !== undefined && last !== "") {
    out += `${prefix}${last}`
  }
  return out
}
