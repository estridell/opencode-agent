import { Api, GrammyError } from "grammy"
import type { Update } from "grammy/types"
import type { ModelRef, OpenCodeEvent, SessionInfo, SessionMessageAssistant } from "@opencode/client"
import { setTimeout as sleep } from "node:timers/promises"
import type { Config } from "./config"
import { errorText } from "./config"
import { connect, isNotFound, type Client } from "./opencode"
import { Store, type Action, type TrackedSession } from "./store"
import { Telegram } from "./telegram"
import { Forms } from "./forms"
import { Pickers, type Choice } from "./pickers"
import { startUpdate } from "./update"
import { Images } from "./images"

type Defaults = { model?: ModelRef; agent?: string }
const modelLabel = (model: ModelRef) => `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ""}`

export const commands = [
  { command: "new", description: "Start a fresh session" },
  { command: "sessions", description: "Resume a Telegram session" },
  { command: "stop", description: "Interrupt the active session" },
  { command: "status", description: "Show the current session" },
  { command: "model", description: "Choose a model (optional search text)" },
  { command: "agent", description: "Choose an agent" },
  { command: "update", description: "Update the application and OpenCode" },
  { command: "help", description: "Show commands and usage" },
]
const help = `**OpenCode Agent**\nSend text or an image. Add a caption to ask about the image. New messages give instructions to the task in progress.\n\n/new [title] - create a session\n/sessions - select a previous bot session\n/stop - stop work in the selected session\n/status - show the session, model, and directory\n/model [search] - select a model and variant\n/agent - select an agent\n/update - update the application and OpenCode\n/help - show this message\n\nImages: PNG, JPEG, GIF, or WebP, up to 20 MiB each. Use a model with image input.\nTo answer a question, reply with text or use its buttons.\n\nThis is an unofficial community project. It is not affiliated with the OpenCode team.`

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
  private mutex: Promise<unknown> = Promise.resolve()
  private dirty = true
  private known = new Set<string>()
  constructor(readonly config: Config, readonly store: Store, public client: Client, readonly api = new Api(config.token), spacing = 1050) {
    this.telegram = new Telegram(api, config.ownerID, store, spacing)
    this.forms = new Forms(() => this.client, store, this.telegram)
    this.pickers = new Pickers(store, this.telegram)
    this.images = new Images(api, config.token)
    for (const s of store.sessions()) this.known.add(s.id)
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(work)
    this.mutex = next.catch(() => {})
    return next
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
      const interaction = action?.kind === "permission" || action?.kind.startsWith("form-")
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
    const hasImage = !!message.photo?.length || !!message.document
    if (!message.text && !hasImage) {
      await this.telegram.send("Send text or a PNG, JPEG, GIF, or WebP image.", undefined, `update:${update.update_id}`)
      return
    }
    const text = message.text ?? message.caption ?? "Analyze the attached image."
    const command = message.text && /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(message.text)
    if (command) {
      const name = command[1]!.toLowerCase()
      const arg = command[2]?.trim() ?? ""
      if (name === "update") {
        const key = `update-job:${update.update_id}`
        if (this.store.get(key)) return
        const id = await this.telegram.send("Starting update.", undefined, `update:${update.update_id}`)
        try { this.store.set(key, await this.requestUpdate(id)) }
        catch (error) { await this.telegram.edit(id, errorText(error, [this.config.token])) }
        return
      }
      if (name === "start" || name === "help") { await this.telegram.send(help, undefined, `update:${update.update_id}`); return }
      if (name === "new") {
        await this.newSession(update.update_id, arg)
        await this.telegram.send("New session.", undefined, `update:${update.update_id}`)
        return
      }
      const sessionID = await this.active(update.update_id)
      if (name === "sessions") { await this.sessionMenu(0); return }
      if (name === "model") { await this.modelMenu(sessionID, arg, 0); return }
      if (name === "agent") { await this.agentMenu(sessionID); return }
      if (name === "stop") {
        await this.client.session.interrupt({ sessionID, resume: false })
        await this.telegram.send("Interrupted the active session.", undefined, `update:${update.update_id}`)
        this.dirty = true
        return
      }
      if (name === "status") {
        const session = await this.client.session.get({ sessionID })
        const active = await this.client.session.active()
        const model = session.model ?? (await this.client.model.default({ location: session.location })).data
        await this.telegram.send(`${active[sessionID] ? "Working" : "Idle"}\nModel: ${model ? modelLabel(model) : "Unavailable"}\nAgent: ${session.agent ?? "OpenCode default"}\nDirectory: ${session.location.directory}`, undefined, `update:${update.update_id}`)
        return
      }
      await this.telegram.send("Unknown command. Use /help.", undefined, `update:${update.update_id}`)
      return
    }
    const reply = message.reply_to_message && this.store.get<Action>(`form-reply:${message.reply_to_message.message_id}`)
    if (reply && hasImage) {
      await this.telegram.send("Reply with text to answer this question. Send the image as a separate message.", undefined, `update:${update.update_id}`)
      return
    }
    if (reply) { await this.forms.act({ ...reply, kind: "form-value" }, text); this.dirty = true; return }
    // Remember routing before admission, so a redelivered Telegram update cannot target a newly selected session.
    const route = `input:${update.update_id}`
    const sessionID = this.store.get<string>(route) ?? await this.active(update.update_id)
    this.store.set(route, sessionID)
    const files = hasImage ? [await this.images.attachment(message)] : undefined
    await this.client.session.prompt({
      sessionID,
      id: `msg_tg_${this.store.get<string>("binding")!.replaceAll(":", "_")}_${message.message_id}`,
      text, ...(files ? { files } : {}), delivery: "steer", metadata: { transport: "telegram", updateID: update.update_id },
    })
    void this.telegram.typing()
    this.dirty = true
  }

  private button(label: string, action: Action) { return { text: label.slice(0, 60), callback_data: this.store.button(action) } }

  private choice(text: string, action: Action): Choice { return { text, action } }

  async sessionMenu(page: number, pickerID?: string) {
    const sessions = this.store.sessions().filter(s => !s.parentID && !s.missing)
    const pages = Math.max(1, Math.ceil(sessions.length / 8))
    page = Math.max(0, Math.min(page, pages - 1))
    const rows: Choice[][] = sessions.slice(page * 8, page * 8 + 8).map(s => [this.choice(`${this.store.get("active") === s.id ? "✓ " : ""}${s.title}`, { kind: "session", sessionID: s.id })])
    const active = this.store.get<string>("active")!
    const nav = []
    if (page) nav.push(this.choice("Previous", { kind: "sessions", sessionID: active, page: page - 1 }))
    if (page + 1 < pages) nav.push(this.choice("Next", { kind: "sessions", sessionID: active, page: page + 1 }))
    if (nav.length) rows.push(nav)
    rows.push([this.choice("Cancel", { kind: "cancel", sessionID: active })])
    await this.pickers.show(`Sessions · ${page + 1}/${pages}`, rows, pickerID)
  }

  async modelMenu(sessionID: string, search: string, page: number, pickerID?: string) {
    const session = await this.client.session.get({ sessionID })
    const models = (await this.client.model.list({ location: session.location })).data.filter(m => m.enabled && `${m.name} ${m.providerID}/${m.id}`.toLowerCase().includes(search.toLowerCase()))
    const pages = Math.max(1, Math.ceil(models.length / 8))
    page = Math.max(0, Math.min(page, pages - 1))
    const rows: Choice[][] = models.slice(page * 8, page * 8 + 8).map(m => [this.choice(`${m.providerID}/${m.id}`, { kind: "model", sessionID, value: JSON.stringify({ providerID: m.providerID, id: m.id }), search, page })])
    const nav = []
    if (page) nav.push(this.choice("Previous", { kind: "models", sessionID, search, page: page - 1 }))
    if (page + 1 < pages) nav.push(this.choice("Next", { kind: "models", sessionID, search, page: page + 1 }))
    if (nav.length) rows.push(nav)
    rows.push([this.choice("Cancel", { kind: "cancel", sessionID })])
    await this.pickers.show(models.length ? `Models · ${page + 1}/${pages}` : "No models found. Use /model <search> to try again.", rows, pickerID)
  }

  async agentMenu(sessionID: string, page = 0, pickerID?: string) {
    const session = await this.client.session.get({ sessionID })
    const agents = (await this.client.agent.list({ location: session.location })).data.filter(a => !a.hidden && a.mode !== "subagent")
    const pages = Math.max(1, Math.ceil(agents.length / 8))
    page = Math.max(0, Math.min(page, pages - 1))
    const rows: Choice[][] = agents.slice(page * 8, page * 8 + 8).map(a => [this.choice(a.name, { kind: "agent", sessionID, value: a.id, page })])
    const nav = []
    if (page) nav.push(this.choice("Previous", { kind: "agents", sessionID, page: page - 1 }))
    if (page + 1 < pages) nav.push(this.choice("Next", { kind: "agents", sessionID, page: page + 1 }))
    if (nav.length) rows.push(nav)
    rows.push([this.choice("Cancel", { kind: "cancel", sessionID })])
    await this.pickers.show(`Agents · ${page + 1}/${pages}`, rows, pickerID)
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
    this.dirty = true
  }

  private async messages(session: TrackedSession) {
    const checkpoint = this.store.get<string>(`checkpoint:${session.id}`)
    const pending: SessionMessageAssistant[] = []
    let cursor: string | undefined
    let found = false
    do {
      const page = await this.client.message.list({ sessionID: session.id, type: "assistant", limit: 100, ...(cursor ? { cursor } : { order: "desc" as const }) })
      for (const m of page.data) {
        if (m.id === checkpoint) { found = true; break }
        if (m.type === "assistant") pending.push(m)
      }
      cursor = page.cursor.next ?? undefined
    } while (cursor && !found)
    for (const m of pending.reverse()) {
      if (!m.time.completed) break
      const text = m.content.filter(c => c.type === "text").map(c => c.text).join("\n\n")
      if (text.trim()) {
        const prefix = this.store.get("active") === session.id ? "" : `**${session.title}**\n\n`
        await this.telegram.send(prefix + text, undefined, `message:${session.id}:${m.id}`, m.finish === "tool-calls")
      }
      if (m.error) await this.telegram.send(`OpenCode error: ${errorText(m.error, [this.config.token])}`, undefined, `error:${session.id}:${m.id}`)
      this.store.set(`checkpoint:${session.id}`, m.id)
    }
  }

  async reconcile() {
    const running = await this.client.session.active()
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
        const [permissions, forms] = await Promise.all([
          this.client.permission.list({ sessionID: session.id }),
          this.client.session.form.list({ sessionID: session.id }),
        ])
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
        await this.forms.reconcile(session.id, forms)
        if (tracked.parentID) continue
        await this.messages({ ...tracked, title: session.title ?? tracked.title })
        if (!running[session.id] && session.outcome === "failed") {
          await this.telegram.send(`**${session.title ?? "OpenCode"}** failed. Check the error above, or open this session with opencode-agent to inspect it.`, undefined, `failed:${session.id}:${session.time.idle ?? session.time.updated}`)
        }
        if (this.store.get("active") === session.id && running[session.id] && !permissions.length && !forms.length) void this.telegram.typing()
      } catch (error) {
        if (!isNotFound(error)) throw error
        this.store.track({ ...tracked, missing: true })
        if (this.store.get("active") === tracked.id) this.store.delete("active")
      }
    }
  }

  async run(signal: AbortSignal, reconnect: () => Promise<Client> = connect, onReady?: () => Promise<void>) {
    const shutdown = new AbortController()
    signal = AbortSignal.any([signal, shutdown.signal])
    await this.initialize()
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
            await this.exclusive(async () => {
              try { await this.handle(update) }
              catch (error) {
                log(error)
                // Transport failures remain unacknowledged; retry admission with the same message ID.
                if (error instanceof Error && !(error instanceof GrammyError) && /Transport|fetch|connect|timeout/i.test(`${error.name} ${error.message}`)) throw error
                if (authorized(update, this.config.ownerID)) await this.telegram.send(`Cannot complete that request: ${errorText(error, [this.config.token])}`, undefined, `update-error:${update.update_id}`)
              }
              this.store.set("offset", update.update_id + 1)
            })
          }
        } catch (error) {
          if (!signal.aborted) log(error)
          if (error instanceof GrammyError && [401, 409].includes(error.error_code)) throw error
          await pause(2000)
        }
      }
    }
    const workers = [events(), reconcile(), poll()]
    try { await Promise.all(workers) }
    finally { shutdown.abort(); await Promise.allSettled(workers) }
  }
}
