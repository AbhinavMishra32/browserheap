/**
 * The agent's browser on an E2B sandbox: O's own cloud computer, booted
 * from the "o-computer-bench" template, dialing O's server on this Mac
 * through a temporary tunnel.
 *
 *   const tunnel = await startTunnel()        wss://….trycloudflare.com/api/computers/connect
 *   const memory = new SandboxMemory()        samples the computer's memory once it boots
 *   …tasks…
 *   const { peakMb, averageMb } = await memory.stop()
 *   await deleteSandbox(id)                   only ever one this runner made
 *   tunnel.stop()
 *
 * Memory is measured inside the sandbox like the other E2B numbers: PSS of
 * the computer program and its Chromium, every 2 seconds, by a small shell
 * loop the runner starts there and reads back at the end.
 *
 * Uses:    cloudflared (brew install cloudflared), the e2b SDK, o-database.ts
 * Used by: run.ts
 */
import { type ChildProcess, spawn } from "node:child_process"
import { Sandbox } from "e2b"
import { cloudMachine } from "./o-database.ts"

export const TEMPLATE = "o-computer-bench"
const SAMPLES_FILE = "/tmp/bench-memory.log"

/** Every 2 s: the PSS of the computer program and its Chromium processes, in MB. */
const SAMPLER = `while true; do
  total=0
  for pid in $(pgrep -f 'computer.mjs|chrom'); do
    kb=$(awk '/^Pss:/ {print $2}' /proc/$pid/smaps_rollup 2>/dev/null)
    total=$((total + \${kb:-0}))
  done
  echo $((total / 1024)) >> ${SAMPLES_FILE}
  sleep 2
done`

function e2bKey(): string {
  const key = process.env.E2B_API_KEY
  if (key === undefined || key === "") {
    throw new Error("E2B_API_KEY isn't set. Run with --env-file pointing at O's .env.")
  }
  return key
}

export interface Tunnel {
  /** What the cloud computer dials: wss://….trycloudflare.com/api/computers/connect */
  serverUrl: string
  stop(): void
}

/** A cloudflared quick tunnel to O's server on port 3000, for as long as the run lasts. */
export async function startTunnel(): Promise<Tunnel> {
  const process_: ChildProcess = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3000"],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  )
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared didn't give an address in 30 s")), 30_000)
    process_.stderr?.on("data", (data: Buffer) => {
      const found = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (found !== null) {
        clearTimeout(timer)
        resolve(found[0])
      }
    })
    process_.once("exit", () => reject(new Error("cloudflared stopped before giving an address")))
  })
  return {
    serverUrl: `${address.replace("https://", "wss://")}/api/computers/connect`,
    stop: () => {
      process_.kill()
    },
  }
}

/** The cloud computer's sandbox, if O has booted it on E2B. */
export function currentSandboxId(): string | null {
  const machine = cloudMachine()
  if (machine === null || machine.provider !== "e2b") {
    return null
  }
  return machine.machineId
}

export async function deleteSandbox(id: string): Promise<void> {
  await Sandbox.kill(id, { apiKey: e2bKey() })
}

/** Samples the cloud computer's memory from the moment O boots it until stop(). */
export class SandboxMemory {
  /** The sandbox it's sampling, once the computer has booted. */
  sandboxId: string | null = null
  private sandbox: Sandbox | null = null
  private timer: NodeJS.Timeout

  constructor() {
    // The computer boots on the agent's first tool call: look for it until it's there.
    this.timer = setInterval(() => {
      void this.startWhenBooted()
    }, 5_000)
  }

  private async startWhenBooted(): Promise<void> {
    if (this.sandbox !== null) {
      return
    }
    const id = currentSandboxId()
    if (id === null) {
      return
    }
    try {
      const sandbox = await Sandbox.connect(id, { apiKey: e2bKey() })
      if (this.sandbox !== null) {
        return
      }
      this.sandbox = sandbox
      this.sandboxId = id
      await sandbox.commands.run(`rm -f ${SAMPLES_FILE}; ${SAMPLER}`, { background: true, user: "root" })
    } catch {
      // Still booting; the next look will do.
    }
  }

  /** Stops looking and returns what was sampled. */
  async stop(): Promise<{ peakMb: number; averageMb: number }> {
    clearInterval(this.timer)
    if (this.sandbox === null) {
      return { peakMb: 0, averageMb: 0 }
    }
    const text = await this.sandbox.files.read(SAMPLES_FILE, { user: "root" }).catch(() => "")
    const samples: number[] = []
    for (const line of text.split("\n")) {
      const mb = Number(line.trim())
      if (line.trim() !== "" && mb > 0) {
        samples.push(mb)
      }
    }
    if (samples.length === 0) {
      return { peakMb: 0, averageMb: 0 }
    }
    let sum = 0
    for (const mb of samples) {
      sum += mb
    }
    return { peakMb: Math.max(...samples), averageMb: Math.round(sum / samples.length) }
  }
}
