// auto-executor — wtyczka opencode
//
// Sekwencyjne wykonywanie kroków: każda iteracja pętli for w LaTeX-u pisze
// jedno zdanie sprawozdania. Wtyczka uruchamia nową sesję czatu dla każdego
// kroku, czeka aż agent skończy, po czym przechodzi do następnego kroku.
//
// Komendy:
//   /auto-exec <sciezka-do-pliku.json>  – start sekwencji kroków
//   /stop-auto-execution                – wymuszone przerwanie działania
//
// Plik konfiguracyjny (JSON):
// {
//   "prompt":      "tekst promptu z polem {step} na numer kroku",
//   "from":        1,          // pierwszy krok (opcjonalnie, domyślnie 1)
//   "to":          10,         // ostatni krok
//   "max_context": 60000,      // próg kontekstu w tokenach
//   "model":       "provider/model-id",   // opcjonalnie; domyślnie model wybrany w czacie
//   "agent":       "build",               // opcjonalnie; domyślnie agent z bieżącego czatu
//   "tool_description": "..."  // opcjonalny opis narzędzia przekazywany agentowi
//   "max_handoffs": 10         // opcjonalny limit przekazów na krok
//   "max_instruction_attempts": 5  // opcjonalny limit ponowień instrukcji handoff na sesję
//   "heartbeat_seconds": 45    // opcjonalna częstotliwość tętna w UI (0 = wyłączone)
// }
//
// Heartbeat: wtyczka raportuje w TUI (toastami), że żyje — tętno co
// heartbeat_seconds oraz komunikaty przy każdym istotnym zdarzeniu:
// odpalenie nowego taska (kroku), zakończenie tury agenta, handoff,
// zakończenie/błąd biegu. Brak tętna = wtyczka umarła.
//
// Gdy w trakcie kroku zużycie kontekstu przekroczy max_context, agent dostaje
// komunikat i wywołuje narzędzie handoff_save, które uruchamia nową konwersację
// (początkowy prompt + "Co zrobiono dotychczas: <opis agenta>"). Turę kontynuacji
// wtyczka odpala bez czekania na jej koniec (fire-and-forget) — dzięki temu
// monitoring progu obejmuje sesję kontynuacji od pierwszej wiadomości (dawniej
// execute() czekał na całą turę kontynuacji i przez ten czas wyłączał monitoring
// mid-turn: kontynuacja 1 kroku T8 puchła do ~184k tokenów bez steeringu).
// Narzędzie handoff_save jest ZAWSZE widoczne (nie ukrywamy go ani permission.deny,
// ani flagą tools — flaga wiadomości steeringowej nie zmienia zestawu narzędzi
// trwającej tury, a ukrywanie blokowałoby przekazanie pracy mid-turn). Przed
// spontanicznym wywołaniem chroni próg: execute() odmawia, dopóki kontekst sesji
// nie przekroczy max_context. Próg jest pilnowany również W TRAKCIE tury
// (message.updated): przekroczenie wstrzykuje prompt sterujący z prośbą o handoff;
// po wyczerpaniu max_instruction_attempts tura jest przerywana, żeby nie powstawały
// super-długie sesje. Jeśli agent mimo to nie przekaże pracy, instrukcja jest
// ponawiana po zakończeniu tury (ten sam licznik prób).

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

