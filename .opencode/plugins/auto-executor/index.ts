// auto-executor — an opencode plugin (V2 plugin API)
//
// Sequential execution of a task split into numbered steps (configured in a
// JSON file): the plugin starts a new chat session for each step, waits until
// the agent finishes, and then moves on to the next step.
//
// Commands:
//   /auto-exec <path-to-json-file>  – start the step sequence
//   /stop-auto-execution            – force-stop the run
//
// Configuration file (JSON):
// {
//   "prompt":      "prompt text with a {step} placeholder for the step number",
//   "from":        1,          // first step (optional, default 1)
//   "to":          10,         // last step
//   "max_context": 60000,      // context threshold in tokens
//   "model":       "provider/model-id",   // optional; defaults to the model selected in the chat
//   "agent":       "build",               // optional; defaults to the agent of the current chat
//   "tool_description": "..."  // optional description of the tool passed to the agent
//   "max_handoffs": 10         // optional handoff limit per step
//   "max_instruction_attempts": 5  // optional limit of handoff instruction retries per session
//   "instruction_retry_seconds": 60  // optional minimum pause between repeated handoff instructions (0 = off)
//   "heartbeat_seconds": 45    // optional UI heartbeat frequency (0 = disabled)
//   "stall_timeout_seconds": 900  // optional; abort a turn that made no progress for this long (0 = disabled)
//   "accumulate_handoffs": true  // optional; handoff descriptions accumulate within a step (default true)
// }
//
// Heartbeat: the plugin reports in the TUI that it is alive — a heartbeat
// every heartbeat_seconds plus messages on every significant event:
// a new task (step) started, an agent turn finished, a handoff,
// run finished/error. No heartbeat = the plugin has died. In opencode v2 the
// server plugin has no TUI access, so toasts are published as `toast` events of
// the `auto-executor` RPC; the companion TUI plugin (tui.ts, loaded
// automatically from the same plugin directory) subscribes to them and shows
// them via `ui.toast.show`. Without the TUI attached the events are simply
// dropped (live-only), which is harmless.
//
// When context usage during a step exceeds max_context, the agent receives
// a message and calls the handoff_save tool, which starts a new conversation
// (original prompt + the descriptions of ALL earlier handoffs of the step, then the
// new one — handoffs accumulate within a step, toggle "accumulate_handoffs", default true,
// and are cleared at the step change). The plugin starts the
// continuation turn without waiting for it to finish (fire-and-forget) — thanks to this
// threshold monitoring covers the continuation session from its first message (previously
// execute() waited for the whole continuation turn and meanwhile disabled mid-turn
// monitoring: the continuation of step 1 of run T8 bloated to ~184k tokens without steering).
// The handoff_save tool is ALWAYS visible (we neither remove it from the model tool
// set nor deny it by permission — hiding it would block handing off work mid-turn; the
// V2 prompt input has no per-prompt tool flags anyway). Protection against spontaneous
// calls is provided by the threshold: execute() refuses until the session context exceeds
// max_context. The threshold is also enforced DURING the turn (the per-step
// tokens of session.step.ended/.failed = the real current context): an exceedance injects a steering prompt
// asking for a handoff; once max_instruction_attempts is exhausted the turn is aborted,
// so that super-long sessions do not appear. If the agent still does not hand off the
// work, the instruction is repeated after the turn ends (same attempt counter).
//
// V2 notes (compared to the V1 implementation):
// - the per-step context counter comes from the `session.step.ended` /
//   `session.step.failed` events (tokens of the single finished LLM request =
//   the real current context). `session.usage.updated` is a CUMULATIVE billing
//   sum for the whole session (each step re-counts the entire prompt) and is
//   NOT comparable to max_context — using it fired the handoff instruction
//   after a few tool-call steps while the real context was still tiny
//   (lemonade/Ornith-1.5: steering at ~14.5k real context, sum >120k);
// - turn end = `session.execution.succeeded` (opencode >= 2.0.26 emits NO
//   `session.idle` bus event — "idle" exists there only as a TUI command;
//   waiting for it hung the run after the first finished turn); `session.idle`
//   is kept as a fallback for older versions. Aborted/failed turns are
//   recognized via `session.execution.interrupted` / `session.execution.failed`,
//   and a stall watchdog aborts a turn that stopped producing events entirely,
// - the V1 `tool.definition` hook became a `ctx.session.hook("context", ...)` —
//   it fires on every model request, so the accumulation note still follows
//   the configuration of the active run,
// - the V1 `config` hook (command registration) became `ctx.command.transform`
//   with own executors — the commands no longer submit an LLM prompt that has
//   to be cancelled by throwing from `command.execute.before`,
// - model/agent are applied to run sessions at creation time
//   (`ctx.session.create({ title, model, agent })`), not per prompt.

import { Plugin } from "@opencode/plugin"
import { AutoExecRpc } from "./rpc.ts"
import fs from "node:fs"
import path from "node:path"

const START_COMMAND = "auto-exec"
const STOP_COMMAND = "stop-auto-execution"
const DEFAULT_HANDOFF_TOOL = "handoff_save"
const DEFAULT_INSTRUCTION_ATTEMPTS = 5
// Minimum pause between REPEATED handoff instructions (applies to the mid-turn
// steering and the post-turn retries alike). A repeat that chases the previous
// instruction within seconds burns the whole attempt budget while the model is
// still acting on the first one (it usually has to finish its current tool call
// before it can call the handoff tool), floods the context with duplicate
// instructions (each of them also costs tokens) and aborts turns that would
// have handed off given a little more time. The FIRST instruction for a session
// is never delayed; 0 disables the pause.
const DEFAULT_INSTRUCTION_RETRY_SECONDS = 60
const DEFAULT_HEARTBEAT_SECONDS = 45
// Stall watchdog: abort a turn that produced no progress for this long (0 =
// off). "No progress" = no bus events AND no conversation change (the
// liveness probe). Safety net against opencode renaming/dropping turn-end
// events again (2.0.26 removed the session.idle bus event the V1 port relied
// on) and against provider requests that hang forever.
const DEFAULT_STALL_SECONDS = 900
// Grace period for an abort to land: after the stall watchdog interrupts a
// session the run loop does NOT advance until the turn has really ended —
// resolved either by the session.execution.interrupted event or, at the
// latest, after this long (a broken event stream must not hang the loop).
const QUIESCE_GRACE_MS = 30_000
// Watchdog tick and liveness probe period (probe every 4th tick = ~60 s).
const WATCHDOG_TICK_MS = 15_000
const PROBE_EVERY_TICKS = 4

