import type { Plugin } from "@opencode/plugin/promise/plugin"
import { loadConfig, loadSettings, managedHome } from "../telegram/src/config"
import { Schedules, jobDefaults, type Schedule } from "../telegram/src/schedules"

export default {
  id: "opencode-agent.schedules",
  async setup(ctx) {
    if (!managedHome()) return
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "assistant", description: "Personal-assistant memory recall and scheduled tasks." })
      editor.add({
        name: "schedule",
        description: "Create, list, edit, pause, resume, or remove scheduled tasks. Results go to the owner's Telegram chat. Missed runs are skipped.",
        input: {
          type: "object", additionalProperties: false, required: ["action"],
          properties: {
            action: { type: "string", enum: ["list", "create", "update", "pause", "resume", "remove"] },
            id: { type: "string", description: "Task ID. Required except for list and create." },
            name: { type: "string", maxLength: 200 }, prompt: { type: "string", maxLength: 32000, description: "Complete instructions for a fresh session." },
            at: { type: "string", description: "One-time ISO date with timezone offset. Supply at or cron, never both." },
            cron: { type: "string", description: "Recurring five-field cron expression: minute hour day month weekday." },
            timezone: { type: "string", description: "IANA timezone. Defaults to the configured owner timezone." },
          },
        },
        options: { namespace: "assistant", codemode: true },
        async execute(input, tool) {
          const args = input as { action: string; id?: string; name?: string; prompt?: string; at?: string; cron?: string; timezone?: string }
          const settings = await loadSettings()
          const jobs = new Schedules()
          try {
            let result: unknown
            if (args.action === "list") result = { enabled: settings.schedules.enabled, jobs: jobs.list() }
            else if (["create", "update"].includes(args.action)) {
              if (args.at && args.cron) throw new Error("Supply at or cron, not both.")
              const schedule: Schedule | undefined = args.at ? { at: args.at } : args.cron ? { cron: args.cron } : undefined
              if (args.action === "create") {
                await loadConfig()
                if (!settings.schedules.enabled) throw new Error("Scheduled tasks are disabled. Set schedules.enabled to true first.")
                const session = await ctx.session.get({ sessionID: tool.sessionID })
                if (!args.name || !args.prompt || !schedule) throw new Error("Supply name, prompt, and at or cron.")
                result = jobs.create({ ...jobDefaults(session), name: args.name, prompt: args.prompt, schedule, timezone: args.timezone ?? settings.timezone })
              } else {
                if (!args.id) throw new Error("Supply the task ID.")
                result = jobs.update(args.id, { ...(args.name !== undefined ? { name: args.name } : {}), ...(args.prompt !== undefined ? { prompt: args.prompt } : {}), ...(schedule ? { schedule } : {}), ...(args.timezone ? { timezone: args.timezone } : {}) })
              }
            } else {
              if (!args.id) throw new Error("Supply the task ID.")
              if (args.action === "remove") { jobs.remove(args.id); result = { removed: args.id } }
              else if (["pause", "resume"].includes(args.action)) result = jobs.enable(args.id, args.action === "resume")
              else throw new Error("Unknown scheduled task action.")
            }
            return { content: JSON.stringify(result) }
          } finally { jobs.close() }
        },
      })
    })
  },
} satisfies Plugin
