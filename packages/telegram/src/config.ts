import { homedir } from "node:os"
import { resolve, join, dirname } from "node:path"
import { mkdir, readFile } from "node:fs/promises"
import { writeAtomic } from "./files"
import { defaultVoiceSettings, parseVoiceSettings, type VoiceSettings } from "./voice"

/** The HOME/XDG fallback also supports a managed V2 service started before this environment variable was added. */
export function managedHome(): string | undefined {
  if (process.env.OPENCODE_AGENT_HOME) return resolve(process.env.OPENCODE_AGENT_HOME)
  const config = process.env.XDG_CONFIG_HOME
  if (config?.endsWith("/runtime/config") && process.env.HOME === join(dirname(config), "home")) return dirname(dirname(config))
}
export const agentHome = () => managedHome() ?? join(homedir(), ".opencode-agent")
export const configPath = () => join(agentHome(), "config.json")
export type Settings = {
  timezone: string
  progress: boolean
  memory: { enabled: boolean; maxChars: number; userMaxChars: number }
  schedules: { enabled: boolean }
  voice: VoiceSettings
}
export type Config = { token: string; ownerID: number; directory: string; autoApprove?: boolean } & Partial<Settings>

export function defaultSettings(): Settings {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    progress: true,
    memory: { enabled: true, maxChars: 2200, userMaxChars: 1375 },
    schedules: { enabled: true },
    voice: { ...defaultVoiceSettings },
  }
}

export function parseSettings(value: Record<string, unknown>): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project settings.")
  const defaults = defaultSettings()
  const result = { ...defaults, ...value } as Settings
  for (const section of ["memory", "schedules", "voice"] as const) {
    const input = value[section]
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error(`${section} must be an object.`)
    ;(result[section] as object) = { ...defaults[section], ...input as object }
    for (const key of Object.keys(input ?? {})) {
      if (!(key in defaults[section])) throw new Error(`Unknown setting: ${section}.${key}.`)
    }
  }
  for (const [name, item] of [["progress", result.progress], ["memory.enabled", result.memory.enabled], ["schedules.enabled", result.schedules.enabled], ["voice.enabled", result.voice.enabled]] as const) {
    if (typeof item !== "boolean") throw new Error(`${name} must be true or false.`)
  }
  for (const [name, item, maximum] of [["memory.maxChars", result.memory.maxChars, 100_000], ["memory.userMaxChars", result.memory.userMaxChars, 100_000], ["voice.threads", result.voice.threads, 64], ["voice.timeoutSeconds", result.voice.timeoutSeconds, 3600]] as const) {
    if (!Number.isSafeInteger(item) || item < 1 || item > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`)
  }
  result.voice = parseVoiceSettings(result.voice)
  if (typeof result.timezone !== "string") throw new Error("timezone must be an IANA timezone name.")
  try { new Intl.DateTimeFormat("en", { timeZone: result.timezone }) }
  catch { throw new Error("timezone must be an IANA timezone name.") }
  return { timezone: result.timezone, progress: result.progress, memory: result.memory, schedules: result.schedules, voice: result.voice }
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("Invalid configuration. Run opencode-agent setup.")
  const c = value as Record<string, unknown>
  if (typeof c.token !== "string" || !/^\d+:[\w-]+$/.test(c.token)) throw new Error("Invalid Telegram bot token.")
  if (!Number.isSafeInteger(c.ownerID) || Number(c.ownerID) <= 0) throw new Error("ownerID must be a positive Telegram user ID.")
  if (typeof c.directory !== "string" || !c.directory.startsWith("/")) throw new Error("directory must be an absolute path.")
  if (c.autoApprove !== undefined && typeof c.autoApprove !== "boolean") throw new Error("autoApprove must be true or false.")
  return { token: c.token, ownerID: Number(c.ownerID), directory: c.directory, autoApprove: c.autoApprove ?? true, ...parseSettings(c) }
}

export async function loadConfig(): Promise<Config> {
  try { return parseConfig(JSON.parse(await readFile(configPath(), "utf8"))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Run opencode-agent setup first.")
    throw error
  }
}

export async function saveConfig(config: Config) {
  const parsed = parseConfig(config)
  await mkdir(agentHome(), { recursive: true, mode: 0o700 })
  await writeAtomic(configPath(), JSON.stringify(parsed, null, 2) + "\n")
}

/** Settings also work before Telegram setup, for the managed terminal interface. */
export async function loadSettings(home = agentHome()): Promise<Settings> {
  try { return parseSettings(JSON.parse(await readFile(join(home, "config.json"), "utf8"))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings()
    throw error
  }
}

/** flock releases the lock if either process exits. Keep it held until the atomic write finishes. */
async function lockedConfig<T>(work: () => Promise<T>): Promise<T> {
  if (!Bun.which("flock")) throw new Error("Install util-linux (flock) to change project settings.")
  await mkdir(agentHome(), { recursive: true, mode: 0o700 })
  const child = Bun.spawn(["flock", "--exclusive", "--timeout", "10", "--no-fork", join(agentHome(), "config.lock"), process.execPath, "-e", 'process.stdout.write("locked"); await Bun.stdin.text()'], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  })
  const reader = child.stdout.getReader()
  try {
    const ready = await reader.read()
    if (ready.done) throw new Error("Could not lock project settings. Try again.")
    return await work()
  } finally {
    reader.releaseLock()
    child.stdin.end()
    await child.exited
  }
}

export async function configure(action: string, key?: string, raw?: string) {
  if (action === "set") {
    if (key === "token" || key === "ownerID") throw new Error("Run opencode-agent setup to change the bot token or owner.")
    return lockedConfig(() => configureValue(action, key, raw))
  }
  return configureValue(action, key, raw)
}

async function configureValue(action: string, key?: string, raw?: string) {
  const config = await loadConfig()
  const publicConfig = { ...config, token: "[redacted]" }
  if (action === "get" && !key) return publicConfig
  const parts = key?.split(".") ?? []
  if (!parts.length || parts.length > 2 || parts.some(p => ["__proto__", "prototype", "constructor"].includes(p))) throw new Error("Supply a valid setting name.")
  const parent = parts.length === 1 ? publicConfig : publicConfig[parts[0]! as keyof Config]
  const leaf = parts.at(-1)!
  if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, leaf)) throw new Error(`Unknown setting: ${key}.`)
  if (action === "get") return (parent as Record<string, unknown>)[leaf]
  if (action !== "set" || raw === undefined) throw new Error("Use config get [key] or config set <key> <value>.")
  let value: unknown = raw
  try { value = JSON.parse(raw) } catch { /* Plain strings need no JSON quotes. */ }
  const target = parts.length === 1 ? config : config[parts[0]! as keyof Config]
  ;(target as Record<string, unknown>)[leaf] = value
  await saveConfig(config)
  return `Setting saved: ${key}.`
}

// Never include credentials or HTTP request bodies in gateway logs.
export function errorText(error: unknown, secrets: string[] = []): string {
  let text = error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]")
  return text.replace(/bot\d+:[\w-]+/g, "bot[redacted]").slice(0, 800)
}
