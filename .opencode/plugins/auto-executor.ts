// auto-executor — an opencode plugin
//
// Sequential step execution: each iteration of a for loop in LaTeX writes
// one sentence of a report. The plugin starts a new chat session for each
// step, waits until the agent finishes, and then moves on to the next step.
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
//   "heartbeat_seconds": 45    // optional UI heartbeat frequency (0 = disabled)
// }
//
// Heartbeat: the plugin reports (via toasts) in the TUI that it is alive — a heartbeat
// every heartbeat_seconds plus messages on every significant event:
// a new task (step) started, an agent turn finished, a handoff,
// run finished/error. No heartbeat = the plugin has died.
//
// When context usage during a step exceeds max_context, the agent receives
// a message and calls the handoff_save tool, which starts a new conversation
// (initial prompt + "Progress so far: <agent's description>"). The plugin starts the
// continuation turn without waiting for it to finish (fire-and-forget) — thanks to this
// threshold monitoring covers the continuation session from its first message (previously
// execute() waited for the whole continuation turn and meanwhile disabled mid-turn
// monitoring: the continuation of step 1 of run T8 bloated to ~184k tokens without steering).
// The handoff_save tool is ALWAYS visible (we hide it neither with permission.deny
// nor with the tools flag — the steering message's flag does not change the tool set
// of an ongoing turn, and hiding it would block handing off work mid-turn). Protection
// against spontaneous calls is provided by the threshold: execute() refuses until the
// session context exceeds max_context. The threshold is also enforced DURING the turn
// (message.updated): an exceedance injects a steering prompt asking for a handoff;
// once max_instruction_attempts is exhausted the turn is aborted, so that
// super-long sessions do not appear. If the agent still does not hand off the work,
// the instruction is repeated after the turn ends (same attempt counter).

import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

const START_COMMAND = "auto-exec"
const STOP_COMMAND = "stop-auto-execution"
const DEFAULT_HANDOFF_TOOL = "handoff_save"
const DEFAULT_INSTRUCTION_ATTEMPTS = 5
const DEFAULT_HEARTBEAT_SECONDS = 45

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
  heartbeat_seconds?: number
}

// Fills in the configuration with default model/agent taken over from the control session
// (i.e. the chat in which the user typed /auto-exec). Values given
// explicitly in the JSON file take precedence.
async function resolveDefaults(
  client: any,
  controllerSessionID: string,
  cfg: RunConfig,
): Promise<void> {
  if (cfg.model && cfg.agent) return
  try {
    const res: any = await client.session.get(
      { path: { id: controllerSessionID } },
      { throwOnError: true } as any,
    )
    const info = res?.data ?? res
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
  sessionID: string
  instructionAttempts: Map<string, number>
  stopping: boolean
  lastActivity: number
  beatTimer: ReturnType<typeof setInterval> | null
  handledMsgs: Map<string, string>
  finalAttempts: Map<string, number>
  // session with an ongoing "last chance" turn — the mid-turn handler must not
  // abort or steer it (attempts already exhausted, the abort would kill the model before
  // it managed to call the handoff tool — E2E diag2 r3)
  finalChance: string | null
  // last known token usage per session (from message.updated). The tool
  // executes BEFORE the current message gets its tokens (and after an abort
  // its tokens are zeroed) — the snapshot in execute() then sees 0 and rejects
  // a legitimate handoff (E2E diag2 r4). Hence the guard uses max(snapshot, lastKnown).
  lastTokens: Map<string, number>
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

function parseModel(ref: string): { providerID: string; modelID: string } {
  const idx = ref.indexOf("/")
  if (idx <= 0) throw new Error(`model musi mieć format "provider/model-id", otrzymano: "${ref}"`)
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) }
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
    heartbeat_seconds:
      json.heartbeat_seconds !== undefined ? Number(json.heartbeat_seconds) : undefined,
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
  if (cfg.heartbeat_seconds !== undefined) {
    if (!Number.isFinite(cfg.heartbeat_seconds) || cfg.heartbeat_seconds < 0)
      throw new Error(`plik ${file}: "heartbeat_seconds" musi być liczbą >= 0`)
    if (cfg.heartbeat_seconds > 0 && cfg.heartbeat_seconds < 5)
      throw new Error(`plik ${file}: "heartbeat_seconds" musi być 0 (wyłączone) albo >= 5`)
  }
  return cfg
}

