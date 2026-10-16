#!/usr/bin/env node
/**
 * The browserheap command: a browser an agent drives from its shell, with
 * tabs that sleep while it isn't using them.
 *
 *   browserheap install                      downloads the browser (Playwright's Chromium)
 *   browserheap skill <claude|codex|folder>  adds the skill to Claude Code, Codex or a folder, then downloads the browser
 *   browserheap open <url>                   opens a tab and prints the page as a tree with refs
 *   browserheap run '<code>'                 runs JavaScript in the REPL (also --file <path>, or piped in)
 *   browserheap tabs                         lists the tabs, live and asleep
 *   browserheap screenshot [--out <file>]    saves a screenshot of the current tab
 *   browserheap stop                         closes the browser
 *
 *   --session <name>    a separate browser with its own tabs (default "default"), for agents side by side
 *   --live <n>          tabs live at once, when this command starts the browser (default 2)
 *   --block <what>      "ads" (default), "all" (also images, video, fonts) or "none", same
 *
 * The first command starts the browser in the background (server.ts); it
 * keeps the tabs and the REPL's variables between commands. What the code
 * prints comes out here; images it displays are saved under
 * ~/.browserheap/images and their paths printed.
 *
 * Uses:    client.ts, paths.ts
 */
import { spawnSync } from "node:child_process"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ReplResult } from "../repl/repl.ts"
import { runCode, type StartSettings, stopServer } from "./client.ts"
import { imagesFolder } from "./paths.ts"

const USAGE = `browserheap: a browser for agents, where idle tabs sleep.

  browserheap install                      download the browser
  browserheap skill <claude|codex|folder>  add the skill to your agent, then download the browser
  browserheap open <url>                   open a tab, print the page with refs
  browserheap run '<code>'                 run JavaScript in the REPL (--file <path>, or piped in)
  browserheap tabs                         list the tabs
  browserheap screenshot [--out <file>]    save a screenshot of the current tab
  browserheap stop                         close the browser

  --session <name>   a separate browser (default "default")
  --live <n>         tabs live at once (default 2)
  --block <what>     ads (default), all, none

In the REPL: page, tabs, openTab(url), closeTab(page), snapshot(page), findInTabs(query),
annotatedScreenshot(page), display(image), console.log(…), sleep(ms).
A sleeping tab wakes when you act on it; tab.text(), tab.title() and findInTabs() read it without waking.`

/** The command line without the --name value pairs. */
const args: string[] = []
const flags: Record<string, string> = {}
const raw = process.argv.slice(2)
for (let index = 0; index < raw.length; index++) {
  const arg = raw[index] ?? ""
  if (arg.startsWith("--")) {
    flags[arg.slice(2)] = raw[index + 1] ?? ""
    index++
  } else {
    args.push(arg)
  }
}

/** Lists the tabs; a sleeping tab's title comes from what was saved, so nothing wakes. */
const TABS_CODE = `for (const [index, tab] of tabs.entries()) {
  const state = tab.isAsleep() ? "asleep" : "live  "
  console.log(\`\${index}\${tab === page ? " *" : "  "} \${state}  \${await tab.title()}  \${tab.url()}\`)
}
if (tabs.length === 0) console.log("No tabs. browserheap open <url> opens one.")`

const session = flags.session ?? "default"
const settings: StartSettings = { maxLive: flags.live, block: flags.block }
const command = args[0]

if (command === undefined || command === "help") {
  console.log(USAGE)
} else if (command === "install") {
  process.exit(installBrowser())
} else if (command === "skill") {
  addSkill(need(args[1], "browserheap skill <claude|codex|folder>"))
  process.exit(installBrowser())
} else if (command === "stop") {
  const stopped = await stopServer(session)
  console.log(stopped ? "Closed the browser." : "No browser was running.")
} else if (command === "open") {
  const url = need(args[1], "browserheap open <url>")
  await runAndPrint(`await openTab(${JSON.stringify(url)}); console.log((await snapshot(page)).tree)`)
} else if (command === "tabs") {
  await runAndPrint(TABS_CODE)
} else if (command === "screenshot") {
  const result = await runCode(session, "display(await page.screenshot())", settings)
  print(result, flags.out)
} else if (command === "run") {
  await runAndPrint(await codeToRun())
} else {
  console.error(`No command "${command}".\n\n${USAGE}`)
  process.exit(1)
}

async function runAndPrint(code: string): Promise<void> {
  print(await runCode(session, code, settings))
}

/** Text to stdout, images to files (their paths to stdout), an error to stderr. */
function print(result: ReplResult, imagePath?: string): void {
  let imageCount = 0
  for (const part of result.content) {
    if (part.type === "text") {
      process.stdout.write(part.text.endsWith("\n") ? part.text : `${part.text}\n`)
      continue
    }
    imageCount++
    const extension = part.mimeType.split("/")[1] ?? "png"
    const path =
      imagePath !== undefined && imageCount === 1
        ? resolve(imagePath)
        : join(imagesFolder(), `${new Date().toISOString().replace(/[:.]/g, "-")}-${imageCount}.${extension}`)
    writeFileSync(path, Buffer.from(part.data, "base64"))
    console.log(`Image: ${path}`)
  }
  if (result.error !== undefined) {
    console.error(result.error.startsWith("Error") ? result.error : `Error: ${result.error}`)
    process.exitCode = 1
  }
}

/** The code for `run`: the argument, --file, or what's piped in. */
async function codeToRun(): Promise<string> {
  if (flags.file !== undefined) {
    return readFileSync(flags.file, "utf8")
  }
  if (args[1] !== undefined) {
    return args.slice(1).join(" ")
  }
  if (process.stdin.isTTY) {
    console.error("browserheap run '<code>', or --file <path>, or pipe the code in.")
    process.exit(1)
  }
  let code = ""
  for await (const chunk of process.stdin) {
    code += chunk
  }
  return code
}

/** Downloads Playwright's Chromium (the full browser, not the headless shell). Returns the exit status. */
function installBrowser(): number {
  const require = createRequire(import.meta.url)
  const cli = join(require.resolve("playwright-core/package.json"), "..", "cli.js")
  const result = spawnSync(process.execPath, [cli, "install", "--no-shell", "chromium"], {
    stdio: "inherit",
  })
  return result.status ?? 1
}

/**
 * Copies the skill (skills/browserheap in this package) into an agent's
 * skills folder: ~/.claude/skills for Claude Code, ~/.codex/skills for Codex,
 * or any folder you name.
 */
function addSkill(where: string): void {
  const folders: Record<string, string> = {
    claude: join(homedir(), ".claude", "skills"),
    codex: join(homedir(), ".codex", "skills"),
  }
  const skills = folders[where] ?? resolve(where)
  // This file is src/cli/main.ts, or dist/cli/main.js once built: two folders below the package.
  const source = fileURLToPath(new URL("../../skills/browserheap", import.meta.url))
  const target = join(skills, "browserheap")
  cpSync(source, target, { recursive: true })
  console.log(`Added the skill: ${target}`)
}

function need(value: string | undefined, usage: string): string {
  if (value === undefined || value === "") {
    console.error(`Usage: ${usage}`)
    process.exit(1)
  }
  return value
}
