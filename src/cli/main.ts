#!/usr/bin/env node
/**
 * The browserheap command: a browser an agent drives from its shell, with
 * tabs that sleep while it isn't using them.
 *
 *   browserheap install                      downloads the browser (Playwright's Chromium headless shell)
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
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import type { ReplResult } from "../repl/repl.ts"
import { runCode, type StartSettings, stopServer } from "./client.ts"
import { imagesFolder } from "./paths.ts"

const USAGE = `browserheap: a browser for agents, where idle tabs sleep.

  browserheap install                      download the browser
  browserheap open <url>                   open a tab, print the page with refs
  browserheap run '<code>'                 run JavaScript in the REPL (--file <path>, or piped in)
  browserheap tabs                         list the tabs
  browserheap screenshot [--out <file>]    save a screenshot of the current tab
  browserheap stop                         close the browser

  --session <name>   a separate browser (default "default")
  --live <n>         tabs live at once (default 2)
  --block <what>     ads (default), all, none

In the REPL: page, tabs, openTab(url), closeTab(page), snapshot(page),
annotatedScreenshot(page), display(image), console.log(…), sleep(ms).
A sleeping tab wakes when you act on it; tab.text() and tab.title() read it without waking.`

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
  install()
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

function install(): void {
  const require = createRequire(import.meta.url)
  const cli = join(require.resolve("playwright-core/package.json"), "..", "cli.js")
  const result = spawnSync(process.execPath, [cli, "install", "--only-shell", "chromium"], {
    stdio: "inherit",
  })
  process.exit(result.status ?? 1)
}

function need(value: string | undefined, usage: string): string {
  if (value === undefined || value === "") {
    console.error(`Usage: ${usage}`)
    process.exit(1)
  }
  return value
}
