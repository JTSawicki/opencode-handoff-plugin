# opencode-handoff-plugin

**auto-executor** — an [opencode](https://opencode.ai) plugin that sequentially executes
the steps of a task from a JSON file (you must provide the steps, described and numbered, in a separate MarkDown file): **one step = one new chat session**. If during a step
the context usage exceeds the threshold, the agent gets a message and calls the
`handoff_save` tool, which starts **a new conversation within the same step**
(initial prompt + "Progress so far: {agent's description}").

## AI-assisted development

This project was created with heavy AI support: **the vast majority of the plugin
code was written by AI**.
The plugin was tested with the **GLM 5.3 Flash** model (opencode 1.18.33).

## Requirements

- opencode ≥ 1.18 (tested on 1.18.33)
- no dependencies — the plugin is a single TypeScript file (type-only import)

## Installation

The plugin can be installed for a single project or globally:

1. Copy the plugin file from this repository:
   - per project:

     ```sh
     cp .opencode/plugins/auto-executor.ts <project>/.opencode/plugins/auto-executor.ts
     ```

   - globally:

     ```sh
     mkdir -p ~/.config/opencode/plugins
     cp .opencode/plugins/auto-executor.ts ~/.config/opencode/plugins/auto-executor.ts
     ```

2. Restart opencode (server/TUI).
3. Verification: the `/auto-exec` and `/stop-auto-execution` commands should be visible
   (in the TUI after typing `/`), and the server log should contain
   `zarejestrowano komendy /auto-exec, /stop-auto-execution; narzędzie handoff_save zawsze widoczne, próg: max_context w execute()` (this log line is emitted by the plugin in Polish).

The `opencode.test.json` file in this repository is **for testing only** (a local
lemonade/openrouter proxy) — **do not copy it** when deploying. The plugin loads
automatically from `.opencode/plugins/`; it does not require any entries in `opencode.json`.

## Usage

```
/auto-exec <path-to-json-file>         # start the step sequence
/stop-auto-execution                   # interrupt the current run
```

The commands control the plugin — they are not sent to the model (the command's LLM turn is intentionally cancelled).
Example configuration file: [`auto-exec.example.json`](auto-exec.example.json).

## Configuration file (JSON)

```json
{
  "prompt":      "task text, must contain the {step} placeholder",
  "from":        1,          // first step (default: 1)
  "to":          10,         // last step
  "max_context": 60000,      // context threshold in tokens (required, > 0)
  "model":       "provider/model-id",  // optional; defaults to the model of the current chat
  "agent":       "build",    // optional; defaults to the agent of the current chat
  "tool_description": "description of the handoff_save tool for the agent",  // optional
  "max_handoffs": 10,        // handoff limit per step (default: 10)
  "max_instruction_attempts": 5,  // handoff instruction limit per session (default: 5)
  "heartbeat_seconds": 45    // UI heartbeat frequency in seconds (0 = disabled; default: 45)
}
```

- `{step}` in prompts is replaced with the step number.
- Without the `model`/`agent` fields the plugin takes over **the model and agent selected in the chat**
  from which the `/auto-exec` command was issued (values from the JSON take precedence).
- The context counter = `input + output + cache.read + cache.write` from the last error-free
  assistant message; checked **after a finished turn** and **during a turn**
  (the `message.updated` event carries the tokens of each finished assistant message).

## How the handoff works

The `handoff_save` tool is **always visible** — the plugin neither hides it
(`tools:false`) nor blocks it (`permission.deny`). Reasons:

- the `tools` flag in the prompt content **does not change the tool set of an ongoing turn**
  (it only takes effect for a new turn), so hiding it would make handing off work
  mid-turn and in manual turns impossible,
- a hidden tool would also be invisible to mid-turn steering.

Protection against spontaneous calls is provided by the **threshold in `execute()`**: the tool refuses
until the session context exceeds `max_context` (the last known
token usage from `message.updated` events and the session snapshot are compared — the tokens of the
current message are not yet attached at the moment the tool executes).

The threshold is enforced at two levels:

1. **After a finished turn** — if the context > `max_context`, the agent gets an instruction
   ("You are running out of context window. Call the handoff_save tool…") and must describe the state
   of the work in the `description` argument. The instruction is **repeated** in subsequent turns
   (limit: `max_instruction_attempts`, default 5 attempts per session).
2. **During a turn** — every finished assistant message with tokens above the threshold
   injects **steering**: a steering prompt sent into the ongoing turn
   (`session.promptAsync` queues a message into the current turn) — the agent sees it
   immediately and can perform the handoff without finishing the turn. Steering is deduplicated
   (one per message) and uses the same attempt counter as the post-turn path.
   After `max_instruction_attempts` is exhausted, further threshold exceedances **abort the turn**
   (`session.abort`) — this prevents super-long sessions that cannot be rescued.

After an aborted turn (abort) there is still a **last chance**: one clean turn with the handoff
instruction ("LAST CHANCE…"), in which the mid-turn handler does not interfere — a model in a clean
turn cannot hide behind "I'll finish my current work first". If that fails too,
the step ends with a warning.

Calling `handoff_save` creates a new session `[auto-exec] step N/M — continuation K`
with the initial prompt + "Progress so far: {description}". The plugin starts the continuation
turn **without waiting for it to finish** (fire-and-forget) — the end of the turn
is handled by the monitoring loop through the waiter mechanism, and threshold monitoring covers
the continuation session **from the very first message**. (An earlier version waited in
`execute()` for the whole continuation turn, which disabled mid-turn monitoring
for that time —
the continuation bloated without steering until the user manually forced the handoff.)
The continuation chain is limited by `max_handoffs`; once either limit is reached,
the step ends with a warning. `/stop-auto-execution` sets the stop flag
and aborts the agent's active turn (`session.abort`).

## Heartbeat (UI visibility)

The plugin reports in the TUI that it is alive — no messages means the plugin has died:

- **periodic heartbeat** — every `heartbeat_seconds` (default 45 s) a toast: the current step,
  continuation number and time since last activity; `0` disables the heartbeat,
- **new task started** — a toast when each step's session is created,
- **agent turn finished** — a toast after each finished turn (`session.idle`),
- **handoff** — a toast when a continuation session is created after `handoff_save` is called,
- **run end / stop / error** — `success` / `warning` / `error` toasts.

All events are also written to the server log (`client.app.log`,
service `auto-executor`) — that is where you can verify the plugin's operation when the TUI is not
attached (toasts go exclusively to the TUI).

Note: `/auto-exec` **requires an argument** — the path to a JSON file. Calling it without
an argument does not start anything (a toast with usage + an entry in the server log).

## Notes

- The commands work in regular chats; the history of all step sessions is preserved
  (session titles have the `[auto-exec]` prefix).
- The model must call tools correctly. Models that ignore the tool list (e.g. the local
  lemonade/Qwen3.8 in some versions) may fail to perform the handoff — that is a model flaw,
  not a plugin flaw.
- An E2E test run (opencode 1.18.33, GLM 5.3 Flash model, degenerate case
  `max_context=1`) executed the full mid-turn chain: 2× steering during the turn → handoff
  **before the end of the turn** → continuation with the handoff → post-turn instruction → further handoffs
  → the `max_handoffs` limit → end of step. The variant with exhausted attempts went through the
  abort → "last chance" path.

## Tests and development

- `opencode.test.json` — test configuration (local lemonade/openrouter proxy).
  The test opencode server should be started from the directory containing `.opencode/plugins/`
  and this config (`opencode serve` instantiates itself in the current directory).
- Typecheck (the `@opencode-ai/plugin` types are needed — the plugin does not require them at runtime):

  ```sh
  cd .opencode
  npm i @opencode-ai/plugin
  npx -y -p typescript tsc --noEmit --skipLibCheck --strict --target es2022 \
    --module esnext --moduleResolution bundler plugins/auto-executor.ts
  ```

  The baseline contains ~11 "noise" errors (TS2554 — two-argument client calls,
  TS7006/7031 — implicit any, TS2322 — Plugin non-async, TS2591 — missing @types/node);
  the code works correctly under bun.

## License

[MIT](LICENSE)