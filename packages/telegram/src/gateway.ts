import { Api, GrammyError } from "grammy"
import type { Update } from "grammy/types"
import type { ModelRef, OpenCodeEvent, SessionInfo, SessionMessageAssistant } from "@opencode/client"
import { setTimeout as sleep } from "node:timers/promises"
import type { Config, Settings } from "./config"
import { agentHome, errorText, loadSettings, parseSettings } from "./config"
import { connect, isNotFound, type Client } from "./opencode"
import { Store, type Action, type TrackedSession } from "./store"
import { Telegram } from "./telegram"
import { Forms } from "./forms"
import { Pickers, type Choice } from "./pickers"
import { startUpdate } from "./update"
import { Images, imageType } from "./images"
import { cacheAttachment, responseAttachments } from "./attachments"
import { transcribeVoice } from "./voice"
import { Schedules, jobSession } from "./schedules"
import { join } from "node:path"

type Defaults = { model?: ModelRef; agent?: string }
type VoiceInput = { sessionID: string; messageID: string; path: string; caption?: string; updateID: number }
const modelLabel = (model: ModelRef) => `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ""}`

export const commands = [
  { command: "new", description: "Start a fresh session" },
  { command: "sessions", description: "Resume a Telegram session" },
  { command: "stop", description: "Interrupt the active session" },
  { command: "status", description: "Show the current session" },
  { command: "usage", description: "Show token usage and context estimate" },
  { command: "compact", description: "Compact the current context" },
  { command: "retry", description: "Retry the failed request" },
  { command: "model", description: "Choose a model (optional search text)" },
  { command: "agent", description: "Choose an agent" },
  { command: "update", description: "Update the application and OpenCode" },
  { command: "help", description: "Show commands and usage" },
]
const help = `**OpenCode Agent**\nSend text, files, images, or an English voice message. New messages give instructions to the task in progress.\n\n/new [title] - create a session\n/sessions - select a previous bot session\n/stop - stop work in the selected session\n/status - show the session, model, and directory\n/usage - show usage and context estimate\n/compact - compact the current context\n/retry - retry a failed request\n/model [search] - select a model and variant\n/agent - select an agent\n/update - update the application and OpenCode\n/help - show this message\n\nIncoming files: up to 20 MiB each. Use a model with image input for images.\nAsk in chat to remember information, find an earlier conversation, or manage scheduled tasks.\nTo answer a question, reply with text or use its buttons.\n\nThis is an unofficial community project. It is not affiliated with the OpenCode team.`

export function authorized(update: Update, ownerID: number): boolean {
  const message = update.message ?? update.callback_query?.message
  const from = update.message?.from ?? update.callback_query?.from
  return from?.id === ownerID && message?.chat.type === "private" && message.chat.id === ownerID
}

export class Gateway {
  readonly telegram: Telegram
  readonly forms: Forms
  readonly pickers: Pickers
  readonly images: Images
  requestUpdate = startUpdate
  transcribe = transcribeVoice
  settings: Settings
  private dirty = true
  private known = new Set<string>()
  private activity = new Map<string, string>()
  private voiceTask?: { sessionID: string; controller: AbortController }
  constructor(readonly config: Config, readonly store: Store, public client: Client, readonly api = new Api(config.token), spacing = 1050, readonly home = agentHome()) {
    this.telegram = new Telegram(api, config.ownerID, store, spacing)
    this.forms = new Forms(() => this.client, store, this.telegram)
    this.pickers = new Pickers(store, this.telegram)
    this.images = new Images(api, config.token)
    this.settings = parseSettings(config)
    for (const s of store.sessions()) this.known.add(s.id)
  }

  async initialize() {
    const bot = await this.api.getMe()
    const binding = `${bot.id}:${this.config.ownerID}`
    const previous = this.store.get<string>("binding")
    if (previous && binding !== previous) throw new Error("This state belongs to another bot/owner. Use a separate OPENCODE_AGENT_HOME.")
    this.store.set("binding", binding)
    const webhook = await this.api.getWebhookInfo()
    if (webhook.url) throw new Error("This bot has a webhook. Remove it before running the long-polling gateway.")
    // A chat-scoped menu fails before the owner first opens the bot. This menu
    // contains public command names only; authorized() still checks every update.
    await this.api.setMyCommands(commands, { scope: { type: "all_private_chats" } })
    this.store.pruneActions()
    console.log(`Telegram connected: @${bot.username}`)
  }