type RunConfig = {
  prompt: string
  from: number
  to: number
  max_context: number
  model?: string
  agent?: string
  tool_description?: string
  max_handoffs?: number
  max_instruction_attempts?: number
  instruction_retry_seconds?: number
  heartbeat_seconds?: number
  stall_timeout_seconds?: number
  accumulate_handoffs?: boolean
}

// Fills in the configuration with default model/agent taken over from the control session
// (i.e. the chat in which the user typed /auto-exec). Values given
// explicitly in the JSON file take precedence.
type Ctx = Parameters<ReturnType<typeof Plugin.define>["setup"]>[0]

async function resolveDefaults(
  ctx: Ctx,
  controllerSessionID: string,
  cfg: RunConfig,
): Promise<void> {
  if (cfg.model && cfg.agent) return
  try {
    const info = await ctx.session.get({ sessionID: controllerSessionID })
    if (!info) return
    if (!cfg.model && info.model?.providerID && info.model?.id) {
      cfg.model = `${info.model.providerID}/${info.model.id}`
    }
    if (!cfg.agent && typeof info.agent === "string" && info.agent) {
      cfg.agent = info.agent
    }
  } catch {
    // no access to the control session — the server defaults remain
  }
}

type RunState = {
  cfg: RunConfig
  step: number
  continuation: number
  // descriptions of the handoffs made in the current step — they accumulate
  // within the step (the continuation prompt contains all of them) and are
  // cleared at the start of the next step
  handoffSummaries: string[]
  sessionID: string
  instructionAttempts: Map<string, number>
  // time of the last handoff instruction sent to a session (mid-turn steering
  // or post-turn retry) — paces the REPEATS: a new instruction is only sent
  // when instruction_retry_seconds have passed since this timestamp
  lastInstructionAt: Map<string, number>
  stopping: boolean
  lastActivity: number
  beatTimer: ReturnType<typeof setInterval> | null
  // set while waiting for the steering injected into an ongoing turn to be
  // processed (released on the next step end) — replaces the V1 per-message
  // dedup (handledMsgs): the step events carry no message id
  steeringPending: Set<string>
  // sessions of this run whose execution was interrupted (aborted) since the
  // last turn-end handling — the V2 equivalent of the V1 MessageAbortedError check
  interruptedSessions: Set<string>
  // structured error of a failed execution per session (session.execution.failed)
  failedExecutions: Map<string, { type?: string; message: string }>
  finalAttempts: Map<string, number>
  // session with an ongoing "last chance" turn — the mid-turn handler must not
  // abort or steer it (attempts already exhausted, the abort would kill the model before
  // it managed to call the handoff tool — E2E diag2 r3)
  finalChance: string | null
  // last known per-step token usage per session (from session.step.ended /
  // session.step.failed — the tokens of the single finished LLM request, i.e.
  // the real current context). The tool executes BEFORE the current usage gets
  // recorded (and after an abort the message tokens may be zeroed) — the
  // snapshot in execute() then sees too little and rejects a legitimate
  // handoff (E2E diag2 r4). Hence the guard uses max(snapshot, lastKnown).
  // NOT sourced from session.usage.updated — that event carries the
  // cumulative billing sum of the whole session (each step re-counts the
  // entire prompt), which inflated the counter ~8× over the real context and
  // made the threshold (and this guard) fire way too early.
  lastTokens: Map<string, number>
  // every session created by this run (steps + handoff continuations) —
  // stopRun interrupts ALL of them, so a hung turn from an earlier step
  // cannot outlive the run (E2E platformgame 2026-10-12: the step-8 turn
  // survived the watchdog and later froze llama-server's only slot)
  sessions: Set<string>
}

type Waiter = { resolve: () => void }

let run: RunState | null = null
const waiters = new Map<string, Waiter>()

function registerWaiter(sessionID: string): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  waiters.set(sessionID, { resolve })
  return { promise, resolve }
}

function isMine(sessionID: string, resolve: () => void): boolean {
  return waiters.get(sessionID)?.resolve === resolve
}

function parseModel(ref: string): { providerID: string; id: string } {
  const idx = ref.indexOf("/")
  if (idx <= 0) throw new Error(`model musi mieć format "provider/model-id", otrzymano: "${ref}"`)
  return { providerID: ref.slice(0, idx), id: ref.slice(idx + 1) }
}

function loadConfig(raw: string): RunConfig {
  const file = raw
  const text = fs.readFileSync(file, "utf8")
  const json = JSON.parse(text)

  const cfg: RunConfig = {
    prompt: typeof json.prompt === "string" ? json.prompt : "",
    from: Number(json.from ?? 1),
    to: Number(json.to ?? json.from ?? 1),
    max_context: Number(json.max_context ?? 0),
    model: json.model ? String(json.model) : undefined,
    agent: json.agent ? String(json.agent) : undefined,
    tool_description: json.tool_description ? String(json.tool_description) : undefined,
    max_handoffs: json.max_handoffs !== undefined ? Number(json.max_handoffs) : undefined,
    max_instruction_attempts:
      json.max_instruction_attempts !== undefined ? Number(json.max_instruction_attempts) : undefined,
    instruction_retry_seconds:
      json.instruction_retry_seconds !== undefined
        ? Number(json.instruction_retry_seconds)
        : undefined,
    heartbeat_seconds:
      json.heartbeat_seconds !== undefined ? Number(json.heartbeat_seconds) : undefined,
    accumulate_handoffs:
      json.accumulate_handoffs !== undefined ? Boolean(json.accumulate_handoffs) : undefined,
  }

  if (!cfg.prompt) throw new Error(`plik ${file}: brak pola "prompt"`)
  if (!cfg.prompt.includes("{step}")) throw new Error(`plik ${file}: pole "prompt" musi zawierać znacznik {step}`)
  if (!Number.isFinite(cfg.from) || cfg.from < 1) throw new Error(`plik ${file}: nieprawidłowe "from"`)
  if (!Number.isFinite(cfg.to) || cfg.to < cfg.from) throw new Error(`plik ${file}: "to" musi być >= "from"`)
  if (!Number.isFinite(cfg.max_context) || cfg.max_context <= 0)
    throw new Error(`plik ${file}: "max_context" (tokeny) jest wymagane i musi być > 0`)
  if (cfg.max_instruction_attempts !== undefined) {
    if (!Number.isFinite(cfg.max_instruction_attempts) || cfg.max_instruction_attempts < 1)
      throw new Error(`plik ${file}: "max_instruction_attempts" musi być liczbą >= 1`)
  }
  if (cfg.instruction_retry_seconds !== undefined) {
    if (!Number.isFinite(cfg.instruction_retry_seconds) || cfg.instruction_retry_seconds < 0)
      throw new Error(`plik ${file}: "instruction_retry_seconds" musi być liczbą >= 0`)
  }
  if (cfg.heartbeat_seconds !== undefined) {
    if (!Number.isFinite(cfg.heartbeat_seconds) || cfg.heartbeat_seconds < 0)
      throw new Error(`plik ${file}: "heartbeat_seconds" musi być liczbą >= 0`)
    if (cfg.heartbeat_seconds > 0 && cfg.heartbeat_seconds < 5)
      throw new Error(`plik ${file}: "heartbeat_seconds" musi być 0 (wyłączone) albo >= 5`)
  }
  if (json.accumulate_handoffs !== undefined && typeof json.accumulate_handoffs !== "boolean")
    throw new Error(`plik ${file}: "accumulate_handoffs" musi być wartością logiczną (true/false)`)
  return cfg
}