// Uzupełnia konfigurację domyślnymi model/agent przejętymi z sesji kontrolnej
// (czyli z czatu, w którym użytkownik wpisał /auto-exec). Wartości podane
// jawnie w pliku JSON mają pierwszeństwo.
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
    // brak dostępu do sesji kontrolnej — zostają domyślne ustawienia serwera
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
  // sesja z trwającą turą „ostatniej szansy" — handler mid-turn nie wolno jej
  // przerywać ani steerować (próby już wyczerpane, abort ubiłby model, zanim
  // zdążył wywołać narzędzie handoff — E2E diag2 r3)
  finalChance: string | null
  // ostatnie znane zużycie tokenów per sesja (z message.updated). Wykonanie
  // narzędzia dzieje się ZANIM bieżąca wiadomość dostanie tokeny (a po abort-cie
  // jej tokeny są zerowane) — snapshot w execute() widzi wtedy 0 i odrzuca
  // uprawniony handoff (E2E diag2 r4). Stąd guard używa max(snapshot, lastKnown).
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

  // ── wysyłanie tury do sesji ───────────────────────────────────────────────
  function buildBody(text: string, allowHandoff: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }],
    }
    // Narzędzie jest zawsze widoczne — flaga tools w treści żądania NIE zmienia
    // zestawu narzędzi trwającej tury (steering), a ukrywanie narzędzia (tools:false)
    // blokowałoby przekazanie pracy mid-turn. Ustawiamy tools:true wyłącznie
    // dla jawnych tur instrukcji (dokumentacja intencji).
    if (allowHandoff) body.tools = { [toolName]: true }
    if (run?.cfg.model) body.model = parseModel(run.cfg.model)
    if (run?.cfg.agent) body.agent = run.cfg.agent
    return body
  }

  // Odpala turę i NIE czeka na jej zakończenie — koniec tury obsłuży waiter,
  // na który czeka monitorStep. Używane przez handoff: gdyby execute() czekał
  // na całą turę kontynuacji, monitoring progu byłby zablokowany przez cały
  // czas jej trwania (incydent T8/kontynuacja 1 — sesja puchła do ~184k
  // tokenów bez steeringu, przekaz wymusił ręcznie użytkownik).
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

  // steering=true: wiadomość wstrzykiwana do TRWAJĄCEJ tury (kolejka opencode).
  // Nie rejestrujemy wtedy waitera — koniec tury i tak załatwi waiter tury
  // pierwotnej; podwójna rejestracja unieważniłaby jego resolve.
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

  // ── stan sesji po zakończonej turze ───────────────────────────────────────
  type SessionSnapshot = { tokens: number; error?: { name?: string; message?: string } }

  async function snapshot(sessionID: string): Promise<SessionSnapshot> {
    const res: any = await client.session.messages({ path: { id: sessionID } }, { throwOnError: true } as any)
    const data = res?.data ?? res
    const list: Array<{ info: any }> = Array.isArray(data) ? data : (data?.messages ?? [])
    // Ostatnia wiadomość assistant (dowolna) — z niej bierzemy error (do logiki
    // przerwanych tur w monitorStep). Tokeny bierzemy z ostatniej BEZBŁĘDNEJ
    // wiadomości assistant: przerwana tura (MessageAbortedError) jest zerowana
    // (wszystkie tokeny = 0), co bez tego oszukiwało próg i uciszało ścieżkę
    // „ostatniej szansy" po abort-cie (E2E diag2: krok kończył się po cichu).
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
      `Narzędzie służy do przekazania pracy do nowej konwersacji. W argumencie "description" opisz bardzo dokładnie: co zostało dotychczas zrobione, jakie były ustalenia, jakie pliki zmieniono i co jeszcze zostało do zrobienia w ramach bieżącego kroku. Po wywołaniu narzędzia Twoja praca zostanie kontynuowana w nowej konwersacji, która otrzyma ten opis wraz z pierwotnym zadaniem.`
    const lines: string[] = []
    if (final) {
      lines.push(
        `OSTATNIA SZANSA: Twoja poprzednia tura została przerwana, bo kontekst (${state.cfg.max_context} tokenów) został przekroczony, a Ty nie przekazałeś pracy. To czysta tura — nie kontynuuj bieżącego zadania.`,
      )
      lines.push(`Wywołaj narzędzie ${toolName} TERAZ jako jedyną akcję w tej turze.`)
    } else {
      lines.push(`Kończy Ci się okno kontekstowe. Wywołaj narzędzie ${toolName}. Opisz dokładnie co zrobiłeś i jakie masz ustalenia. Będziemy kontynuować w nowej konwersacji.`)
    }
    lines.push(``)
    lines.push(`Informacje o narzędzie ${toolName}:`)
    lines.push(desc)
    lines.push(``)
    if (attempt > 1 && !final) {
      lines.push(`UWAGA: to ponowna prośba (próba ${attempt}/${maxAttempts}). W poprzedniej turze nie wywołałeś narzędzia ${toolName}.`)
      lines.push(``)
    }
    lines.push(
      final
        ? `W argumencie "description" przekaż pełny opis stanu pracy i nie wywołuj żadnych innych narzędzi.`
        : `Wywołaj je teraz (jako jedyną akcję w tej turze) i przekaż w argumencie "description" pełny opis stanu pracy. Przestań wykonywać dalsze kroki zadania.`,
    )
    return lines.join("\n")
  }

  // ── tworzenie sesji ───────────────────────────────────────────────────────
  async function createSession(state: RunState, title: string): Promise<string> {
    const res: any = await client.session.create({ body: { title } }, { throwOnError: true } as any)
    const data = res?.data ?? res
    return data.id
  }

  // ── narzędzie handoff ─────────────────────────────────────────────────────
  const handoffDescription = `Zapisz przekaz dla nowej konwersacji, która będzie kontynuować bieżące zadanie. Wywołuj wyłącznie wtedy, gdy system wyraźnie o to poprosi (kończy się okno kontekstowe).`

  // ── główna pętla kroku ────────────────────────────────────────────────────
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
        // Ostatnia szansa: jedna czysta tura instrukcji po przerwaniu długiej
        // tury — w czystej turze model nie może ukryć się za "dokończę najpierw
        // bieżącą pracę" (E2E: niemal 100% skuteczności w czystych turach).
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
      // NIE ustawiamy permission.deny i NIE ukrywamy narzędzia — musi być dostępne
      // w każdej turze (w tym steeringowych i ręcznych), żeby handoff zadziałał
      // mid-turn. Przed spontanicznym wywołaniem chroni próg w execute().
      log("info", `zarejestrowano komendy /${START_COMMAND}, /${STOP_COMMAND}; narzędzie ${toolName} zawsze widoczne, próg: max_context w execute()`)
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = (event.properties as any)?.info
        if (!info || !run || run.stopping) return
        if (info.sessionID !== run.sessionID) return
        run.lastActivity = Date.now()
        // Zapamiętujemy ostatnie znane zużycie tokenów (message.updated przychodzi
        // wielokrotnie — max chroni przed częściowymi wartościami streamu). Wykorzystanie:
        // guard w execute(), który w momencie wywołania narzędzia nie widzi jeszcze
        // tokenów bieżącej wiadomości (patrz komentarz w RunState).
        if (info.role === "assistant") {
          const tk = info.tokens ?? {}
          const total =
            (tk.input ?? 0) + (tk.output ?? 0) + (tk.cache?.read ?? 0) + (tk.cache?.write ?? 0)
          if (total > (run.lastTokens.get(info.sessionID) ?? 0)) run.lastTokens.set(info.sessionID, total)
        }
        // Monitoring progu w TRAKCIE tury: każda zakończona wiadomość assistant
        // (krok pętli LLM) niesie stan tokenów. Przekroczenie progu w długiej
        // turze przerywa turę od razu — instrukcja handoff pójdzie w nowej turze,
        // bez czekania na naturalny koniec (kiedy kontekst ucieka jeszcze dalej).
        if (
          info.role === "assistant" &&
          waiters.has(info.sessionID) &&
          run.finalChance !== info.sessionID
        ) {
          const t = info.tokens ?? {}
          const total =
            (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          // message.updated przychodzi wielokrotnie dla tej samej wiadomości —
          // reagujemy tylko raz, na pierwsze zdarzenie z tokenami ponad próg.
          const lastHandled = run.handledMsgs.get(info.sessionID)
          if (total > run.cfg.max_context && info.id !== lastHandled) {
            run.handledMsgs.set(info.sessionID, info.id)
            const maxAttempts = run.cfg.max_instruction_attempts ?? DEFAULT_INSTRUCTION_ATTEMPTS
            const attempts = run.instructionAttempts.get(info.sessionID) ?? 0
            if (attempts < maxAttempts) {
              // Wstrzyknięcie steering do trwającej tury: prompt sterujący +
              // narzędzie handoff (tools:true) — agent widzi jedno i drugie
              // już w tej turze i może natychmiast przekazać pracę.
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
              // Limit instrukcji wyczerpany, sesja dalej puchnie — ostateczność:
              // przerywamy turę, żeby nie powstawała super-długa sesja.
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
        // Anulujemy wywołanie promptu — komenda służy tylko do sterowania wtyczką.
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
              "Bardzo dokładny opis: co zostało zrobione, jakie ustalenia podjęto, jakie pliki zmieniono, co pozostało do zrobienia.",
          },
        },
        async execute(args, context) {
          const state = run
          if (!state || state.stopping) {
            return "Błąd: automatyczne wykonywanie kroków nie jest aktywne — przekaz nie został zapisany."
          }
          if (context.sessionID !== state.sessionID) {
            return "Błąd: przekaz dla tej konwersacji już został wykonany."
          }
          // Zabezpieczenie przed spontanicznym wywołaniem: handoff wykonujemy
          // wyłącznie po przekroczeniu progu kontekstu. Tokeny bieżącej wiadomości
          // (tej z wywołaniem narzędzia) nie są jeszcze przypięte w momencie
          // execute(), a wiadomość po abort-cie jest zerowana — dlatego bierzemy
          // też ostatnie znane zużycie z message.updated (lastTokens).
          const snapNow = await snapshot(context.sessionID)
          const known = state.lastTokens.get(context.sessionID) ?? 0
          const seen = Math.max(snapNow.tokens, known)
          if (seen <= state.cfg.max_context) {
            return `Błąd: próg kontekstu (${state.cfg.max_context} tokenów) jeszcze nie został przekroczony — kontekst: ${seen}. Nie wywołuj tego narzędzia, dopóki system o to wyraźnie nie poprosi.`
          }
          const summary = String((args as any).description ?? "").trim()
          if (!summary) {
            return "Błąd: argument \"description\" jest wymagany — opisz dokładnie co zostało zrobione."
          }
          state.continuation++
          const title = `[auto-exec] krok ${state.step}/${state.cfg.to} — kontynuacja ${state.continuation}`
          const newSessionID = await createSession(state, title)
          const text =
            renderPrompt(state.cfg.prompt, state.step) + `\n\nCo zrobiono dotychczas: ${summary}`
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
            // Fire-and-forget: bez czekania na koniec tury kontynuacji — waiter
            // obsłuży monitorStep, a monitoring progu dla nowej sesji działa od
            // razu. Czekanie tutaj wyłączałoby monitoring na cały czas trwania
            // tury kontynuacji (incydent T8/kontynuacja 1).
            await startTurn(newSessionID, text, false)
          } catch (error) {
            // Cofamy stan, żeby ponowne wywołanie handoff_save w tej turze
            // przeszło przez guard sessionID i próg jak za pierwszym razem.
            state.sessionID = prevSessionID
            state.continuation--
            const message = error instanceof Error ? error.message : String(error)
            log("warn", `krok ${state.step}: uruchomienie kontynuacji nie powiodło się: ${message}`)
            return `Błąd: nie udało się uruchomić nowej konwersacji (${message}). Wywołaj ${toolName} ponownie.`
          }
          return "Nowa konwersacja została uruchomiona wraz z Twoim przekazem. Praca kontynuowana — zakończ tę wypowiedź krótkim podsumowaniem."
        },
      },
    },
  }
}

export default AutoExecutor