  private track(session: SessionInfo) {
    const value: TrackedSession = { id: session.id, title: session.title ?? "Untitled", created: session.time.created, parentID: session.parentID }
    this.store.track(value)
    this.known.add(session.id)
  }

  async newSession(updateID: number, title?: string) {
    const id = `ses_tg_${this.store.get<string>("binding")!.replaceAll(":", "_")}_${updateID}`
    let session: SessionInfo
    try { session = await this.client.session.get({ sessionID: id }) }
    catch (error) {
      if (!isNotFound(error)) throw error
      const defaults = this.store.get<Defaults>("defaults") ?? {}
      session = await this.client.session.create({ id, title: title || undefined, ...defaults, location: { directory: this.config.directory }, metadata: { source: "opencode-agent", transport: "telegram" } })
    }
    this.track(session)
    this.store.set("active", session.id)
    this.dirty = true
    return session.id
  }

  async active(updateID: number) {
    return this.store.get<string>("active") ?? await this.newSession(updateID)
  }

  async handle(update: Update) {
    if (!authorized(update, this.config.ownerID)) return
    if (update.callback_query) {
      const query = update.callback_query
      const action = this.store.action(query.data ?? "")
      const interaction = action?.kind === "permission" || action?.kind === "retry" || action?.kind.startsWith("form-")
      if (!action || !this.known.has(action.sessionID) || (!interaction && !this.pickers.current(action, query.message?.message_id))) {
        await this.api.answerCallbackQuery(query.id, { text: "This menu has expired. Open the command again." }).catch(() => {})
        return
      }
      try {
        await this.callback(action)
        await this.api.answerCallbackQuery(query.id).catch(() => {})
      } catch (error) {
        // A failed button press belongs to the picker, not to a new chat message.
        await this.api.answerCallbackQuery(query.id, { text: errorText(error, [this.config.token]).slice(0, 190), show_alert: true }).catch(() => {})
        console.error(errorText(error, [this.config.token]))
      }
      this.dirty = true
      return
    }
    const message = update.message!
    const respond = (text: string) => this.telegram.send(text, undefined, `update:${update.update_id}`)
    const hasFile = !!message.photo?.length || !!message.document || !!message.voice
    if (!message.text && !hasFile) return respond("Send text, a file, an image, or a voice message.")
    let text = message.text ?? message.caption ?? (message.photo?.length ? "Analyze the attached image." : "Use the attached file.")
    const command = message.text && /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(message.text)
    if (command) {
      const name = command[1]!.toLowerCase()
      const arg = command[2]?.trim() ?? ""
      if (name === "update") {
        const key = `update-job:${update.update_id}`
        if (this.store.get(key)) return
        const id = await respond("Starting update.")
        try { this.store.set(key, await this.requestUpdate(id)) }
        catch (error) { await this.telegram.edit(id, errorText(error, [this.config.token])) }
        return
      }
      if (name === "start" || name === "help") return respond(help)
      if (name === "new") {
        await this.newSession(update.update_id, arg)
        return respond("New session.")
      }
      const sessionID = await this.active(update.update_id)
      if (name === "sessions") return this.sessionMenu(0)
      if (name === "model") return this.modelMenu(sessionID, arg, 0)
      if (name === "agent") return this.agentMenu(sessionID)
      if (name === "stop") {
        if (this.voiceTask?.sessionID === sessionID) this.voiceTask.controller.abort()
        for (const pending of this.store.entries<VoiceInput>("voice-input:")) if (pending.value.sessionID === sessionID) {
          this.store.delete(pending.key)
          this.store.delete(`voice-transcript:${pending.value.messageID}`)
        }
        await this.client.session.interrupt({ sessionID, resume: false })
        await respond("Interrupted the active session.")
        this.dirty = true
        return
      }
      if (name === "usage") return respond(await this.usage(sessionID))
      if (name === "compact") {
        await this.client.session.compact({ sessionID, id: `msg_tg_compact_${this.config.ownerID}_${update.update_id}`, delivery: "queue" })
        this.activity.set(sessionID, "Compacting context.")
        this.dirty = true
        return respond("Context compaction requested.")
      }
      if (name === "retry") {
        await this.retry(sessionID)
        return
      }
      if (name === "status") {
        const session = await this.client.session.get({ sessionID })
        const active = await this.client.session.active()
        const model = session.model ?? (await this.client.model.default({ location: session.location })).data
        return respond(`${active[sessionID] ? "Working" : "Idle"}\nModel: ${model ? modelLabel(model) : "Unavailable"}\nAgent: ${session.agent ?? "OpenCode default"}\nDirectory: ${session.location.directory}`)
      }
      return respond("Unknown command. Use /help.")
    }
    const reply = message.reply_to_message && this.store.get<Action>(`form-reply:${message.reply_to_message.message_id}`)
    if (reply && hasFile) return respond("Reply with text to answer this question. Send the file as a separate message.")
    if (reply) { await this.forms.act({ ...reply, kind: "form-value" }, text); this.dirty = true; return }
    // Remember routing before admission, so a redelivered Telegram update cannot target a newly selected session.
    const route = `input:${update.update_id}`
    const sessionID = this.store.get<string>(route) ?? await this.active(update.update_id)
    this.store.set(route, sessionID)
    const messageID = `msg_tg_${this.store.get<string>("binding")!.replaceAll(":", "_")}_${message.message_id}`
    let files: Awaited<ReturnType<Images["attachment"]>>[] | undefined
    if (message.photo?.length) files = [await this.images.attachment(message)]
    else if (message.document || message.voice) {
      if (message.voice && !this.settings.voice.enabled) return respond("Voice transcription is disabled. Send text or enable voice.enabled.")
      const { bytes, name } = await this.images.download(message)
      const mime = imageType(bytes)
      if (message.document && mime) {
        files = [{ uri: `data:${mime};base64,${bytes.toString("base64")}`, name }]
        if (!message.caption) text = "Analyze the attached image."
      } else {
        const path = await cacheAttachment(this.home, name, bytes)
        if (message.voice) {
          this.store.set(`voice-input:${update.update_id}`, { sessionID, messageID, path, caption: message.caption, updateID: update.update_id } satisfies VoiceInput)
          this.activity.set(sessionID, "Transcribing voice.")
          this.dirty = true
          return
        }
        text += `\n\nAttached file on the agent machine: ${JSON.stringify(path)}. Use the native tools to read or process this file.`
      }
    }
    this.store.set(`last-input:${sessionID}`, messageID)
    await this.client.session.prompt({
      sessionID,
      id: messageID,
      text, ...(files ? { files } : {}), delivery: "steer", metadata: { transport: "telegram", updateID: update.update_id },
    })
    this.activity.set(sessionID, "Thinking.")
    void this.telegram.typing()
    this.dirty = true
  }

