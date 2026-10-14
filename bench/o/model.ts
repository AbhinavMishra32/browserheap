/**
 * The model the benchmark agent and its grader talk to: gpt-6-luna through a
 * ChatGPT subscription, signed in with pi (`pi login openai-codex`).
 *
 *   const reply = await ask(context)   one model turn: text and/or tool calls
 *
 * The sign-in lives in pi's ~/.pi/agent/auth.json. We read it from there,
 * and when pi-ai refreshes the token we write the new one back, so pi itself
 * stays signed in (ChatGPT replaces the refresh token on every refresh).
 *
 * Uses:    @earendil-works/pi-ai
 * Used by: grade.ts (and run.ts through it)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  type AssistantMessage,
  type Context,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
} from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"

const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json")
const PROVIDER = "openai-codex"
/**
 * gpt-6-luna on medium reasoning: light on the ChatGPT subscription's usage
 * (gpt-5.5 is API-only now). BENCH_MODEL picks another.
 */
export const MODEL_ID = process.env.BENCH_MODEL ?? "gpt-6-luna"

/**
 * pi-ai's credential store, kept in pi's auth file. Changes (token refreshes)
 * happen one at a time and are written straight back to the file.
 */
class PiAuthFile implements CredentialStore {
  /** The change going on now; the next one waits for it. */
  private queue: Promise<unknown> = Promise.resolve()

  async read(providerId: string): Promise<Credential | undefined> {
    return readAuthFile()[providerId]
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const infos: CredentialInfo[] = []
    for (const [providerId, credential] of Object.entries(readAuthFile())) {
      infos.push({ providerId, type: credential.type })
    }
    return infos
  }

  modify(
    providerId: string,
    change: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const result = this.queue.then(async () => {
      const saved = readAuthFile()
      const next = await change(saved[providerId])
      if (next === undefined) {
        return saved[providerId]
      }
      // Re-read, so whatever pi wrote meanwhile for other providers is kept.
      const latest = readAuthFile()
      latest[providerId] = next
      writeFileSync(PI_AUTH_FILE, `${JSON.stringify(latest, null, 2)}\n`, { mode: 0o600 })
      return next
    })
    this.queue = result.catch(() => {})
    return result
  }

  async delete(): Promise<void> {
    throw new Error("The benchmark never signs out of pi")
  }
}

function readAuthFile(): Record<string, Credential> {
  return JSON.parse(readFileSync(PI_AUTH_FILE, "utf8")) as Record<string, Credential>
}

const models = createModels({ credentials: new PiAuthFile() })
models.setProvider(openaiCodexProvider())

const model = models.getModel(PROVIDER, MODEL_ID)
if (model === undefined) {
  throw new Error(`pi-ai doesn't know ${PROVIDER}/${MODEL_ID}`)
}

/** One model turn. Fails if the model returns an error instead of a reply. */
export async function ask(context: Context): Promise<AssistantMessage> {
  if (model === undefined) {
    throw new Error("unreachable")
  }
  const reply = await models.completeSimple(model, context, { reasoning: "medium" })
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(`Model failed: ${reply.errorMessage ?? reply.stopReason}`)
  }
  return reply
}

/**
 * What ChatGPT says about your usage limits right now: the headers its
 * Codex backend sends with every reply (how much of each window is used,
 * and when it resets). Costs one tiny model call.
 */
export async function usageNow(): Promise<Record<string, string>> {
  if (model === undefined) {
    throw new Error("unreachable")
  }
  const found: Record<string, string> = {}
  const context: Context = { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] }
  await models.completeSimple(model, context, {
    reasoning: "minimal",
    // pi only reports response headers over plain HTTP, not its default WebSocket.
    transport: "sse",
    onResponse: (response) => {
      for (const [name, value] of Object.entries(response.headers ?? {})) {
        // Not x-codex-turn-state: that's the conversation's state, not usage.
        if (/limit|used|credit|plan|reset|window/i.test(name)) {
          found[name] = String(value)
        }
      }
    },
  })
  return found
}
