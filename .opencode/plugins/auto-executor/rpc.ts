// Shared RPC definition of the auto-executor plugin.
//
// The server plugin (index.ts) emits `toast` events; the companion TUI plugin
// (tui.ts) subscribes to them and renders them as native TUI toasts. The
// definition object must be the same on both sides, so it lives in its own
// module. In opencode v2 the server-side plugin context has no TUI access
// (the V1 client.tui.showToast is gone) — this RPC is the toast channel.
import { Rpc } from "@opencode/plugin/rpc"

export const AutoExecRpc = Rpc.define({
  id: "auto-executor",
  methods: {},
  events: {
    toast: {
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
          duration: { type: "number" },
        },
        required: ["message", "variant"],
        additionalProperties: false,
      } as const,
    },
  },
})