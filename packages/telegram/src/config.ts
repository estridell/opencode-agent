import { homedir } from "node:os"
import { resolve, join } from "node:path"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"

export const agentHome = () => resolve(process.env.OPENCODE_AGENT_HOME || join(homedir(), ".opencode-agent"))
export const configPath = () => join(agentHome(), "config.json")
export type Config = { token: string; ownerID: number; directory: string; autoApprove?: boolean }

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("Invalid configuration. Run opencode-agent setup.")
  const c = value as Record<string, unknown>
  if (typeof c.token !== "string" || !/^\d+:[\w-]+$/.test(c.token)) throw new Error("Invalid Telegram bot token.")
  if (!Number.isSafeInteger(c.ownerID) || Number(c.ownerID) <= 0) throw new Error("ownerID must be a positive Telegram user ID.")
  if (typeof c.directory !== "string" || !c.directory.startsWith("/")) throw new Error("directory must be an absolute path.")
  if (c.autoApprove !== undefined && typeof c.autoApprove !== "boolean") throw new Error("autoApprove must be true or false.")
  return { token: c.token, ownerID: Number(c.ownerID), directory: c.directory, autoApprove: c.autoApprove ?? true }
}

export async function loadConfig(): Promise<Config> {
  try { return parseConfig(JSON.parse(await readFile(configPath(), "utf8"))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Run opencode-agent setup first.")
    throw error
  }
}

export async function saveConfig(config: Config) {
  parseConfig(config)
  await mkdir(agentHome(), { recursive: true, mode: 0o700 })
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  await chmod(configPath(), 0o600)
}

// Never include credentials or HTTP request bodies in gateway logs.
export function errorText(error: unknown, secrets: string[] = []): string {
  let text = error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]")
  return text.replace(/bot\d+:[\w-]+/g, "bot[redacted]").slice(0, 800)
}