function renderPrompt(template: string, step: number): string {
  return template.split("{step}").join(String(step))
}

export const AutoExecutor: Plugin = (input, options) => {
  const { client, directory } = input
  const toolName =
    typeof (options as any)?.tool_name === "string" && (options as any).tool_name
      ? (options as any).tool_name
      : DEFAULT_HANDOFF_TOOL

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    void client.app
      .log({ body: { service: "auto-executor", level, message, extra } })
      .catch(() => {})
  }

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", duration?: number) => {
    void client.tui.showToast({ body: { message, variant, duration } }).catch(() => {})
  }

  // ── sending a turn to a session ───────────────────────────────────────────
  function buildBody(text: string, allowHandoff: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }],
    }
    // The tool is always visible — the tools flag in the request body does NOT change
    // the tool set of an ongoing turn (steering), and hiding the tool (tools:false)
    // would block handing off work mid-turn. We set tools:true solely
    // for explicit instruction turns (to document the intent).
    if (allowHandoff) body.tools = { [toolName]: true }
    if (run?.cfg.model) body.model = parseModel(run.cfg.model)
    if (run?.cfg.agent) body.agent = run.cfg.agent
    return body
  }

  // Starts a turn and does NOT wait for it to finish — the turn end will be handled
  // by the waiter that monitorStep waits on. Used by the handoff: if execute() waited
  // for the whole continuation turn, threshold monitoring would be blocked for the
  // entire duration of that turn (incident T8/continuation 1 — the session bloated to
  // ~184k tokens without steering; the user forced the handoff manually).
  async function startTurn(sessionID: string, text: string, allowHandoff: boolean): Promise<void> {
    if (run) run.lastActivity = Date.now()
    const waiter = registerWaiter(sessionID)
    try {
      await client.session
        .promptAsync(
          { path: { id: sessionID }, body: buildBody(text, allowHandoff) as any },
          { throwOnError: true } as any,
        )
    } catch (error) {
      if (isMine(sessionID, waiter.resolve)) waiters.delete(sessionID)
      waiter.resolve()
      throw error
    }
  }

  // steering=true: the message is injected into an ONGOING turn (opencode queue).
  // In that case we do not register a waiter — the turn end is handled anyway by
  // the original turn's waiter; double registration would invalidate its resolve.
  async function sendTurn(sessionID: string, text: string, allowHandoff: boolean, steering = false) {
    if (run) run.lastActivity = Date.now()
    if (steering) {
      await client.session
        .promptAsync(
          { path: { id: sessionID }, body: buildBody(text, allowHandoff) as any },
          { throwOnError: true } as any,
        )
        .catch((error: unknown) => {
          log("warn", `steering mid-turn nie dotarł: ${error instanceof Error ? error.message : String(error)}`)
        })
      return
    }
    await startTurn(sessionID, text, allowHandoff)
    await waitTurn(sessionID)
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

  // ── heartbeat ─────────────────────────────────────────────────────────────
  const beat = (state: RunState) => {
    if (state.stopping || run !== state) return
    const since = Math.max(0, Math.round((Date.now() - state.lastActivity) / 1000))
    toast(
      `Auto-exec tętno: krok ${state.step}/${state.cfg.to}, kontynuacja ${state.continuation}/${state.cfg.max_handoffs ?? 10}, ostatnia aktywność ${since} s temu`,
      "info",
      8000,
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
  type SessionSnapshot = { tokens: number; error?: { name?: string; message?: string } }

  async function snapshot(sessionID: string): Promise<SessionSnapshot> {
    const res: any = await client.session.messages({ path: { id: sessionID } }, { throwOnError: true } as any)
    const data = res?.data ?? res
    const list: Array<{ info: any }> = Array.isArray(data) ? data : (data?.messages ?? [])
    // Last assistant message (any) — we take the error from it (for the aborted
    // turn logic in monitorStep). Tokens are taken from the last ERROR-FREE
    // assistant message: an aborted turn (MessageAbortedError) is zeroed
    // (all tokens = 0), which otherwise cheated the threshold and silenced the
    // "last chance" path after an abort (E2E diag2: the step ended silently).
    let last: any
    let lastHealthy: any
    for (let i = list.length - 1; i >= 0; i--) {
      const info = list[i]?.info
      if (info?.role !== "assistant") continue
      if (!last) last = info
      if (!lastHealthy && !info.error) lastHealthy = info
      if (last && lastHealthy) break
    }
    if (!last) return { tokens: 0 }
    const t = (lastHealthy ?? last).tokens ?? {}
    const tokens = (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    const error = last.error
      ? { name: (last.error as any).name, message: String((last.error as any).data?.message ?? last.error) }
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
  async function createSession(state: RunState, title: string): Promise<string> {
    const res: any = await client.session.create({ body: { title } }, { throwOnError: true } as any)
    const data = res?.data ?? res
    return data.id
  }

  // ── the handoff tool ──────────────────────────────────────────────────────
  const handoffDescription = `Save a handover message for the new conversation that will continue the current task. Call it only when the system explicitly asks you to (the context window is running out).`

  // ── main step loop ────────────────────────────────────────────────────────
  async function monitorStep(state: RunState, firstSessionID: string): Promise<void> {
    let sessionID = firstSessionID
    while (!state.stopping) {
      if (waiters.has(sessionID)) await waitTurn(sessionID)
      if (state.finalChance === sessionID) state.finalChance = null
      if (state.stopping) return
      if (run && run.sessionID !== sessionID) {
        sessionID = run.sessionID
        continue
      }
      const snap = await snapshot(sessionID)
      if (snap.error && snap.error.name !== "MessageAbortedError") {
        throw new Error(`agent zakończył turę błędem: ${snap.error.name ?? "Error"}: ${snap.error.message}`)
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
          await sendTurn(sessionID, instructionText(state, maxAttempts, maxAttempts, true), true)
          continue
        }
        log("warn", `krok ${state.step}: sesja ${sessionID} nadal przekracza próg po ${attempts} instrukcjach handoff — kończę krok`)
        toast(`Auto-exec: krok ${state.step} — agent nie wykonał handoffu mimo ${attempts} instrukcji, krok zakończony.`, "warning", 10000)
        return
      }
      state.instructionAttempts.set(sessionID, attempts + 1)
      log("info", `krok ${state.step}: kontekst ${snap.tokens} > ${state.cfg.max_context} — instrukcja handoff (próba ${attempts + 1}/${maxAttempts})`)
      await sendTurn(sessionID, instructionText(state, attempts + 1, maxAttempts), true)
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
        const sessionID = await createSession(state, `[auto-exec] krok ${step}/${state.cfg.to}`)
        state.sessionID = sessionID
        log("info", `start kroku ${step}/${state.cfg.to} (sesja ${sessionID})`)
        toast(
          `Auto-exec: odpalam nowy task — krok ${step}/${state.cfg.to} (sesja „[auto-exec] krok ${step}/${state.cfg.to}")`,
          "info",
          8000,
        )
        await sendTurn(sessionID, renderPrompt(state.cfg.prompt, step), false)
        await monitorStep(state, sessionID)
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
      stopping: false,
      lastActivity: Date.now(),
      beatTimer: null,
      handledMsgs: new Map(),
      finalAttempts: new Map(),
      finalChance: null,
      lastTokens: new Map(),
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
    const id = run.sessionID
    if (id) void client.session.abort({ path: { id } }).catch(() => {})
    for (const [sid, waiter] of [...waiters]) {
      waiters.delete(sid)
      waiter.resolve()
    }
    return true
  }

  return {
    dispose: async () => {
      stopRun()
    },

    config: (cfg) => {
      const c = cfg as any
      c.command = c.command ?? {}
      if (!c.command[START_COMMAND]) {
        c.command[START_COMMAND] = {
          description: `Uruchom sekwencyjne wykonywanie kroków: /${START_COMMAND} <plik.json> (wtyczka auto-executor)`,
          template: `[auto-exec] ${START_COMMAND} $ARGUMENTS`,
        }
      }
      if (!c.command[STOP_COMMAND]) {
        c.command[STOP_COMMAND] = {
          description: `Przerywa trwające automatyczne wykonywanie kroków (wtyczka auto-executor)`,
          template: `[auto-exec] ${STOP_COMMAND}`,
        }
      }
      // We do NOT set permission.deny and we do NOT hide the tool — it must be available
      // in every turn (including steering and manual ones) so that the handoff can
      // happen mid-turn. The threshold in execute() protects against spontaneous calls.
      log("info", `zarejestrowano komendy /${START_COMMAND}, /${STOP_COMMAND}; narzędzie ${toolName} zawsze widoczne, próg: max_context w execute()`)
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = (event.properties as any)?.info
        if (!info || !run || run.stopping) return
        if (info.sessionID !== run.sessionID) return
        run.lastActivity = Date.now()
        // We remember the last known token usage (message.updated arrives
        // multiple times — max protects against partial stream values). Usage:
        // the guard in execute(), which at tool call time does not yet see
        // the tokens of the current message (see the comment in RunState).
        if (info.role === "assistant") {
          const tk = info.tokens ?? {}
          const total =
            (tk.input ?? 0) + (tk.output ?? 0) + (tk.cache?.read ?? 0) + (tk.cache?.write ?? 0)
          if (total > (run.lastTokens.get(info.sessionID) ?? 0)) run.lastTokens.set(info.sessionID, total)
        }
        // Threshold monitoring DURING the turn: every finished assistant message
        // (an iteration of the LLM loop) carries token state. Exceeding the threshold
        // in a long turn aborts the turn right away — the handoff instruction will go
        // in a new turn, without waiting for the natural end (when the context escapes
        // even further).
        if (
          info.role === "assistant" &&
          waiters.has(info.sessionID) &&
          run.finalChance !== info.sessionID
        ) {
          const t = info.tokens ?? {}
          const total =
            (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          // message.updated arrives multiple times for the same message —
          // we react only once, on the first event with tokens above the threshold.
          const lastHandled = run.handledMsgs.get(info.sessionID)
          if (total > run.cfg.max_context && info.id !== lastHandled) {
            run.handledMsgs.set(info.sessionID, info.id)
            const maxAttempts = run.cfg.max_instruction_attempts ?? DEFAULT_INSTRUCTION_ATTEMPTS
            const attempts = run.instructionAttempts.get(info.sessionID) ?? 0
            if (attempts < maxAttempts) {
              // Injecting steering into the ongoing turn: steering prompt +
              // the handoff tool (tools:true) — the agent sees both
              // in that very turn and can hand off the work immediately.
              run.instructionAttempts.set(info.sessionID, attempts + 1)
              log(
                "info",
                `krok ${run.step}: próg kontekstu W TRAKCIE tury (${total} > ${run.cfg.max_context}) — wstrzykuję steering z ${toolName} (próba ${attempts + 1}/${maxAttempts})`,
              )
              toast(
                `Auto-exec: krok ${run.step} — kontekst ${Math.round(total / 1000)}k > próg ${Math.round(run.cfg.max_context / 1000)}k; wstrzykuję handoff w trakcie tury (próba ${attempts + 1}/${maxAttempts})`,
                "info",
                8000,
              )
              void sendTurn(
                info.sessionID,
                instructionText(run, attempts + 1, maxAttempts),
                true,
                true,
              ).catch(() => {})
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
              void client.session.abort({ path: { id: info.sessionID } }).catch(() => {})
            }
          }
        }
        return
      }
      if (event.type === "session.idle" || event.type === "session.error") {
        const sessionID = (event.properties as any).sessionID
        if (!sessionID) return
        const waiter = waiters.get(sessionID)
        if (waiter) {
          waiters.delete(sessionID)
          if (run && !run.stopping) {
            run.lastActivity = Date.now()
            if (event.type === "session.idle") {
              toast(
                `Auto-exec: agent zakończył turę — krok ${run.step}/${run.cfg.to}, kontynuacja ${run.continuation}/${run.cfg.max_handoffs ?? 10}`,
                "info",
                6000,
              )
            }
          }
          waiter.resolve()
        }
      }
    },

    "command.execute.before": async (cmd) => {
      if (cmd.command === START_COMMAND) {
        try {
          const arg = (cmd.arguments ?? "").trim()
          if (!arg) {
            log("error", "komenda /auto-exec wywołana bez argumentu — nie uruchomiono biegu")
            toast(`Użycie: /${START_COMMAND} <ścieżka-do-pliku.json>`, "error", 15000)
          } else {
            const file = path.isAbsolute(arg) ? arg : path.resolve(directory, arg)
            const cfg = loadConfig(file)
            await resolveDefaults(client, cmd.sessionID, cfg)
            startRun(cfg)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log("error", "failed to start run", { error: message })
          toast(`Auto-exec: ${message}`, "error", 10000)
        }
        // We cancel the prompt call — the command only serves to control the plugin.
        throw new Error("auto-exec: handled by plugin (LLM turn intentionally cancelled)")
      }
      if (cmd.command === STOP_COMMAND) {
        const was = stopRun()
        toast(was ? "Zatrzymywanie automatycznego wykonywania kroków…" : "Brak aktywnego auto-exec.", was ? "warning" : "info", 8000)
        throw new Error("auto-exec: handled by plugin (LLM turn intentionally cancelled)")
      }
    },

    tool: {
      [toolName]: {
        description: handoffDescription,
        args: {
          description: {
            type: "string",
            description:
              "A very detailed description: what has been done, what conclusions were reached, which files were changed, what remains to be done.",
          },
        },
        async execute(args, context) {
          const state = run
          if (!state || state.stopping) {
            return "Error: automatic step execution is not active — the handover was not saved."
          }
          if (context.sessionID !== state.sessionID) {
            return "Error: the handover for this conversation has already been performed."
          }
          // Protection against spontaneous calls: the handoff is executed
          // only after the context threshold is exceeded. The tokens of the current
          // message (the one with the tool call) are not yet attached at the moment
          // of execute(), and a message after an abort is zeroed — therefore we also
          // take the last known usage from message.updated (lastTokens).
          const snapNow = await snapshot(context.sessionID)
          const known = state.lastTokens.get(context.sessionID) ?? 0
          const seen = Math.max(snapNow.tokens, known)
          if (seen <= state.cfg.max_context) {
            return `Error: the context threshold (${state.cfg.max_context} tokens) has not been exceeded yet — context: ${seen}. Do not call this tool until the system explicitly asks you to.`
          }
          const summary = String((args as any).description ?? "").trim()
          if (!summary) {
            return "Error: the \"description\" argument is required — describe in detail what has been done."
          }
          state.continuation++
          const title = `[auto-exec] krok ${state.step}/${state.cfg.to} — kontynuacja ${state.continuation}`
          const newSessionID = await createSession(state, title)
          const text =
            renderPrompt(state.cfg.prompt, state.step) + `\n\nProgress so far: ${summary}`
          state.sessionID = newSessionID
          state.lastActivity = Date.now()
          log("info", `krok ${state.step}: handoff → nowa konwersacja ${newSessionID}`)
          toast(
            `Auto-exec: wykonuję handoff kroku ${state.step} — kontynuacja ${state.continuation}/${state.cfg.max_handoffs ?? 10} w nowej sesji`,
            "info",
            8000,
          )
          const prevSessionID = state.sessionID
          try {
            // Fire-and-forget: without waiting for the end of the continuation turn — the
            // waiter handles monitorStep, and threshold monitoring for the new session
            // works right away. Waiting here would disable monitoring for the whole
            // duration of the continuation turn (incident T8/continuation 1).
            await startTurn(newSessionID, text, false)
          } catch (error) {
            // We roll back the state so that a repeated handoff_save call in this turn
            // goes through the sessionID guard and the threshold like the first time.
            state.sessionID = prevSessionID
            state.continuation--
            const message = error instanceof Error ? error.message : String(error)
            log("warn", `krok ${state.step}: uruchomienie kontynuacji nie powiodło się: ${message}`)
            return `Error: failed to start the new conversation (${message}). Call ${toolName} again.`
          }
          return "The new conversation has been started along with your handover. The work continues — finish this message with a short summary."
        },
      },
    },
  }
}

export default AutoExecutor