function renderPrompt(template: string, step: number): string {
  return template.split("{step}").join(String(step))
}

// V2 tool input schema (JSON Schema) — the "description" argument of handoff_save
const handoffInputSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description:
        "A very detailed description: what has been done, what conclusions were reached, which files were changed, what remains to be done.",
    },
  },
  required: ["description"],
  additionalProperties: false,
} as const

export const AutoExecutor = Plugin.define({
  id: "auto-executor",
  async setup(ctx) {
    const toolName =
      typeof ctx.options?.tool_name === "string" && ctx.options.tool_name
        ? ctx.options.tool_name
        : DEFAULT_HANDOFF_TOOL
    const directory = ctx.location.directory

    // The V2 plugin context has no app.log — plugin console output lands in the
    // server log (service stdout).
    const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
      const text = `[auto-executor] ${message}`
      if (level === "error") console.error(text, extra ? JSON.stringify(extra) : "")
      else if (level === "warn") console.warn(text, extra ? JSON.stringify(extra) : "")
      else console.log(text, extra ? JSON.stringify(extra) : "")
    }

    // Toasts go through the plugin RPC as `toast` events; the companion TUI
    // plugin (tui.ts) renders them. Without a TUI attached they are dropped.
    const rpcRegistration = await ctx.rpc.register(AutoExecRpc, {})
    const toast = (
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
      duration?: number,
    ) => {
      void rpcRegistration.events
        .emit("toast", { message, variant, ...(duration !== undefined ? { duration } : {}) })
        .catch(() => {})
    }

    // ── sending a turn to a session ───────────────────────────────────────────
    // Starts a turn and does NOT wait for it to finish — the turn end will be handled
    // by the waiter that monitorStep waits on. Used by the handoff: if execute() waited
    // for the whole continuation turn, threshold monitoring would be blocked for the
    // entire duration of that turn (incident T8/continuation 1 — the session bloated to
    // ~184k tokens without steering; the user forced the handoff manually).
    // ctx.session.prompt admits the prompt and returns immediately (the V2
    // equivalent of the V1 promptAsync); waiting is done via the waiter/events.
    async function startTurn(sessionID: string, text: string): Promise<void> {
      if (run) run.lastActivity = Date.now()
      const waiter = registerWaiter(sessionID)
      try {
        await ctx.session.prompt({ sessionID, text })
      } catch (error) {
        if (isMine(sessionID, waiter.resolve)) waiters.delete(sessionID)
        waiter.resolve()
        throw error
      }
    }

    // steering=true: the message is injected into an ONGOING turn (V2 delivery
    // "steer", the prompt default). In that case we do not register a waiter —
    // the turn end is handled anyway by the original turn's waiter; double
    // registration would invalidate its resolve.
    async function sendTurn(sessionID: string, text: string, steering = false) {
      if (run) run.lastActivity = Date.now()
      if (steering) {
        await ctx.session.prompt({ sessionID, text }).catch((error: unknown) => {
          log("warn", `steering mid-turn nie dotarł: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      await startTurn(sessionID, text)
      await waitTurnGuarded(run, sessionID)
    }

    function waitTurn(sessionID: string): Promise<void> {
      const waiter = waiters.get(sessionID)
      if (!waiter) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const original = waiter.resolve
        waiter.resolve = () => {
          original()
          resolve()
        }
      })
    }

    // Like waitTurn, but with a stall watchdog: if the turn shows no progress
    // (no events and no conversation change) for stall_timeout_seconds, the
    // session is interrupted and the wait ends as an "interrupted" turn instead
    // of hanging forever. Safety net against opencode versions that rename or
    // drop turn-end events (2.0.26 removed the session.idle bus event the V1
    // port relied on — the run then hung after the first finished turn) and
    // against provider requests that hang forever (E2E platformgame
    // 2026-10-12: llama-server froze on a request with zero generated tokens
    // for >7 minutes, blocking its only slot). Every event refreshes
    // lastActivity, and the liveness probe below refreshes it when the
    // conversation changes, so a healthy long turn is never aborted — only a
    // truly stuck one.
    //
    // Liveness probe: some providers emit NO bus events while a single message
    // streams (local llama.cpp/lemonade backends send usage only at the end of
    // a request). A healthy local model can then take >15 min for ONE response
    // (E2E platformgame 2026-10-12: an 18.8k-token message streamed for
    // ~20 min, the watchdog fired at 900 s and the loop advanced while the
    // turn kept running). The probe fingerprints the tail of the conversation
    // (message count, last message's time fields, size of its last part);
    // any change means the turn is progressing.
    function conversationFingerprint(list: unknown[]): string {
      const last = list[list.length - 1] as
        | { time?: Record<string, unknown>; content?: unknown[] }
        | undefined
      if (!last) return "0"
      const content = Array.isArray(last.content) ? last.content : []
      const lastPart = content[content.length - 1] as unknown
      return `${list.length}|${JSON.stringify(last.time ?? {})}|${content.length}|${
        lastPart === undefined ? "" : JSON.stringify(lastPart).length
      }`
    }

    const livenessFingerprints = new Map<string, string>()

    async function probeLiveness(state: RunState, sessionID: string, waiter: Waiter): Promise<void> {
      try {
        if (waiters.get(sessionID) !== waiter || state.stopping) return
        const list = (await ctx.session.context({ sessionID })) as unknown as unknown[]
        if (waiters.get(sessionID) !== waiter || state.stopping) return
        const fingerprint = conversationFingerprint(list ?? [])
        const previous = livenessFingerprints.get(sessionID)
        if (previous !== undefined && previous !== fingerprint) state.lastActivity = Date.now()
        livenessFingerprints.set(sessionID, fingerprint)
      } catch {
        // context fetch failed — the watchdog then decides on events alone
      }
    }

    async function waitTurnGuarded(state: RunState | null, sessionID: string): Promise<void> {
      const waiter = waiters.get(sessionID)
      if (!waiter) return
      const seconds = state?.cfg.stall_timeout_seconds ?? DEFAULT_STALL_SECONDS
      if (!state || seconds <= 0) {
        await waitTurn(sessionID)
        return
      }
      let timer: ReturnType<typeof setInterval> | null = null
      let ticks = 0
      try {
        await new Promise<void>((resolve) => {
          // Single funnel: every resolution path (event handler, watchdog
          // grace, stopRun) goes through waiter.resolve.
          const original = waiter.resolve
          waiter.resolve = () => {
            livenessFingerprints.delete(sessionID)
            original()
            resolve()
          }
          timer = setInterval(() => {
            if (waiters.get(sessionID) !== waiter) {
              // Resolved elsewhere (handler deletes the waiter first) — stop watching.
              if (timer) clearInterval(timer)
              timer = null
              resolve()
              return
            }
            ticks++
            if (ticks % PROBE_EVERY_TICKS === 0) void probeLiveness(state, sessionID, waiter)
            if (state.stopping || Date.now() - state.lastActivity <= seconds * 1000) return
            // ── stall confirmed: no progress for `seconds` ──
            if (timer) clearInterval(timer)
            timer = null
            state.interruptedSessions.add(sessionID)
            state.steeringPending.delete(sessionID)
            state.lastActivity = Date.now()
            log(
              "warn",
              `krok ${state.step}: brak postępu przez ${seconds} s — przerywam zawieszoną turę (sesja ${sessionID})`,
            )
            toast(
              `Auto-exec: brak postępu przez ${seconds} s — przerywam zawieszoną turę kroku ${state.step}.`,
              "warning",
              10000,
            )
            // Actually abort the hung turn. Previously the watchdog only
            // resolved the waiter — the turn kept running while the loop
            // advanced to the next step; the two turns then fought over a
            // serial local backend's single KV-cache slot, and an unowned
            // "zombie" turn could outlive the run entirely (E2E platformgame
            // 2026-10-12: the step-8 turn streamed ~6 min past its own
            // watchdog, its next request froze llama-server's only slot, and
            // the run went on to spawn further steps against a dead backend).
            void ctx.session.interrupt({ sessionID }).catch(() => {})
            // Do not unblock the loop until the turn has really ended: the
            // session.execution.interrupted event resolves the waiter through
            // handleEvent; the grace timer is only the fallback for a broken
            // event stream (the very reason the watchdog exists).
            const grace = setTimeout(() => {
              if (waiters.get(sessionID) === waiter) {
                waiters.delete(sessionID)
                waiter.resolve()
              }
            }, QUIESCE_GRACE_MS)
            const wrapped = waiter.resolve
            waiter.resolve = () => {
              clearTimeout(grace)
              wrapped()
            }
          }, WATCHDOG_TICK_MS)
        })
      } finally {
        if (timer) clearInterval(timer)
      }
    }

    // ── heartbeat ─────────────────────────────────────────────────────────────
    const beat = (state: RunState) => {
      if (state.stopping || run !== state) return
      const since = Math.max(0, Math.round((Date.now() - state.lastActivity) / 1000))
      // The TUI displays ONE toast at a time and queues the rest (the "+N more"
      // badge). A heartbeat must therefore close before the next beat arrives:
      // with heartbeat_seconds=5 and an 8 s toast the queue grew forever
      // (E2E platformgame 2026-10-12: "+126 more" after ~30 min — arrivals
      // 1/5 s outpaced dismissals 1/8 s by ~0.075/s). Cap the display time
      // below the interval; the 8 s cap keeps the comfortable default (45 s).
      const intervalMs = (state.cfg.heartbeat_seconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000
      toast(
        `Auto-exec tętno: krok ${state.step}/${state.cfg.to}, kontynuacja ${state.continuation}/${state.cfg.max_handoffs ?? 10}, ostatnia aktywność ${since} s temu`,
        "info",
        Math.max(1500, Math.min(8000, intervalMs - 1000)),
      )
    }

    function startBeat(state: RunState): void {
      const seconds = state.cfg.heartbeat_seconds ?? DEFAULT_HEARTBEAT_SECONDS
      if (seconds <= 0 || state.beatTimer) return
      state.beatTimer = setInterval(() => beat(state), seconds * 1000)
    }

    function stopBeat(state: RunState): void {
      if (state.beatTimer) {
        clearInterval(state.beatTimer)
        state.beatTimer = null
      }
    }

    // ── session state after a finished turn ───────────────────────────────────
    type SessionSnapshot = { tokens: number; error?: { type?: string; message: string } }

    // Structural subset of an assistant session message (SessionMessageAssistant)
    // — avoids importing the full message union just for typing.
    type AssistantLike = {
      tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
      error?: { type?: string; message?: string }
    }

    async function snapshot(sessionID: string): Promise<SessionSnapshot> {
      const list = await ctx.session.context({ sessionID })
      // Last assistant message (any) — we take the error from it (for the aborted
      // turn logic in monitorStep). Tokens are taken from the last ERROR-FREE
      // assistant message: an aborted/interrupted turn may be zeroed, which
      // otherwise cheated the threshold and silenced the "last chance" path
      // after an abort (E2E diag2: the step ended silently).
      let last: AssistantLike | undefined
      let lastHealthy: AssistantLike | undefined
      for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i]
        if (info?.type !== "assistant") continue
        if (!last) last = info
        if (!lastHealthy && !info.error) lastHealthy = info
        if (last && lastHealthy) break
      }
      if (!last) return { tokens: 0 }
      const t = (lastHealthy ?? last).tokens ?? {}
      const tokens = (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      const error = last.error
        ? { type: last.error.type, message: String(last.error.message ?? last.error) }
        : undefined
      return { tokens, error }
    }

    function instructionText(state: RunState, attempt: number, maxAttempts: number, final = false): string {
      const desc =
        state.cfg.tool_description ??
        `The tool is used to hand off the work to a new conversation. In the "description" argument describe in great detail: what has been done so far, what conclusions were reached, which files were changed and what still remains to be done within the current step. After the tool is called, your work will be continued in a new conversation that will receive this description along with the original task.`
      const lines: string[] = []
      if (final) {
        lines.push(
          `LAST CHANCE: Your previous turn was aborted because the context (${state.cfg.max_context} tokens) was exceeded and you did not hand off the work. This is a clean turn — do not continue the current task.`,
        )
        lines.push(`Call the ${toolName} tool NOW as the only action in this turn.`)
      } else {
        lines.push(`You are running out of context window. Call the ${toolName} tool. Describe in detail what you have done and what conclusions you have reached. We will continue in a new conversation.`)
      }
      lines.push(``)
      lines.push(`Information about the ${toolName} tool:`)
      lines.push(desc)
      lines.push(``)
      if (state.cfg.accumulate_handoffs !== false) {
        lines.push(accumulateNote)
        lines.push(``)
      }
      if (attempt > 1 && !final) {
        lines.push(`NOTE: this is a repeated request (attempt ${attempt}/${maxAttempts}). You did not call the ${toolName} tool in the previous turn.`)
        lines.push(``)
      }
      lines.push(
        final
          ? `In the "description" argument provide a full description of the state of the work and do not call any other tools.`
          : `Call it now (as the only action in this turn) and provide a full description of the state of the work in the "description" argument. Stop executing further steps of the task.`,
      )
      return lines.join("\n")
    }

    // ── session creation ──────────────────────────────────────────────────────
    // The model/agent of a run session are fixed at creation time (the V2
    // prompt input carries neither a model nor an agent — the session default
    // applies, set here from the run config).
    async function createSession(state: RunState, title: string): Promise<string> {
      const body: { title: string; model?: { providerID: string; id: string }; agent?: string } = { title }
      if (state.cfg.model) body.model = parseModel(state.cfg.model)
      if (state.cfg.agent) body.agent = state.cfg.agent
      const info = await ctx.session.create(body)
      state.sessions.add(info.id)
      return info.id
    }

    // ── step-overlap guard ────────────────────────────────────────────────────
    // Never open the next step's turn while the previous session's turn may
    // still be running. On a serial local backend (llama-server --parallel 1)
    // two concurrent turns fight over the single KV-cache slot: every handover
    // evicts the other's cache and forces a full re-prefill of the whole
    // context. The normal paths (turn-end events, the watchdog with its grace
    // period) all guarantee a dead turn; this is the belt-and-suspenders for
    // anything else. ctx.session.wait resolves when the session has no ongoing
    // work; every call is capped, so an interrupt that never lands cannot hang
    // the loop forever.
    async function waitIdle(sessionID: string, timeoutMs: number): Promise<boolean | null> {
      // true = idle, false = still busy after the cap, null = endpoint unavailable
      const call = ctx.session.wait({ sessionID })
      const cap = new Promise<boolean | null>((resolve) => setTimeout(() => resolve(false), timeoutMs))
      const raced = await Promise.race([
        call.then(
          () => true,
          (error: unknown) => {
            log("debug", `session.wait niedostępny: ${error instanceof Error ? error.message : String(error)}`)
            return null as boolean | null
          },
        ),
        cap,
      ])
      void call.catch(() => {})
      return raced
    }

    async function quiesceSession(sessionID: string): Promise<void> {
      const started = Date.now()
      for (;;) {
        const remaining = QUIESCE_GRACE_MS - (Date.now() - started)
        if (remaining <= 0) break
        const result = await waitIdle(sessionID, remaining)
        if (result !== false) return // idle, or endpoint unavailable (event paths remain the guarantee)
        await new Promise((r) => setTimeout(r, 1000))
      }
      log(
        "warn",
        `sesja ${sessionID} nadal zajęta po ${Math.round(QUIESCE_GRACE_MS / 1000)} s — przerywam jej turę przed kolejnym krokiem`,
      )
      await ctx.session.interrupt({ sessionID }).catch(() => {})
      await waitIdle(sessionID, QUIESCE_GRACE_MS)
    }

    // ── the handoff tool ──────────────────────────────────────────────────────
    const handoffDescription = `Save a handover message for the new conversation that will continue the current task. Call it only when the system explicitly asks you to (the context window is running out).`
    // Appended to the tool description (via the session "context" hook) and to the
    // handoff instructions ONLY when accumulate_handoffs is enabled — the description
    // registered at startup cannot change per run, but the hook fires on every model
    // request (the V2 equivalent of the V1 tool.definition hook).
    const accumulateNote = `Handoffs accumulate within a step: the new conversation receives the original task, then the descriptions of ALL earlier handoffs of this step (numbered, in order), then the newest one. Do not repeat their content — describe what has been done in the current conversation since the last handoff (for the first handoff: since the start of the step).`

    // ── main step loop ────────────────────────────────────────────────────────
    // Sleep that ends early when the run is stopping — used to pace repeated
    // handoff instructions (instruction_retry_seconds).
    async function sleepStoppingAware(state: RunState, ms: number): Promise<void> {
      const chunkMs = 500
      let left = ms
      while (left > 0 && !state.stopping) {
        const waited = Math.min(chunkMs, left)
        await new Promise((r) => setTimeout(r, waited))
        left -= waited
      }
    }

    async function monitorStep(state: RunState, firstSessionID: string): Promise<void> {
      let sessionID = firstSessionID
      while (!state.stopping) {
        await waitTurnGuarded(state, sessionID)
        if (state.finalChance === sessionID) state.finalChance = null
        if (state.stopping) return
        if (run && run.sessionID !== sessionID) {
          sessionID = run.sessionID
          continue
        }
        // Turn-end outcome: an interrupted (aborted) execution is not fatal — the
        // monitoring continues (last chance path); a failed execution ends the
        // run, like the V1 non-abort assistant message error did.
        const interrupted = state.interruptedSessions.delete(sessionID)
        const failure = state.failedExecutions.get(sessionID)
        state.failedExecutions.delete(sessionID)
        const snap = await snapshot(sessionID)
        if (!interrupted) {
          const err = failure ?? snap.error
          if (err) {
            throw new Error(`agent zakończył turę błędem: ${err.type ?? "Error"}: ${err.message}`)
          }
        }
        if (snap.tokens <= state.cfg.max_context) return
        const handoffLimit = state.cfg.max_handoffs ?? 10
        if (state.continuation >= handoffLimit) {
          log("warn", `krok ${state.step}: limit ${handoffLimit} handoffów osiągnięty — kończę krok`)
          toast(`Auto-exec: krok ${state.step} — limit ${handoffLimit} handoffów osiągnięty, krok zakończony.`, "warning", 10000)
          return
        }
        const maxAttempts = state.cfg.max_instruction_attempts ?? DEFAULT_INSTRUCTION_ATTEMPTS
        const attempts = state.instructionAttempts.get(sessionID) ?? 0
        if (attempts >= maxAttempts) {
          // Last chance: one clean instruction turn after aborting a long
          // turn — in a clean turn the model cannot hide behind "I'll finish my
          // current work first" (E2E: nearly 100% success rate in clean turns).
          const finalDone = state.finalAttempts.get(sessionID) ?? 0
          if (finalDone < 1) {
            state.finalAttempts.set(sessionID, finalDone + 1)
            log("warn", `krok ${state.step}: limit instrukcji wyczerpany — ostatnia szansa: czysta tura instrukcji handoff`)
            state.finalChance = sessionID
            await sendTurn(sessionID, instructionText(state, maxAttempts, maxAttempts, true))
            continue
          }
          log("warn", `krok ${state.step}: sesja ${sessionID} nadal przekracza próg po ${attempts} instrukcjach handoff — kończę krok`)
          toast(`Auto-exec: krok ${state.step} — agent nie wykonał handoffu mimo ${attempts} instrukcji, krok zakończony.`, "warning", 10000)
          return
        }
        // Pacing: a repeated instruction must not chase the previous one — the
        // model needs time to actually act on it (finish the current tool call,
        // call the handoff tool). The FIRST instruction for this session is
        // never delayed; only repeats wait out the remaining cooldown. During
        // the wait the session is idle, so its token count cannot shrink.
        const retryMs = (state.cfg.instruction_retry_seconds ?? DEFAULT_INSTRUCTION_RETRY_SECONDS) * 1000
        const lastInstruction = state.lastInstructionAt.get(sessionID) ?? 0
        const remaining = retryMs - (Date.now() - lastInstruction)
        if (remaining > 0) {
          log(
            "info",
            `krok ${state.step}: ponowienie instrukcji handoff odczeka ${Math.ceil(remaining / 1000)} s (minimalna przerwa między instrukcjami)`,
          )
          await sleepStoppingAware(state, remaining)
          if (state.stopping) return
        }
        state.instructionAttempts.set(sessionID, attempts + 1)
        state.lastInstructionAt.set(sessionID, Date.now())
        log("info", `krok ${state.step}: kontekst ${snap.tokens} > ${state.cfg.max_context} — instrukcja handoff (próba ${attempts + 1}/${maxAttempts})`)
        await sendTurn(sessionID, instructionText(state, attempts + 1, maxAttempts))
      }
    }

    async function runLoop(state: RunState): Promise<void> {
      try {
        state.lastActivity = Date.now()
        startBeat(state)
        for (let step = state.cfg.from; step <= state.cfg.to; step++) {
          if (state.stopping) break
          state.step = step
          state.continuation = 0
          state.handoffSummaries = []
          const sessionID = await createSession(state, `[auto-exec] krok ${step}/${state.cfg.to}`)
          state.sessionID = sessionID
          log("info", `start kroku ${step}/${state.cfg.to} (sesja ${sessionID})`)
          toast(
            `Auto-exec: odpalam nowy task — krok ${step}/${state.cfg.to} (sesja „[auto-exec] krok ${step}/${state.cfg.to}")`,
            "info",
            8000,
          )
          await sendTurn(sessionID, renderPrompt(state.cfg.prompt, step))
          await monitorStep(state, sessionID)
          // Belt and suspenders: make sure the finished session really has no
          // running turn before opening the next one (a hung turn must never
          // overlap with the next step's turn).
          await quiesceSession(sessionID)
        }
        stopBeat(state)
        if (run === state) run = null
        if (state.stopping) toast("Automatyczne wykonywanie kroków zostało zatrzymane.", "warning", 8000)
        else toast(`Gotowe: wykonano kroki ${state.cfg.from}–${state.cfg.to}.`, "success", 10000)
      } catch (error) {
        stopBeat(state)
        if (run === state) run = null
        const message = error instanceof Error ? error.message : String(error)
        log("error", "run failed", { error: message, step: state.step })
        toast(`Błąd auto-exec (krok ${state.step}): ${message}`, "error", 15000)
      }
    }

    function startRun(cfg: RunConfig): void {
      if (run) {
        toast("Auto-exec już działa. Najpierw użyj /stop-auto-execution.", "warning")
        return
      }
      const state: RunState = {
        cfg,
        step: cfg.from,
        continuation: 0,
        sessionID: "",
        instructionAttempts: new Map(),
        lastInstructionAt: new Map(),
        stopping: false,
        lastActivity: Date.now(),
        beatTimer: null,
        steeringPending: new Set(),
        interruptedSessions: new Set(),
        failedExecutions: new Map(),
        finalAttempts: new Map(),
        finalChance: null,
        lastTokens: new Map(),
        sessions: new Set(),
        handoffSummaries: [],
      }
      run = state
      const beatSeconds = cfg.heartbeat_seconds ?? DEFAULT_HEARTBEAT_SECONDS
      toast(
        beatSeconds > 0
          ? `Auto-exec: start kroków ${cfg.from}–${cfg.to} (próg kontekstu: ${cfg.max_context} tokenów, tętno co ${beatSeconds} s).`
          : `Auto-exec: start kroków ${cfg.from}–${cfg.to} (próg kontekstu: ${cfg.max_context} tokenów, tętno wyłączone).`,
        "info",
        10000,
      )
      void runLoop(state)
    }

    function stopRun(): boolean {
      if (!run) return false
      run.stopping = true
      stopBeat(run)
      // Interrupt EVERY session of the run, not only the current one: a turn
      // from an earlier step that outlived its step (hung provider request)
      // would otherwise keep occupying a serial local backend after the stop.
      for (const id of run.sessions) {
        void ctx.session.interrupt({ sessionID: id }).catch(() => {})
      }
      for (const [sid, waiter] of [...waiters]) {
        waiters.delete(sid)
        waiter.resolve()
      }
      return true
    }

    // ── server events ─────────────────────────────────────────────────────────
    // Replaces the V1 `event` hook. Turn end: session.execution.succeeded
    // (fallback: session.idle for older opencode; aborted/failed turns via
    // execution.interrupted/failed; stall watchdog as the last resort).
    // Context counter: the
    // per-step tokens of `session.step.ended`/`session.step.failed` — see the
    // note inside handleEvent on why session.usage.updated must NOT be used.
    // Used by the mid-turn threshold monitoring and the execute() guard
    // (lastTokens).
    function handleEvent(event: { type: string; data?: any }): void {
      // Turn finished (normal completion). opencode >= 2.0.26 signals it with
      // session.execution.succeeded — verified live (2.0.26): a completed turn
      // emits execution.started -> step.* -> step.ended -> usage.updated ->
      // execution.succeeded, and NO bus event named session.idle ("idle" exists
      // there only as a TUI command). Waiting for session.idle hung the run
      // after the first finished turn (platformgame, krok 6/11: the turn ended
      // and the loop never advanced). session.idle stays as a fallback for
      // versions that still emit it. Guard-free on purpose: waiters exist only
      // for run sessions, and after a handoff the finishing session may
      // already differ from run.sessionID.
      if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
        const sessionID = event.data?.sessionID
        if (!sessionID) return
        const waiter = waiters.get(sessionID)
        if (waiter) {
          waiters.delete(sessionID)
          if (run && !run.stopping) {
            run.lastActivity = Date.now()
            if (sessionID === run.sessionID) {
              run.steeringPending.delete(sessionID)
              toast(
                `Auto-exec: agent zakończył turę — krok ${run.step}/${run.cfg.to}, kontynuacja ${run.continuation}/${run.cfg.max_handoffs ?? 10}`,
                "info",
                6000,
              )
            }
          }
          waiter.resolve()
        } else if (run && !run.stopping && sessionID === run.sessionID) {
          run.steeringPending.delete(sessionID)
        }
        return
      }
      if (!run || run.stopping) return
      const sessionID: string | undefined = event.data?.sessionID
      if (!sessionID || sessionID !== run.sessionID) return

      if (event.type === "session.execution.interrupted") {
        // Aborted turn (by /stop-auto-execution or by the mid-turn abort path) —
        // the monitor must treat it like the V1 MessageAbortedError: not fatal,
        // tokens from the last healthy message.
        run.interruptedSessions.add(sessionID)
        run.steeringPending.delete(sessionID)
        run.lastActivity = Date.now()
        const waiter = waiters.get(sessionID)
        if (waiter) {
          waiters.delete(sessionID)
          waiter.resolve()
        }
        return
      }
      if (event.type === "session.execution.failed") {
        const err = event.data?.error ?? {}
        run.failedExecutions.set(sessionID, { type: err.type, message: String(err.message ?? "") })
        run.steeringPending.delete(sessionID)
        run.lastActivity = Date.now()
        const waiter = waiters.get(sessionID)
        if (waiter) {
          waiters.delete(sessionID)
          waiter.resolve()
        }
        return
      }
      if (
        event.type === "session.usage.updated" ||
        event.type === "session.step.ended" ||
        event.type === "session.step.failed"
      ) {
        run.lastActivity = Date.now()
        // session.usage.updated carries the CUMULATIVE billing sum for the
        // whole session: every LLM step re-sends the entire prompt, so the sum
        // grows by ~the full prompt size PER STEP (with prompt caching that
        // whole prompt lands in cache.read each time). Mid-step it also
        // carries transient streaming values that shrink again when the step
        // finalizes. Comparing that sum to max_context fired the handoff
        // instruction after a few tool-call steps while the real context was
        // still tiny (lemonade/Ornith-1.5, platformgame: real context ~14.5k,
        // cumulative sum >120k after ~8 steps in ~90 s). The threshold
        // therefore uses ONLY the per-step tokens of session.step.ended /
        // session.step.failed: the tokens of the single finished LLM request
        // (input + output + cache.read + cache.write of that one step) = the
        // real current context, the V2 equivalent of the V1 per-message
        // counter. Post-turn checks use snapshot() (last message tokens).
        if (event.type === "session.usage.updated") return
        const t = event.data?.tokens ?? {}
        const total =
          (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
        // max protects against partial values and keeps the guard in execute()
        // conservative; a step event describes one finished request.
        if (total > (run.lastTokens.get(sessionID) ?? 0)) run.lastTokens.set(sessionID, total)
        // A step ended (an iteration of the LLM loop finished) — release the
        // steering gate so the next exceedance can steer again (the V2
        // equivalent of the V1 per-message dedup).
        run.steeringPending.delete(sessionID)
        // Threshold monitoring DURING the turn: usage above the threshold injects
        // steering with the handoff instruction into the ongoing turn; once the
        // instruction limit is exhausted, further exceedances abort the turn —
        // without waiting for its natural end (when the context escapes even
        // further) and without letting super-long sessions appear.
        if (
          waiters.has(sessionID) &&
          !run.steeringPending.has(sessionID) &&
          run.finalChance !== sessionID &&
          total > run.cfg.max_context
        ) {
          run.steeringPending.add(sessionID)
          const maxAttempts = run.cfg.max_instruction_attempts ?? DEFAULT_INSTRUCTION_ATTEMPTS
          const attempts = run.instructionAttempts.get(sessionID) ?? 0
          if (attempts < maxAttempts) {
            // Pacing: a repeated steering must not chase the previous
            // instruction one LLM step later — that burned the attempt budget
            // within seconds of a single turn (steeringPending is released on
            // every step end) while the model was still acting on the first
            // instruction. Skip this step end; the next one re-evaluates, so
            // the repeat comes later, not faster. The FIRST instruction for
            // the session is never delayed.
            const retryMs = (run.cfg.instruction_retry_seconds ?? DEFAULT_INSTRUCTION_RETRY_SECONDS) * 1000
            const lastInstruction = run.lastInstructionAt.get(sessionID) ?? 0
            if (lastInstruction && Date.now() - lastInstruction < retryMs) {
              log(
                "debug",
                `krok ${run.step}: ponowienie instrukcji handoff wstrzymane — poprzednia była ${Math.round((Date.now() - lastInstruction) / 1000)} s temu (przerwa ${Math.round(retryMs / 1000)} s)`,
              )
              return
            }
            // Injecting steering into the ongoing turn: the agent sees the
            // handoff instruction in that very turn and can hand off the work
            // immediately (the tool is always visible).
            run.instructionAttempts.set(sessionID, attempts + 1)
            run.lastInstructionAt.set(sessionID, Date.now())
            log(
              "info",
              `krok ${run.step}: próg kontekstu W TRAKCIE tury (${total} > ${run.cfg.max_context}) — wstrzykuję steering z ${toolName} (próba ${attempts + 1}/${maxAttempts})`,
            )
            toast(
              `Auto-exec: krok ${run.step} — kontekst ${Math.round(total / 1000)}k > próg ${Math.round(run.cfg.max_context / 1000)}k; wstrzykuję handoff w trakcie tury (próba ${attempts + 1}/${maxAttempts})`,
              "info",
              8000,
            )
            void sendTurn(sessionID, instructionText(run, attempts + 1, maxAttempts), true).catch(() => {})
          } else {
            // Instruction limit exhausted, the session keeps bloating — a last resort:
            // we abort the turn so that a super-long session does not appear.
            log(
              "warn",
              `krok ${run.step}: limit instrukcji (${maxAttempts}) wyczerpany, kontekst ${total} > ${run.cfg.max_context} — przerywam turę`,
            )
            toast(
              `Auto-exec: krok ${run.step} — limit instrukcji handoff wyczerpany, przerywam długą turę`,
              "warning",
              10000,
            )
            void ctx.session.interrupt({ sessionID }).catch(() => {})
          }
        }
        return
      }
    }

    const eventController = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          if (eventController.signal.aborted) return
          handleEvent(event as { type: string; data?: any })
        }
      } catch (error) {
        if (!eventController.signal.aborted) {
          log("warn", `strumień zdarzeń serwera przerwany: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    // ── registration ──────────────────────────────────────────────────────────
    // The handoff tool — always visible for every agent and session (we do not
    // restrict it by permissions or tool filters; the threshold in execute()
    // protects against spontaneous calls).
    await ctx.tool.transform((editor) => {
      editor.add({
        name: toolName,
        description: handoffDescription,
        input: handoffInputSchema,
        async execute(args, context) {
          const state = run
          if (!state || state.stopping) {
            return { content: "Error: automatic step execution is not active — the handover was not saved." }
          }
          if (context.sessionID !== state.sessionID) {
            return { content: "Error: the handover for this conversation has already been performed." }
          }
          // Protection against spontaneous calls: the handoff is executed
          // only after the context threshold is exceeded. The usage of the current
          // message (the one with the tool call) is not yet recorded at the moment
          // of execute(), and usage after an abort may be zeroed — therefore we also
          // take the last known usage from the usage/step events (lastTokens).
          const snapNow = await snapshot(context.sessionID)
          const known = state.lastTokens.get(context.sessionID) ?? 0
          const seen = Math.max(snapNow.tokens, known)
          if (seen <= state.cfg.max_context) {
            return {
              content: `Error: the context threshold (${state.cfg.max_context} tokens) has not been exceeded yet — context: ${seen}. Do not call this tool until the system explicitly asks you to.`,
            }
          }
          const summary = String((args as { description?: unknown })?.description ?? "").trim()
          if (!summary) {
            return { content: "Error: the \"description\" argument is required — describe in detail what has been done." }
          }
          state.continuation++
          const accumulate = state.cfg.accumulate_handoffs !== false
          if (accumulate) state.handoffSummaries.push(summary)
          const title = `[auto-exec] krok ${state.step}/${state.cfg.to} — kontynuacja ${state.continuation}`
          const text = accumulate
            ? renderPrompt(state.cfg.prompt, state.step) +
              `\n\nProgress so far (${state.handoffSummaries.length} handoff${
                state.handoffSummaries.length === 1 ? "" : "s"
              } in this step, in order):\n\n` +
              state.handoffSummaries.map((d, i) => `Handoff ${i + 1}:\n${d}`).join("\n\n")
            : renderPrompt(state.cfg.prompt, state.step) + `\n\nProgress so far: ${summary}`
          const prevSessionID = state.sessionID
          const newSessionID = await createSession(state, title)
          state.sessionID = newSessionID
          state.lastActivity = Date.now()
          log("info", `krok ${state.step}: handoff → nowa konwersacja ${newSessionID}`)
          toast(
            `Auto-exec: wykonuję handoff kroku ${state.step} — kontynuacja ${state.continuation}/${state.cfg.max_handoffs ?? 10} w nowej sesji`,
            "info",
            8000,
          )
          try {
            // Fire-and-forget: without waiting for the end of the continuation turn — the
            // waiter handles monitorStep, and threshold monitoring for the new session
            // works right away. Waiting here would disable monitoring for the whole
            // duration of the continuation turn (incident T8/continuation 1).
            await startTurn(newSessionID, text)
          } catch (error) {
            // We roll back the state so that a repeated handoff_save call in this turn
            // goes through the sessionID guard and the threshold like the first time.
            state.sessionID = prevSessionID
            state.continuation--
            if (accumulate) state.handoffSummaries.pop()
            const message = error instanceof Error ? error.message : String(error)
            log("warn", `krok ${state.step}: uruchomienie kontynuacji nie powiodło się: ${message}`)
            return {
              content: `Error: failed to start the new conversation (${message}). Call ${toolName} again.`,
            }
          }
          return {
            content:
              "The new conversation has been started along with your handover. The work continues — finish this message with a short summary.",
          }
        },
      })
    })

    // The accumulation note is appended to the handoff tool's description on
    // every model request (agent loop) while a run with accumulate_handoffs is
    // active — the V2 equivalent of the V1 tool.definition hook, which fired on
    // every LLM step.
    await ctx.session.hook("context", (event) => {
      if (!run || run.stopping || run.cfg.accumulate_handoffs === false) return
      const tool = event.tools[toolName]
      if (!tool) return
      tool.description = `${tool.description}\n\n${accumulateNote}`
    })

    // Commands own their executors (the V1 implementation registered command
    // templates and cancelled the prompt by throwing from
    // command.execute.before — in V2 a plugin command simply runs code and
    // never submits an LLM turn).
    await ctx.command.transform((editor) => {
      editor.add({
        name: START_COMMAND,
        description: `Uruchom sekwencyjne wykonywanie kroków: /${START_COMMAND} <plik.json> (wtyczka auto-executor)`,
        execute: async (input) => {
          try {
            // prompt.text holds only the arguments typed after the command name
            // (opencode strips the "/auto-exec" prefix itself; older versions
            // passed the full text — strip a repeated command prefix if present,
            // but ONLY when it is a real prefix, i.e. followed by whitespace or
            // end of input: a filename may itself start with "auto-exec"
            // (e.g. auto-exec.json) and \b would eat into it, leaving ".json").
            const arg = String(input.prompt?.text ?? "")
              .trim()
              .replace(/^\/?auto-exec(?=\s|$)/, "")
              .trim()
            if (!arg) {
              log("error", "komenda /auto-exec wywołana bez argumentu — nie uruchomiono biegu")
              toast(`Użycie: /${START_COMMAND} <ścieżka-do-pliku.json>`, "error", 15000)
              return
            }
            const file = path.isAbsolute(arg) ? arg : path.resolve(directory, arg)
            const cfg = loadConfig(file)
            await resolveDefaults(ctx, input.sessionID, cfg)
            startRun(cfg)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log("error", "failed to start run", { error: message })
            toast(`Auto-exec: ${message}`, "error", 10000)
          }
        },
      })
      editor.add({
        name: STOP_COMMAND,
        description: `Przerywa trwające automatyczne wykonywanie kroków (wtyczka auto-executor)`,
        execute: async () => {
          const was = stopRun()
          toast(
            was ? "Zatrzymywanie automatycznego wykonywania kroków…" : "Brak aktywnego auto-exec.",
            was ? "warning" : "info",
            8000,
          )
        },
      })
    })

    log(
      "info",
      `zarejestrowano komendy /${START_COMMAND}, /${STOP_COMMAND}; narzędzie ${toolName} zawsze widoczne, próg: max_context w execute()`,
    )

    // Cleanup: stop the run, the heartbeat timer and the event stream.
    // Hook/transform/command/tool/RPC registrations are disposed automatically.
    return () => {
      eventController.abort()
      stopRun()
    }
  },
})

export default AutoExecutor