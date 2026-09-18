import type { Plugin } from "@opencode/plugin/promise/plugin"
import { recall, type RecallInput } from "../telegram/src/recall"
import { connectExisting } from "../telegram/src/opencode"
import { managedHome } from "../telegram/src/config"

export default {
  id: "opencode-agent.recall",
  async setup(ctx) {
    if (!managedHome()) return
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "assistant", description: "Personal-assistant memory recall and scheduled tasks." })
      editor.add({
        name: "recall",
        description: "Find earlier conversations. Supply query for keyword search, sessionID to read history, or no arguments to list sessions. Follow cursors for older results.",
        input: {
          type: "object", additionalProperties: false,
          properties: {
            query: { type: "string", maxLength: 500 },
            sessionID: { type: "string" },
            cursor: { type: "string", description: "Cursor returned by the previous call with the same query or session ID." },
          },
        },
        options: { namespace: "assistant", codemode: true },
        execute: async input => ({ content: JSON.stringify(await recall(await connectExisting(), input as RecallInput)) }),
      })
    })
  },
} satisfies Plugin
