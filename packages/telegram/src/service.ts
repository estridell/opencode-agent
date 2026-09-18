import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { agentHome } from "./config"

export const unitName = "opencode-agent.service"
export const cliPath = () => fileURLToPath(new URL("./main.ts", import.meta.url))
export const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unitName)

export function systemdQuote(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error("Invalid newline in service path")
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`
}

export function serviceUnit(bun: string, cli: string, home: string, path: string) {
  if (!isAbsolute(home) || /[\r\n\0]/.test(home) || home.trim() !== home || home.endsWith("\\")) {
    throw new Error("The service working directory must be an absolute path without control characters or trailing whitespace or backslash.")
  }
  // WorkingDirectory accepts one path, not a quoted argument list like ExecStart.
  const directory = home.replaceAll("%", "%%")
  return `[Unit]\nDescription=OpenCode Agent Telegram gateway\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${directory}\nExecStart=${systemdQuote(bun)} ${systemdQuote(cli)} gateway run\nEnvironment=${systemdQuote(`OPENCODE_AGENT_HOME=${home}`)}\nEnvironment=${systemdQuote(`PATH=${path}`)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\nKillMode=process\n\n[Install]\nWantedBy=default.target\n`
}

export async function verifyService(file: string) {
  const child = Bun.spawn(["systemd-analyze", "--user", "verify", file], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`The service file is invalid.\n${(stdout + stderr).trim()}`)
}

export async function systemctl(args: string[]) {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed.`)
}

export async function installService(start = true) {
  if (process.platform !== "linux") throw new Error("The background-service installer currently supports Linux.")
  const file = unitPath()
  await mkdir(dirname(file), { recursive: true })
  const temporary = await mkdtemp(join(dirname(file), ".opencode-agent-check-"))
  try {
    const candidate = join(temporary, unitName)
    await writeFile(candidate, serviceUnit(process.execPath, cliPath(), agentHome(), process.env.PATH ?? "/usr/bin:/bin"), { mode: 0o600 })
    await verifyService(candidate)
    await rename(candidate, file)
  } finally { await rm(temporary, { recursive: true, force: true }) }
  await systemctl(["daemon-reload"])
  await systemctl(["enable", unitName])
  if (start) await systemctl(["restart", unitName])
  console.log(`Installed ${file}`)
  console.log(`For startup at boot and after SSH logout: loginctl enable-linger ${process.env.USER ?? "<your-user>"}`)
}
