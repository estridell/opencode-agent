import type { Plugin } from "@opencode/plugin/promise/plugin"

export const applicationContext = `# OpenCode Agent context

You are running in OpenCode Agent, a general-purpose personal assistant built on OpenCode.

You communicate with the user through Telegram. Your tools operate on the user's configured agent machine.

Help with research, writing, planning, file management, coding, and other tasks supported by your tools.
Apply software-engineering guidance when the task involves software.

Keep replies suitable for a Telegram conversation.`

export default {
  id: "opencode-agent.context",
  async setup(ctx) {
    await ctx.session.hook("context", async event => {
      // Children need the same transport context, even without their own metadata.
      const visited = new Set<string>()
      let id: string | undefined = event.sessionID
      while (id && !visited.has(id)) {
        visited.add(id)
        const session = await ctx.session.get({ sessionID: id })
        if (session.metadata?.source === "opencode-agent" && session.metadata?.transport === "telegram") {
          if (!event.system.some(part => part.text === applicationContext)) {
            event.system.push({ type: "text", text: applicationContext })
          }
          return
        }
        id = session.parentID
      }
    })
  },
} satisfies Plugin
