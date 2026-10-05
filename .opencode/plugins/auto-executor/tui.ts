// auto-executor — TUI companion plugin (opencode v2 CLI plugin API)
//
// Loaded automatically by the terminal beside the server plugin (index.ts) in
// the same directory. It subscribes to the `toast` events of the
// `auto-executor` RPC (see rpc.ts) — the server plugin publishes every
// heartbeat and run event there — and renders them as native TUI toasts. This
// restores the V1 behavior of client.tui.showToast, which has no equivalent in
// the V2 server plugin context.
import { Plugin } from "@opencode/plugin/tui"
import { AutoExecRpc } from "./rpc.ts"

export default Plugin.define({
  id: "auto-executor.tui",
  setup(context) {
    const rpc = context.client.rpc(AutoExecRpc)
    const unsubscribe = rpc.events.on("toast", (event) => {
      // Only toasts of the location this TUI instance is attached to.
      const eventDirectory = event.location?.directory
      const ownDirectory = context.location?.directory
      if (eventDirectory && ownDirectory && eventDirectory !== ownDirectory) return
      // JSON Schema event data is `unknown` in TypeScript — narrow it here.
      const data = event.data as {
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
      context.ui.toast.show({
        message: data.message,
        variant: data.variant,
        duration: data.duration,
      })
    })
    return () => unsubscribe()
  },
})