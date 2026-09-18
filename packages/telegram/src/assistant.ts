import { mkdir, open, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentHome, loadSettings } from "./config"

export async function prepareMemory(home = agentHome()) {
  const directory = join(home, "memory")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const name of ["MEMORY.md", "USER.md"]) {
    await writeFile(join(directory, name), "", { mode: 0o600, flag: "wx" }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    })
  }
}

async function memoryFile(path: string, maxChars: number) {
  const file = await open(path, "r").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  })
  if (!file) return ""
  try {
    const bytes = Buffer.alloc(maxChars * 4 + 4)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const text = bytes.subarray(0, bytesRead).toString("utf8")
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n[Memory exceeds its context limit. Read and shorten the file.]` : text
  } finally { await file.close() }
}

export async function assistantContext(home = agentHome()) {
  const settings = await loadSettings(home)
  const text = [
    "# OpenCode Agent installation\n",
    `Agent installation: ${home}`,
    `Agent command: ${join(home, "bin", "opencode-agent")}`,
    `Timezone: ${settings.timezone}`,
    `Current time: ${new Date().toISOString()}`,
    "Use opencode-agent config get to inspect project settings. Use opencode-agent config set <key> <value> to change one setting.",
    "Use opencode-agent opencode <args> for native OpenCode commands in this installation.",
    "Load the opencode-agent skill before configuring or troubleshooting this installation.",
    `Scheduled tasks: ${settings.schedules.enabled ? "enabled while the Telegram gateway runs" : "disabled"}. Missed runs are skipped.`,
  ]
  if (settings.memory.enabled) {
    const directory = join(home, "memory")
    text.push(
      "Remember useful preferences and durable facts during normal conversations. Use the native file tools to maintain the following files.",
      "Keep memory concise. Correct outdated entries. Remove entries when the user asks you to forget them.",
      "Store preferences in USER.md. Store other durable facts and decisions in MEMORY.md. Keep task details in session history.",
      "Use the assistant recall tools when earlier conversations can answer the user's question.",
    )
    for (const [name, limit] of [["USER.md", settings.memory.userMaxChars], ["MEMORY.md", settings.memory.maxChars]] as const) {
      const path = join(directory, name)
      text.push(`Memory file: ${path}\nContext limit: ${limit} characters.\n<saved-memory>\n${await memoryFile(path, limit)}\n</saved-memory>`)
    }
  }
  return text.join("\n\n")
}

export const agentSkillAddition = `# OpenCode Agent

OpenCode Agent is an unofficial personal-assistant installation of upstream OpenCode V2.
The agent machine has a separate OpenCode binary, HOME, configuration, credentials, sessions, and service.
Use the installation path and timezone from the session context.

## Commands

- Run \`opencode-agent config get\` to inspect project settings. Credentials are hidden.
- Run \`opencode-agent config get memory.maxChars\` to inspect a single setting.
- Run \`opencode-agent config set memory.maxChars 3000\` to change that setting.
- Run \`opencode-agent config set progress false\` to disable the Telegram status message.
- Run \`opencode-agent voice setup\` after changing the transcription model.
- Run \`opencode-agent doctor\` to check the installation.
- Run \`opencode-agent gateway status\` or \`opencode-agent gateway logs\` to inspect Telegram operation.
- Run \`opencode-agent setup\` to configure the bot token and owner.
- Run \`opencode-agent gateway restart\` after changing the default working directory or automatic approval.
- Run \`opencode-agent update\` to update the managed application and runtime.

Memory, timezone, progress, voice settings, and scheduler enablement reload automatically.
Use \`opencode-agent opencode <args>\` in place of bare \`opencode\` in the native guidance below.
This command targets the separate installation. It does not configure the host OpenCode installation.

## Telegram

Incoming files are available on the agent machine. Use native tools to read or process them.
To attach an existing file, write \`MEDIA:/absolute/path/to/file\` on its own line in your response.
The gateway uploads the file and removes the marker. Do not put the marker inside a code block.
The download limit is 20 MiB. The upload limit is 50 MiB. Large images can be sent as documents.
English voice messages are transcribed locally. Treat the transcription as user input that can contain recognition errors.
Use the question tool when you need the owner's answer. Telegram displays its choices and text input.

## Memory and scheduled tasks

Use native file tools for the memory files listed in the session context.
Use the assistant Code Mode namespace for conversation recall and scheduled tasks.
Search is bounded and returns continuation information. Continue searching when the requested conversation is older.
Scheduled tasks run in fresh OpenCode sessions. Their instructions must contain the information required to complete the task.
Use the configured timezone for recurring schedules. Use an explicit timezone offset for one-time dates.
Check the returned next run before confirming a schedule. Missed runs are skipped after downtime.
Results go to the owner's Telegram chat. The gateway must run for schedules to execute.

## Native OpenCode guidance

Use native skills, MCP, Code Mode, providers, permissions, and tools as described below.
`
