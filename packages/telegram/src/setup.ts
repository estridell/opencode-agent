import { ask, confirm } from "./prompts"
import { Api } from "grammy"
import { mkdir, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { agentHome, configPath, errorText, loadConfig, saveConfig, type Config } from "./config"
import { installRuntime, prepareRuntime, runOpenCode, upstreamBinary, workspace } from "./runtime"
import { installService } from "./service"
import { Store } from "./store"

export async function setup() {
  if (!process.stdin.isTTY) throw new Error("Run opencode-agent setup in a terminal.")
  console.log("OpenCode Agent setup")
  console.log(`Installation directory: ${agentHome()}\n`)
  await prepareRuntime()
  try { await access(upstreamBinary()) }
  catch { console.log("Install the separate OpenCode V2 runtime."); await installRuntime() }
  let existing: Config | undefined
  try { existing = await loadConfig() } catch (error) {
    // An existing malformed config should be fixed, not silently replaced.
    if (await Bun.file(configPath()).exists()) throw error
  }
  if (await confirm("Sign in to a model provider now?", !existing)) {
    const exit = await runOpenCode(["auth", "login"])
    if (exit) console.log("Sign-in did not finish. To try again, run: opencode-agent opencode auth login")
  }
  console.log("Get a bot token from @BotFather. Token input is hidden.")
  const token = await ask(existing ? "Bot token (press Enter to keep the saved token)" : "Bot token", {
    secret: true,
    validate: text => (!text && existing) || /^\d+:[\w-]+$/.test(text) ? undefined : "Enter a valid BotFather token.",
  }) || existing!.token
  const api = new Api(token)
  let bot
  try { bot = await api.getMe() } catch (error) { throw new Error(errorText(error, [token])) }
  console.log(`Bot: @${bot.username}`)
  if ((await api.getWebhookInfo()).url) throw new Error("This bot has a webhook. Remove the webhook or use a different bot.")
  const ownerID = Number(await ask("Your numeric Telegram user ID", {
    defaultValue: existing?.ownerID.toString(),
    validate: text => /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0
      ? undefined : "Enter your positive numeric user ID, not your @username or bot ID.",
  }))
  console.log(`Open https://t.me/${bot.username}. Press Start to let the bot send messages.`)
  console.log(`The bot accepts messages only from user ID ${ownerID}.`)
  const rawDirectory = await ask("Working directory", { defaultValue: existing?.directory ?? workspace() })
  const directory = resolve(rawDirectory.startsWith("~/") ? join(homedir(), rawDirectory.slice(2)) : rawDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const store = new Store(join(agentHome(), "telegram.sqlite"))
  try {
    const binding = `${bot.id}:${ownerID}`
    if (store.get("binding") && store.get("binding") !== binding) throw new Error("This installation uses a different bot or owner. Set OPENCODE_AGENT_HOME to a different directory.")
    await saveConfig({ token, ownerID, directory, autoApprove: existing?.autoApprove ?? true })
    store.set("binding", binding)
  } finally { store.close() }
  console.log(`Configuration saved: ${configPath()}`)
  if (await confirm("Install and start the Telegram service?")) {
    await installService()
    console.log(`Setup complete. Send a message to @${bot.username}.`)
  } else console.log("Setup complete. To start the bot, run: opencode-agent gateway run")
}
