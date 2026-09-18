#!/usr/bin/env bun
import { join } from "node:path"
import { agentHome, errorText, loadConfig } from "./config"
import { connect } from "./opencode"
import { Store } from "./store"
import { Gateway } from "./gateway"
import { setup } from "./setup"
import { SetupCancelled } from "./prompts"
import { cliPath, installService, systemctl, unitName } from "./service"
import { prepareRuntime, runOpenCode, upstreamBinary, registrationFile } from "./runtime"

process.umask(0o077)

async function main(args: string[]) {
  const [command, subcommand, ...rest] = args
  if (command === "--help" || command === "help") {
    console.log(`OpenCode Agent (unofficial)\n\n  opencode-agent                    Open the separate OpenCode terminal interface\n  opencode-agent setup              Configure OpenCode and Telegram\n  opencode-agent opencode <args>     Run a command in the separate V2 installation\n  opencode-agent gateway run         Run Telegram in the terminal\n  opencode-agent gateway install     Install and start the systemd user service\n  opencode-agent gateway start|stop|restart|status\n  opencode-agent gateway logs        Show gateway logs\n  opencode-agent doctor              Check OpenCode and Telegram\n\nInstallation directory: ${agentHome()}`)
    return
  }
  if (command === "setup") return setup()
  if (!command || command === "opencode") {
    let directory: string | undefined
    try { directory = (await loadConfig()).directory } catch { /* CLI sign-in works before Telegram setup. */ }
    process.exitCode = await runOpenCode(command ? args.slice(1) : [], directory)
    return
  }
  if (command === "doctor") {
    const config = await loadConfig()
    console.log(`Agent home: ${agentHome()}\nRuntime: ${upstreamBinary()}\nRegistration: ${registrationFile()}\nWorkspace: ${config.directory}\nTelegram owner: ${config.ownerID}`)
    const client = await connect()
    const info = await client.server.info()
    const models = await client.model.list({ location: { directory: config.directory } })
    const api = new (await import("grammy")).Api(config.token)
    const bot = await api.getMe()
    console.log(`OpenCode version: ${info.version}\nEnabled models: ${models.data.filter(m => m.enabled).length}\nTelegram bot: @${bot.username}`)
    return
  }
  if (command === "gateway") {
    if (subcommand === "install") { await loadConfig(); return installService() }
    if (["start", "stop", "restart", "status"].includes(subcommand ?? "")) return systemctl([subcommand!, unitName])
    if (subcommand === "logs") {
      const child = Bun.spawn(["journalctl", "--user", "-u", unitName, "-f"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      process.exitCode = await child.exited
      return
    }
    if (subcommand === "run") {
      await prepareRuntime()
      if (!Bun.which("flock")) throw new Error("Install util-linux (flock) to run the gateway.")
      const child = Bun.spawn(["flock", "--no-fork", "--nonblock", "--conflict-exit-code", "73", join(agentHome(), "gateway.lock"), process.execPath, cliPath(), "gateway", "_run"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
      process.exitCode = await child.exited
      if (process.exitCode === 73) console.error("A gateway is already running for this agent home.")
      return
    }
    if (subcommand === "_run") {
      const config = await loadConfig()
      const controller = new AbortController()
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
        controller.abort()
        setTimeout(() => process.exit(0), 10_000).unref()
      })
      const store = new Store(join(agentHome(), "telegram.sqlite"))
      try {
        const gateway = new Gateway(config, store, await connect())
        await gateway.run(controller.signal)
      } finally { controller.abort(); store.close() }
      return
    }
  }
  throw new Error("Unknown command. Run opencode-agent --help.")
}

try { await main(process.argv.slice(2)) }
catch (error) {
  if (error instanceof SetupCancelled) {
    console.log("\nSetup cancelled.")
    process.exit(130)
  }
  let token = ""
  try { token = (await loadConfig()).token } catch { /* Setup may not be complete. */ }
  console.error(errorText(error, [token]))
  process.exitCode = 1
}