  async processVoice(signal?: AbortSignal) {
    for (const { key, value } of this.store.entries<VoiceInput>("voice-input:")) {
      if (signal?.aborted) return
      if (this.settings.progress) await this.telegram.status(value.sessionID, "Transcribing voice.")
      const controller = new AbortController()
      this.voiceTask = { sessionID: value.sessionID, controller }
      let submitting = false
      try {
        const transcriptKey = `voice-transcript:${value.messageID}`
        let transcript = this.store.get<string>(transcriptKey)
        if (transcript === undefined) {
          transcript = await this.transcribe(this.home, value.path, this.settings.voice, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
          if (!this.store.get(key)) continue
          this.store.set(transcriptKey, transcript)
        }
        if (!transcript.trim()) throw new Error("No speech was detected. Send the message again or use text.")
        if (!this.store.get(key)) continue
        this.store.set(`last-input:${value.sessionID}`, value.messageID)
        submitting = true
        await this.client.session.prompt({ sessionID: value.sessionID, id: value.messageID, text: `${value.caption ? value.caption + "\n\n" : ""}[Voice message transcription]\n${transcript}`, delivery: "steer", metadata: { transport: "telegram", updateID: value.updateID } })
        this.store.delete(key)
        this.store.delete(transcriptKey)
        this.activity.set(value.sessionID, "Thinking.")
      } catch (error) {
        if (signal?.aborted) return
        if (!this.store.get(key)) continue
        if (submitting && /Transport|fetch|connect|timeout/i.test(`${(error as Error).name} ${(error as Error).message}`)) throw error
        await this.telegram.finish(value.sessionID, errorText(error, [this.config.token]), `voice-error:${value.messageID}`)
        this.store.delete(key)
        this.store.delete(`voice-transcript:${value.messageID}`)
      } finally { this.voiceTask = undefined }
      this.dirty = true
    }
  }

  async retry(sessionID: string, expectedID?: string) {
    const session = await this.client.session.get({ sessionID })
    if ((await this.client.session.active())[sessionID]) throw new Error("This session is still working.")
    if (session.outcome !== "failed") throw new Error("This session has no failed request to retry.")
    const messageID = this.store.get<string>(`last-input:${sessionID}`)
    if (!messageID || (expectedID && expectedID !== messageID)) throw new Error("This retry no longer matches the failed request.")
    const original = await this.client.session.message.get({ sessionID, messageID })
    if (original.type !== "user") throw new Error("The original request is no longer available.")
    await this.client.session.prompt({ sessionID, id: original.id, text: original.text, resume: true })
    this.activity.set(sessionID, "Thinking.")
    this.dirty = true
  }

  async usage(sessionID: string) {
    const session = await this.client.session.get({ sessionID })
    const tokens = session.tokens
    const lines = [`Session tokens: input ${tokens.input ?? 0}, output ${tokens.output ?? 0}, reasoning ${tokens.reasoning ?? 0}.`, `Cache tokens: read ${tokens.cache?.read ?? 0}, write ${tokens.cache?.write ?? 0}.`, `Recorded cost: $${(session.cost ?? 0).toFixed(4)}.`]
    const context = await this.client.session.context({ sessionID })
    const latest = [...context].reverse().find(m => m.type === "assistant" && m.tokens)
    if (latest?.type === "assistant" && latest.tokens) {
      const t = latest.tokens
      const used = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
      const model = (await this.client.model.list({ location: session.location })).data.find(m => m.providerID === latest.model.providerID && m.id === latest.model.id)
      lines.push(`Last request context estimate: ${used} tokens${model?.limit.context ? ` (${Math.round(used / model.limit.context * 100)}% of ${model.limit.context})` : ""}.`)
    } else lines.push("Context estimate is not available yet.")
    return lines.join("\n")
  }

  private button(label: string, action: Action) { return { text: label.slice(0, 60), callback_data: this.store.button(action) } }

  private choice(text: string, action: Action): Choice { return { text, action } }

  async sessionMenu(page: number, pickerID?: string) {
    const sessions = this.store.sessions().filter(s => !s.parentID && !s.missing)
    const active = this.store.get<string>("active")!
    const choices = sessions.map(s => this.choice(`${active === s.id ? "✓ " : ""}${s.title}`, { kind: "session", sessionID: s.id }))
    await this.pickers.page("Sessions", choices, { kind: "sessions", sessionID: active, page }, pickerID)
  }

  async modelMenu(sessionID: string, search: string, page: number, pickerID?: string) {
    const session = await this.client.session.get({ sessionID })
    const models = (await this.client.model.list({ location: session.location })).data.filter(m => m.enabled && `${m.name} ${m.providerID}/${m.id}`.toLowerCase().includes(search.toLowerCase()))
    const choices = models.map(m => this.choice(`${m.providerID}/${m.id}`, { kind: "model", sessionID, value: JSON.stringify({ providerID: m.providerID, id: m.id }), search }))
    await this.pickers.page("Models", choices, { kind: "models", sessionID, search, page }, pickerID, "No models found. Use /model <search> to try again.")
  }

  async agentMenu(sessionID: string, page = 0, pickerID?: string) {
    const session = await this.client.session.get({ sessionID })
    const agents = (await this.client.agent.list({ location: session.location })).data.filter(a => !a.hidden && a.mode !== "subagent")
    const choices = agents.map(a => this.choice(a.name, { kind: "agent", sessionID, value: a.id }))
    await this.pickers.page("Agents", choices, { kind: "agents", sessionID, page }, pickerID)
  }

  private async defaultMenu(action: Action, label: string, kind: "model" | "agent") {
    const choice = { ...action, kind: `${kind}-apply` }
    await this.pickers.show(`${label}\n\nSet as default for new sessions?`, [
      [this.choice("Yes", { ...choice, field: "default" }), this.choice("No", { ...choice, field: "session" })],
      [this.choice("Back", { kind: kind === "model" ? (action.kind === "variant" ? "model" : "models") : "agents", sessionID: action.sessionID, value: action.value, search: action.search, page: action.page }),
        this.choice("Cancel", { kind: "cancel", sessionID: action.sessionID })],
    ], action.pickerID)
  }

  async callback(action: Action) {
    const { sessionID } = action
    if (action.kind === "retry") return this.retry(sessionID, action.value)
    if (action.kind.startsWith("form-")) {
      const result = await this.forms.act(action)
      if (result) await this.telegram.send(result, undefined, undefined, true)
      return
    }
    if (action.kind === "permission") {
      const pending = await this.client.permission.list({ sessionID })
      if (!pending.some(p => p.id === action.id)) { await this.telegram.send("That permission request is already resolved."); return }
      if (!["once", "always", "reject"].includes(action.value!)) throw new Error("Unknown permission decision")
      await this.client.permission.reply({ sessionID, requestID: action.id!, decision: action.value as "once" | "always" | "reject" })
      const id = this.store.get<number>(`permission:${action.id}`)
      if (id) await this.telegram.edit(id, `Permission: ${action.value === "reject" ? "Rejected" : action.value === "once" ? "Allowed once" : "Always allowed through OpenCode"}.`)
      this.store.delete(`permission:${action.id}`)
      return
    }
    // Old, completed, or replaced pages cannot change a session or its defaults.
    if (!this.pickers.current(action)) return
    const pickerID = action.pickerID!
    if (action.kind === "cancel") return this.pickers.finish(pickerID, "Cancelled.")
    if (action.kind === "session") {
      const session = await this.client.session.get({ sessionID })
      this.store.set("active", sessionID)
      await this.pickers.finish(pickerID, `Session: ${session.title ?? "Untitled"}`)
      return
    }
    if (action.kind === "sessions") return this.sessionMenu(action.page ?? 0, pickerID)
    if (sessionID !== this.store.get("active")) throw new Error("This menu belongs to a different session. Open /model or /agent again.")
    if (action.kind === "models") return this.modelMenu(sessionID, action.search ?? "", action.page ?? 0, pickerID)
    if (action.kind === "agents") return this.agentMenu(sessionID, action.page ?? 0, pickerID)
    if (action.kind === "model") {
      const selected = JSON.parse(action.value!) as ModelRef
      const model = { providerID: selected.providerID, id: selected.id }
      const session = await this.client.session.get({ sessionID })
      const found = (await this.client.model.list({ location: session.location })).data.find(m => m.providerID === model.providerID && m.id === model.id)
      if (!found?.enabled) throw new Error("That model is no longer available.")
      if (found.variants.length) {
        const base = { kind: "variant", sessionID, search: action.search, page: action.page }
        const rows: Choice[][] = [this.choice("Default variant", { ...base, value: JSON.stringify(model) }), ...found.variants.slice(0, 90).map(v => this.choice(v.id, { ...base, value: JSON.stringify({ ...model, variant: v.id }) }))].map(b => [b])
        rows.push([this.choice("Back", { kind: "models", sessionID, search: action.search, page: action.page }), this.choice("Cancel", { kind: "cancel", sessionID })])
        await this.pickers.show(`${found.name}\nSelect a variant.`, rows, pickerID)
        return
      }
      return this.defaultMenu(action, `Model: ${modelLabel(model)}`, "model")
    }
    if (action.kind === "variant") {
      const model = JSON.parse(action.value!) as ModelRef
      return this.defaultMenu(action, `Model: ${modelLabel(model)}`, "model")
    }
    if (action.kind === "agent") {
      return this.defaultMenu(action, `Agent: ${action.value}`, "agent")
    }
    if (action.kind === "model-apply") {
      const model = JSON.parse(action.value!) as ModelRef
      const session = await this.client.session.get({ sessionID })
      const found = (await this.client.model.list({ location: session.location })).data.find(m => m.providerID === model.providerID && m.id === model.id)
      if (!found?.enabled || (model.variant && !found.variants.some(v => v.id === model.variant))) throw new Error("That model or variant is no longer available. Open /model again.")
      await this.client.session.switchModel({ sessionID, model })
      if (action.field === "default") this.store.set("defaults", { ...this.store.get<Defaults>("defaults"), model })
      return this.pickers.finish(pickerID, `Model: ${modelLabel(model)}${action.field === "default" ? "\nDefault saved." : ""}`)
    }
    if (action.kind === "agent-apply") {
      await this.client.session.switchAgent({ sessionID, agent: action.value! })
      if (action.field === "default") this.store.set("defaults", { ...this.store.get<Defaults>("defaults"), agent: action.value! })
      return this.pickers.finish(pickerID, `Agent: ${action.value}${action.field === "default" ? "\nDefault saved." : ""}`)
    }
  }

  onEvent(event: OpenCodeEvent) {
    if (event.type === "server.connected") { this.dirty = true; return }
    if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const id = event.data.sessionID
    if (!this.known.has(id)) {
      // Reconciliation discovers child sessions; avoid subscribing to unrelated session output.
      if (event.type === "session.created" && event.data.parentID && this.known.has(event.data.parentID)) this.dirty = true
      return
    }
    switch (event.type) {
      case "session.execution.started":
      case "session.step.started":
      case "session.reasoning.started": this.activity.set(id, "Thinking."); break
      case "session.tool.input.started": this.activity.set(id, `Running ${event.data.name.replace(/[^\w .-]/g, " ").slice(0, 60)}.`); break
      case "session.compaction.started": this.activity.set(id, "Compacting context."); break
      case "session.retry.scheduled": this.activity.set(id, "Waiting to retry."); break
    }
    this.dirty = true
  }

  private async messages(session: TrackedSession, failureKey?: string) {
    const checkpoint = this.store.get<string>(`checkpoint:${session.id}`)
    const pending: SessionMessageAssistant[] = []
    let cursor: string | undefined
    let found = false
    let completed = false
    do {
      const page = await this.client.message.list({ sessionID: session.id, type: "assistant", limit: 100, ...(cursor ? { cursor } : { order: "desc" as const }) })
      for (const m of page.data) {
        if (m.id === checkpoint) { found = true; break }
        if (m.type === "assistant") pending.push(m)
      }
      cursor = page.cursor.next ?? undefined
    } while (cursor && !found)
    const newestID = pending[0]?.id
    for (const m of pending.reverse()) {
      if (!m.time.completed) break
      const result = responseAttachments(m.content.filter(c => c.type === "text").map(c => c.text).join("\n\n"))
      if (m.finish === "tool-calls" && !m.error) {
        this.store.set(`checkpoint:${session.id}`, m.id)
        continue
      }
      completed = true
      if (result.text && !m.error) {
        const prefix = this.store.get("active") === session.id ? "" : `**${session.title}**\n\n`
        await this.telegram.finish(session.id, prefix + result.text, `message:${session.id}:${m.id}`)
      }
      for (const [index, path] of result.paths.entries()) await this.telegram.file(path, `file:${session.id}:${m.id}:${index}`)
      if (!m.error && !result.text && result.paths.length && this.store.get(`progress:${session.id}`)) await this.telegram.finish(session.id, "File response complete.", `file-status:${session.id}:${m.id}`)
      if (m.error) {
        const key = failureKey && m.id === newestID ? failureKey : `error:${session.id}:${m.id}`
        if (!this.store.sent(`${key}:0`)) {
          const originalID = this.store.get<string>(`last-input:${session.id}`)
          const keyboard = originalID ? [[this.button("Retry", { kind: "retry", sessionID: session.id, value: originalID })]] : undefined
          await this.telegram.finish(session.id, `${result.text ? result.text + "\n\n" : ""}OpenCode error: ${errorText(m.error, [this.config.token])}`, key, keyboard)
        }
      }
      this.store.set(`checkpoint:${session.id}`, m.id)
    }
    return completed
  }

  async reconcile() {
    const running = await this.client.session.active()
    const voices = new Set(this.store.entries<VoiceInput>("voice-input:").map(row => row.value.sessionID))
    // Children use the same owner routing for permission/question interactions.
    const queue = this.store.sessions().filter(s => !s.missing)
    for (const session of queue) {
      let cursor: string | undefined
      do {
        const children = await this.client.session.list({ parentID: session.id, limit: 100, ...(cursor ? { cursor } : {}) })
        for (const child of children.data) if (!this.known.has(child.id)) {
          this.track(child)
          queue.push({ id: child.id, title: child.title ?? "Subagent", created: child.time.created, parentID: session.id })
        }
        cursor = children.cursor.next ?? undefined
      } while (cursor)
    }
    for (const tracked of queue) {
      try {
        const session = await this.client.session.get({ sessionID: tracked.id })
        this.track(session)
        const permissions = await this.client.permission.list({ sessionID: session.id })
        for (const old of this.store.get<string[]>(`permissions:${session.id}`) ?? []) {
          if (permissions.some(p => p.id === old)) continue
          const id = this.store.get<number>(`permission:${old}`)
          if (id) await this.telegram.edit(id, "Permission resolved in OpenCode.")
          this.store.delete(`permission:${old}`)
        }
        for (const p of permissions) {
          if (this.config.autoApprove !== false) {
            try { await this.client.permission.reply({ sessionID: session.id, requestID: p.id, decision: "once" }) }
            catch (error) {
              // Another client may have answered it after the pending-request query.
              if (!isNotFound(error)) throw error
            }
            continue
          }
          if (this.store.get(`permission:${p.id}`)) continue
          const rows = [[this.button("Allow once", { kind: "permission", sessionID: session.id, id: p.id, value: "once" }), this.button("Reject", { kind: "permission", sessionID: session.id, id: p.id, value: "reject" })]]
          rows.push([this.button("Always allow", { kind: "permission", sessionID: session.id, id: p.id, value: "always" })])
          const text = `**Permission requested** — ${session.title ?? session.id}\nAction: ${p.action}\n${p.resources.join("\n")}\n${p.message ?? ""}${p.save?.length ? `\nAlways-allow patterns:\n${p.save.join("\n")}` : ""}`
          const id = await this.telegram.send(text, rows, `permission:${p.id}`)
          this.store.set(`permission:${p.id}`, id)
        }
        this.store.set(`permissions:${session.id}`, permissions.map(p => p.id))
        const forms = await this.forms.reconcile(session.id)
        if (tracked.parentID) continue
        const failureKey = `failed:${session.id}:${session.time.idle ?? session.time.updated}`
        const completed = !running[session.id] && await this.messages({ ...tracked, title: session.title ?? tracked.title }, session.outcome === "failed" ? failureKey : undefined)
        if (!running[session.id] && !voices.has(session.id) && session.outcome === "failed" && !this.store.sent(`${failureKey}:0`)) {
          const originalID = this.store.get<string>(`last-input:${session.id}`)
          const keyboard = originalID ? [[this.button("Retry", { kind: "retry", sessionID: session.id, value: originalID })]] : undefined
          await this.telegram.finish(session.id, `**${session.title ?? "OpenCode"}** failed. Use /retry to retry the failed request.`, failureKey, keyboard)
        }
        if (this.store.get("active") === session.id && running[session.id] && !permissions.length && !forms.length) void this.telegram.typing()
        if (running[session.id] || voices.has(session.id)) {
          if (this.settings.progress && (!completed || voices.has(session.id))) {
            const label = permissions.length && this.config.autoApprove === false ? "Waiting for permission." : forms.length ? "Waiting for your answer." : this.activity.get(session.id) ?? "Working."
            const prefix = this.store.get("active") === session.id ? "" : `${session.title ?? "Scheduled task"}: `
            await this.telegram.status(session.id, prefix + label)
          }
        } else {
          this.activity.delete(session.id)
          if (this.store.get(`progress:${session.id}`)) await this.telegram.finish(session.id, session.outcome === "interrupted" ? "Stopped." : "Done.", `idle:${session.id}:${session.time.idle ?? session.time.updated}`)
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
        this.store.track({ ...tracked, missing: true })
        if (this.store.get("active") === tracked.id) this.store.delete("active")
      }
    }
  }

  async runScheduled(jobs: Schedules) {
    const active = await this.client.session.active()
    for (const run of jobs.claim()) {
      if (!jobs.current(run)) continue
      if (run.job.last?.sessionID && active[run.job.last.sessionID]) { jobs.skipOverlap(run); continue }
      try {
        let session: SessionInfo
        try { session = await this.client.session.get({ sessionID: run.sessionID }) }
        catch (error) {
          if (!isNotFound(error)) throw error
          session = await this.client.session.create(jobSession(run))
        }
        this.track(session)
        if (!jobs.current(run) || !this.settings.schedules.enabled) continue
        const messageID = `msg_schedule_${run.id}`
        this.store.set(`last-input:${session.id}`, messageID)
        await this.client.session.prompt({ sessionID: session.id, id: messageID, text: run.job.prompt, metadata: { transport: "telegram", scheduleID: run.job.id, scheduledAt: run.due } })
        jobs.complete(run)
        this.activity.set(session.id, "Thinking.")
        this.dirty = true
      } catch (error) {
        if (/Transport|fetch|connect|timeout/i.test(`${(error as Error).name} ${(error as Error).message}`)) throw error
        const text = errorText(error, [this.config.token])
        await this.telegram.send(`Scheduled task ${run.job.name} could not start: ${text}`, undefined, `schedule-error:${run.id}`)
        jobs.complete(run, text)
      }
    }
  }

  async run(signal: AbortSignal, reconnect: () => Promise<Client> = connect, onReady?: () => Promise<void>) {
    const shutdown = new AbortController()
    signal = AbortSignal.any([signal, shutdown.signal])
    await this.initialize()
    const jobs = new Schedules(join(this.home, "schedules.sqlite"))
    jobs.skipMissed()
    const log = (error: unknown) => console.error(errorText(error, [this.config.token]))
    const pause = async (ms: number) => { await sleep(ms, undefined, { signal }).catch(() => {}) }
    const events = async () => {
      while (!signal.aborted) {
        try {
          for await (const event of this.client.event.subscribe({ signal })) this.onEvent(event)
        } catch (error) { if (!signal.aborted) log(error) }
        if (signal.aborted) break
        await pause(2000)
        try { this.client = await reconnect(); this.dirty = true } catch (error) { log(error) }
      }
    }
    const reconcile = async () => {
      let last = 0
      while (!signal.aborted) {
        if (this.dirty || Date.now() - last >= 5000) {
          this.dirty = false
          // Outbound catch-up must not block incoming steering or /stop.
          try { await this.reconcile() } catch (error) { log(error) }
          last = Date.now()
        }
        await pause(1500)
      }
    }
    const poll = async () => {
      let ready = false
      while (!signal.aborted) {
        try {
          const updates = await this.api.getUpdates({ offset: this.store.get<number>("offset") ?? 0, timeout: 25, allowed_updates: ["message", "callback_query"] }, signal as Parameters<Api["getUpdates"]>[1])
          if (!ready) { await onReady?.(); ready = true }
          for (const update of updates) {
            if (signal.aborted) break
            try { await this.handle(update) }
            catch (error) {
              log(error)
              // Transport failures remain unacknowledged; retry admission with the same message ID.
              if (error instanceof Error && !(error instanceof GrammyError) && /Transport|fetch|connect|timeout/i.test(`${error.name} ${error.message}`)) throw error
              if (authorized(update, this.config.ownerID)) await this.telegram.send(`Cannot complete that request: ${errorText(error, [this.config.token])}`, undefined, `update-error:${update.update_id}`)
            }
            this.store.set("offset", update.update_id + 1)
          }
        } catch (error) {
          if (!signal.aborted) log(error)
          if (error instanceof GrammyError && [401, 409].includes(error.error_code)) throw error
          await pause(2000)
        }
      }
    }
    const schedule = async () => {
      let enabled = this.settings.schedules.enabled
      while (!signal.aborted) {
        try {
          this.settings = await loadSettings(this.home)
          if (this.settings.schedules.enabled) {
            if (!enabled) jobs.skipMissed()
            await this.runScheduled(jobs)
          }
          enabled = this.settings.schedules.enabled
        } catch (error) { if (!signal.aborted) log(error) }
        await pause(2000)
      }
    }
    const voice = async () => {
      while (!signal.aborted) {
        try { await this.processVoice(signal) } catch (error) { if (!signal.aborted) log(error) }
        await pause(1500)
      }
    }
    const workers = [events(), reconcile(), poll(), schedule(), voice()]
    try { await Promise.all(workers) }
    finally { shutdown.abort(); await Promise.allSettled(workers); jobs.close() }
  }
}
