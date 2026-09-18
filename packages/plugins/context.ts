import type { Plugin } from "@opencode/plugin/promise/plugin"
import type { Skill } from "@opencode/plugin"
import { assistantContext, prepareMemory, agentSkillAddition } from "../telegram/src/assistant"
import { managedHome } from "../telegram/src/config"

export const applicationContext = `# OpenCode Agent context

You are running in OpenCode Agent, a general-purpose personal assistant built on OpenCode.

Your tools operate on the user's configured agent machine. The user usually contacts you remotely through Telegram.

Help with research, writing, planning, file management, coding, and other tasks supported by your tools.
Apply software-engineering guidance when the task involves software.

Use the available tools to complete practical tasks. Know the difference between a file on the agent machine and a delivered attachment.

Keep replies concise. Use the question tool when you need the user's answer.`

export const telegramContext = `You are communicating through Telegram.
Use short paragraphs and simple formatting.
To send an existing file, put MEDIA:/absolute/path/to/file on its own line outside a code block.
The gateway uploads that file. A plain local path is not a downloadable attachment.
The gateway shows a short activity status. Send commentary only when it adds useful information.`

export default {
  id: "opencode-agent.context",
  async setup(ctx) {
    if (managedHome()) {
      await prepareMemory()
      await ctx.skill.transform(editor => {
        const native = editor.get("opencode")
        // The upstream mutable editor type expands branded strings. The runtime value remains Skill.Info.
        if (native) editor.add({ ...native as unknown as Skill.Info, id: "opencode-agent" as Skill.ID, name: "OpenCode Agent" as Skill.Name, description: "Configure, use, extend, or troubleshoot this personal assistant and its managed OpenCode V2 installation.", content: agentSkillAddition + "\n" + native.content })
      })
    }
    await ctx.session.hook("context", async event => {
      // Children need the same transport context, even without their own metadata.
      const visited = new Set<string>()
      let id: string | undefined = event.sessionID
      let telegram = false
      while (id && !visited.has(id)) {
        visited.add(id)
        const session = await ctx.session.get({ sessionID: id })
        if (session.metadata?.source === "opencode-agent" && session.metadata?.transport === "telegram") {
          telegram = true
          break
        }
        id = session.parentID
      }
      if (!telegram && !managedHome()) return
      if (!event.system.some(part => part.text === applicationContext)) event.system.push({ type: "text", text: applicationContext })
      if (telegram && !event.system.some(part => part.text === telegramContext)) event.system.push({ type: "text", text: telegramContext })
      if (managedHome()) {
        const context = await assistantContext()
        const previous = event.system.findIndex(part => part.text.startsWith("# OpenCode Agent installation\n"))
        if (previous >= 0) event.system[previous] = { type: "text", text: context }
        else event.system.push({ type: "text", text: context })
      }
    })
  },
} satisfies Plugin
