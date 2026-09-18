import { afterEach, describe, expect, test } from "bun:test"
import { Api } from "grammy"
import type { Update } from "grammy/types"
import { OpenCode, type FormInfo, type PermissionRequest, type SessionInfo, type SessionMessageAssistant } from "@opencode/client"
import { Store } from "../src/store"
import { Gateway, authorized } from "../src/gateway"
import { formatText } from "../src/format"
import { runtimeEnv, registrationFile } from "../src/runtime"
import { parseAnswer, visible } from "../src/forms"
import { systemdQuote } from "../src/service"
import { parseConfig } from "../src/config"
import { imageLimit, imageType } from "../src/images"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNwONBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAC3PAFuD+GVmAAAAAElFTkSuQmCC", "base64")

function photo(id: number, caption?: string, from = 42): Update {
  const update = message(id, "", from)
  delete update.message!.text
  update.message!.caption = caption
  update.message!.photo = [
    { file_id: "small", file_unique_id: "s", width: 32, height: 32 },
    { file_id: "large", file_unique_id: "l", width: 1024, height: 768 },
    { file_id: "medium", file_unique_id: "m", width: 64, height: 64 },
  ]
  return update
}

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function message(id: number, text: string, from = 42): Update {
  return { update_id: id, message: { message_id: id, date: 0, from: { id: from, is_bot: false, first_name: "Owner" }, chat: { id: from, type: "private", first_name: "Owner" }, text } }
}

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.set("binding", "999:42")
  const sessions = new Map<string, SessionInfo>()
  const messages = new Map<string, SessionMessageAssistant[]>()
  const forms = new Map<string, FormInfo[]>()
  const permissions = new Map<string, PermissionRequest[]>()
  const calls: { path: string; body: Record<string, unknown>; query: URLSearchParams }[] = []
  const telegram: { method: string; payload: Record<string, unknown> }[] = []
  const admissions = new Set<string>()
  const running: Record<string, { type: "running" }> = {}
  const models = Array.from({ length: 18 }, (_, i) => ({
    id: `model-${i}`, name: `Model ${i}`, providerID: "provider", enabled: true,
    variants: i === 17 ? [] : [{ id: "low" }, { id: "high" }],
  }))
  const agents = [{ id: "build", name: "Build", mode: "primary", hidden: false }, { id: "plan", name: "Plan", mode: "primary", hidden: false }]
  let failAdmission = false
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, body, query: url.searchParams })
    const sessionID = path.split("/")[3]!
    let data: unknown
    let raw = false
    if (path === "/api/session" && init?.method === "POST") {
      data = { id: body.id, title: body.title ?? "Test session", location: body.location, agent: body.agent, model: body.model, time: { created: 1, updated: 1 }, projectID: "global", cost: 0, tokens: {} }
      sessions.set(body.id, data as SessionInfo)
    } else if (path === "/api/session/active") data = running
    else if (path === "/api/model" || path === "/api/model/default" || path === "/api/agent") {
      data = { location: { directory: "/agent/workspace" }, data: path === "/api/model" ? models : path === "/api/agent" ? agents : models[0] }
      raw = true
    } else if (/\/api\/session\/[^/]+\/model$/.test(path)) {
      sessions.get(sessionID)!.model = body.model
      return new Response(null, { status: 204 })
    } else if (/\/api\/session\/[^/]+\/agent$/.test(path)) {
      sessions.get(sessionID)!.agent = body.agent
      return new Response(null, { status: 204 })
    }
    else if (path === "/api/session") { data = { data: [...sessions.values()].filter(s => s.parentID === url.searchParams.get("parentID")), cursor: {} }; raw = true }
    else if (/\/prompt$/.test(path)) {
      admissions.add(body.id)
      if (failAdmission) { failAdmission = false; throw new Error("Simulated connection reset after admission") }
      data = { id: body.id }
    } else if (/\/permission\/[^/]+\/reply$/.test(path)) {
      expect(["once", "always", "reject"]).toContain(body.decision)
      permissions.set(sessionID, [])
      return new Response(null, { status: 204 })
    } else if (/\/permission$/.test(path)) data = permissions.get(sessionID) ?? []
    else if (/\/form\/[^/]+\/reply$/.test(path)) {
      forms.set(sessionID, [])
      return new Response(null, { status: 204 })
    } else if (/\/form\/[^/]+$/.test(path)) {
      const form = forms.get(sessionID)?.find(f => f.id === path.split("/").at(-1))
      if (!form) return Response.json({ _tag: "FormNotFoundError", message: "Missing", id: "frm_test" }, { status: 404 })
      data = { ...form, state: { status: "pending" } }
    } else if (/\/form$/.test(path)) data = forms.get(sessionID) ?? []
    else if (/\/message$/.test(path)) {
      const all = [...(messages.get(sessionID) ?? [])].reverse()
      const cursor = Number(url.searchParams.get("cursor") ?? 0)
      // Force pagination even on short histories to exercise cursor traversal.
      data = { data: all.slice(cursor, cursor + 2), cursor: { next: cursor + 2 < all.length ? String(cursor + 2) : null } }
      raw = true
    } else if (/\/api\/session\/[^/]+$/.test(path)) {
      data = sessions.get(sessionID)
      if (!data) return Response.json({ _tag: "SessionNotFoundError", message: "Missing", sessionID }, { status: 404 })
    } else throw new Error(`Unexpected fake request: ${init?.method} ${path}`)
    return Response.json(raw ? data : { data })
  }, { preconnect: fetch.preconnect })
  const client = OpenCode.make({ baseUrl: "http://fixture.invalid", fetch: fakeFetch })
  const api = new Api("999:fake")
  api.config.use(async (_prev, method, payload) => {
    telegram.push({ method, payload: payload as Record<string, unknown> })
    if (method === "setMyCommands" && (payload as { scope?: { type: string } }).scope?.type === "chat") {
      return { ok: false, error_code: 400, description: "Bad Request: chat not found" }
    }
    const result = method === "getMe" ? { id: 999, is_bot: true, first_name: "Agent", username: "fixturebot" }
      : method === "getFile" ? { file_id: "image", file_unique_id: "image", file_path: "photos/image.png" }
      : method === "getWebhookInfo" ? { url: "", pending_update_count: 0 }
      : method === "sendMessage" ? { message_id: telegram.length, date: 0, chat: { id: 42, type: "private" }, text: "" } : true
    return { ok: true, result } as never
  })
  const gateway = new Gateway({ token: "999:fake", ownerID: 42, directory: "/agent/workspace" }, store, client, api, 0)
  gateway.images.fetchFile = Object.assign(async () => new Response(png), { preconnect: fetch.preconnect })
  return { gateway, store, calls, telegram, sessions, messages, forms, permissions, admissions, running, models, failNextAdmission: () => { failAdmission = true } }
}

test("photos use the largest size and submit caption and bytes without Telegram credentials", async () => {
  const f = fixture()
  await f.gateway.handle(photo(1, "What is in this picture?"))
  expect(f.telegram.find(t => t.method === "getFile")!.payload.file_id).toBe("large")
  const prompt = f.calls.find(c => c.path.endsWith("/prompt"))!
  expect(prompt.body.text).toBe("What is in this picture?")
  expect(prompt.body.files).toEqual([{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "photo-1.png" }])
  expect(prompt.body.delivery).toBe("steer")
  expect(JSON.stringify(prompt.body)).not.toContain("999:fake")
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(0)
})

test("image-only requests have prompt text; captions are not bot commands", async () => {
  const f = fixture()
  await f.gateway.handle(photo(1))
  const id = f.store.get<string>("active")
  await f.gateway.handle(photo(2, "/new"))
  expect(f.store.get<string>("active")).toBe(id)
  const prompts = f.calls.filter(c => c.path.endsWith("/prompt"))
  expect(prompts.map(p => p.body.text)).toEqual(["Analyze the attached image.", "/new"])
})

test.each([["text", message], ["image", photo]] as const)("%s admission retries retain their session and message IDs after an ambiguous failure", async (_kind, input) => {
  const f = fixture()
  f.failNextAdmission()
  const update = input(1, "Work on this request.")
  await expect(f.gateway.handle(update)).rejects.toThrow("Transport")
  const original = f.store.get<string>("active")
  await f.gateway.newSession(2)
  await f.gateway.handle(update)
  const prompts = f.calls.filter(c => c.path.endsWith("/prompt"))
  expect(prompts).toHaveLength(2)
  expect(prompts[0]!.path).toContain(original!)
  expect(prompts[1]!.path).toBe(prompts[0]!.path)
  expect(prompts[1]!.body).toEqual(prompts[0]!.body)
  expect(prompts[1]!.body.delivery).toBe("steer")
  expect(f.admissions.size).toBe(1)
})

test("image documents use byte detection and a display filename", async () => {
  const f = fixture()
  const update = message(1, "")
  delete update.message!.text
  update.message!.document = { file_id: "doc", file_unique_id: "doc", file_name: "../../screenshot.png", mime_type: "application/octet-stream" }
  await f.gateway.handle(update)
  expect(f.calls.find(c => c.path.endsWith("/prompt"))!.body.files).toEqual([{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "screenshot.png" }])
  f.gateway.images.fetchFile = Object.assign(async () => new Response("%PDF-1.0"), { preconnect: fetch.preconnect })
  await expect(f.gateway.handle(update)).rejects.toThrow("Unsupported image format")
  expect(f.calls.filter(c => c.path.endsWith("/prompt"))).toHaveLength(1)
})

test("oversized images are rejected before download and while reading an undeclared stream", async () => {
  const f = fixture()
  const update = photo(1)
  update.message!.photo![1]!.file_size = imageLimit + 1
  await expect(f.gateway.handle(update)).rejects.toThrow("too large")
  expect(f.telegram.filter(t => t.method === "getFile")).toHaveLength(0)
  delete update.message!.photo![1]!.file_size
  let cancelled = false
  f.gateway.images.fetchFile = Object.assign(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(imageLimit + 1)) },
    cancel() { cancelled = true },
  })), { preconnect: fetch.preconnect })
  await expect(f.gateway.handle(update)).rejects.toThrow("too large")
  expect(cancelled).toBe(true)
  expect(f.calls.filter(c => c.path.endsWith("/prompt"))).toHaveLength(0)
})

test("image download failures can retry and never expose the token", async () => {
  const f = fixture()
  f.gateway.images.fetchFile = Object.assign(async () => { throw new Error("https://api.telegram.org/file/bot999:fake/image") }, { preconnect: fetch.preconnect })
  await expect(f.gateway.handle(photo(1))).rejects.toThrow("Image download connection failed")
  expect(f.calls.filter(c => c.path.endsWith("/prompt"))).toHaveLength(0)
  f.gateway.images.fetchFile = Object.assign(async () => new Response(png), { preconnect: fetch.preconnect })
  await f.gateway.handle(photo(1))
  expect(f.calls.filter(c => c.path.endsWith("/prompt"))).toHaveLength(1)
})

test("unauthorized images are not downloaded; form image replies do not submit captions as answers", async () => {
  const f = fixture()
  await f.gateway.handle(photo(1, undefined, 77))
  expect(f.telegram).toHaveLength(0)
  expect(f.calls).toHaveLength(0)
  f.store.set("form-reply:50", { kind: "form-value", sessionID: "ses", id: "frm", field: "answer" })
  const update = photo(2, "a caption")
  update.message!.reply_to_message = { ...message(50, "Question").message!, reply_to_message: undefined }
  await f.gateway.handle(update)
  expect(f.telegram.filter(t => t.method === "getFile")).toHaveLength(0)
  expect(f.calls).toHaveLength(0)
  expect(picker(f).text).toContain("Reply with text")
})

test("supported image signatures identify PNG, JPEG, GIF, and WebP", () => {
  expect(imageType(png)).toBe("image/png")
  expect(imageType(Buffer.from([255, 216, 255, 224]))).toBe("image/jpeg")
  expect(imageType(Buffer.from("GIF89a"))).toBe("image/gif")
  expect(imageType(Buffer.from("RIFF1234WEBP"))).toBe("image/webp")
  expect(imageType(Buffer.from("<svg></svg>"))).toBeUndefined()
})

function picker(f: ReturnType<typeof fixture>) {
  const index = f.telegram.findLastIndex(t => t.method === "sendMessage" || t.method === "editMessageText")
  const entry = f.telegram[index]!
  const keyboard = (entry.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []
  return { text: String(entry.payload.text), messageID: entry.method === "sendMessage" ? index + 1 : Number(entry.payload.message_id), buttons: keyboard.flat() }
}

test("only the owner can start an update; replay keeps one progress message and one worker", async () => {
  const f = fixture()
  const requests: number[] = []
  f.gateway.requestUpdate = async id => { requests.push(id!); return "job" }
  await f.gateway.handle(message(1, "/update", 77))
  expect(requests).toHaveLength(0)
  await f.gateway.handle(message(2, "/update"))
  await f.gateway.handle(message(2, "/update"))
  expect(requests).toEqual([1])
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
  expect(f.calls).toHaveLength(0)
})

test("update launch failures replace the progress message", async () => {
  const f = fixture()
  f.gateway.requestUpdate = async () => { throw new Error("An update is already running.") }
  await f.gateway.handle(message(1, "/update"))
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
  expect(picker(f).text).toBe("An update is already running.")
  expect(f.calls).toHaveLength(0)
})

async function press(f: ReturnType<typeof fixture>, label: string, gateway = f.gateway) {
  const view = picker(f)
  const button = view.buttons.find(b => b.text === label)
  if (!button) throw new Error(`Missing button ${label} in ${JSON.stringify(view)}`)
  const update: Update = {
    update_id: 1000 + f.telegram.length,
    callback_query: {
      id: `cb_${f.telegram.length}`, chat_instance: "chat", from: { id: 42, first_name: "Owner", is_bot: false },
      data: button.callback_data,
      message: { message_id: view.messageID, date: 1, chat: { id: 42, type: "private", first_name: "Owner" } },
    },
  }
  await gateway.handle(update)
  return update
}

test("model pages, variants, default choice, and final result use one message", async () => {
  const f = fixture()
  await f.gateway.handle(message(1, "/model"))
  const id = picker(f).messageID
  expect(picker(f).text).toBe("Models · 1/3")
  const oldPage = await press(f, "Next")
  expect(picker(f).text).toBe("Models · 2/3")
  await f.gateway.handle(oldPage)
  expect(picker(f).text).toBe("Models · 2/3")
  expect(f.telegram.at(-1)!.payload.text).toContain("expired")
  await press(f, "provider/model-8")
  expect(picker(f).text).toContain("Select a variant")
  await press(f, "Back")
  expect(picker(f).text).toBe("Models · 2/3")
  await press(f, "provider/model-8")
  await press(f, "high")
  expect(picker(f).text).toContain("Set as default for new sessions?")
  expect(f.calls.filter(c => c.path.endsWith("/model") && c.body.model)).toHaveLength(0)
  await press(f, "Yes")
  expect(picker(f)).toMatchObject({ messageID: id, text: "Model: provider/model-8 (high)\nDefault saved.", buttons: [] })
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
  expect(f.telegram.filter(t => t.method === "editMessageText").every(t => t.payload.message_id === id)).toBe(true)
  const model = { providerID: "provider", id: "model-8", variant: "high" }
  expect(f.sessions.get(f.store.get<string>("active")!)!.model).toEqual(model)
  // A new gateway process must retain the same default, including the variant.
  const restored = new Gateway(f.gateway.config, f.store, f.gateway.client, f.gateway.api, 0)
  const next = await restored.newSession(2)
  expect(f.sessions.get(next)!.model).toEqual(model)
})

test("No changes only the current model; completed buttons cannot change it again", async () => {
  const f = fixture()
  const initial = { model: { providerID: "provider", id: "model-2", variant: "low" } }
  f.store.set("defaults", initial)
  await f.gateway.handle(message(1, "/model model-17"))
  await press(f, "provider/model-17")
  expect(picker(f).text).toContain("Set as default")
  await press(f, "Back")
  expect(picker(f).text).toBe("Models · 1/1")
  await press(f, "provider/model-17")
  const complete = await press(f, "No")
  expect(picker(f).text).toBe("Model: provider/model-17")
  expect(f.store.get<unknown>("defaults")).toEqual(initial)
  const switches = f.calls.filter(c => c.path.endsWith("/model") && c.body.model).length
  await f.gateway.handle(complete)
  expect(f.calls.filter(c => c.path.endsWith("/model") && c.body.model)).toHaveLength(switches)
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
  const next = await f.gateway.newSession(2)
  expect(f.sessions.get(next)!.model).toEqual(initial.model)
})

test("cancelled and unavailable selections do not change the current model or default", async () => {
  const f = fixture()
  await f.gateway.handle(message(1, "/model"))
  await press(f, "provider/model-0")
  await press(f, "low")
  await press(f, "Cancel")
  expect(picker(f).text).toBe("Cancelled.")
  expect(picker(f).buttons).toHaveLength(0)
  expect(f.store.get("defaults")).toBeUndefined()
  expect(f.calls.filter(c => c.body.model)).toHaveLength(0)
  await f.gateway.handle(message(2, "/model"))
  await press(f, "provider/model-0")
  await press(f, "high")
  f.models[0]!.enabled = false
  await press(f, "Yes")
  expect(f.store.get("defaults")).toBeUndefined()
  expect(f.calls.filter(c => c.body.model)).toHaveLength(0)
  expect(f.telegram.at(-1)!.payload.show_alert).toBe(true)
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(2)
})

test("agent selection saves a default in the same message without removing the model default", async () => {
  const f = fixture()
  const model = { providerID: "provider", id: "model-2", variant: "low" }
  f.store.set("defaults", { model })
  await f.gateway.handle(message(1, "/agent"))
  await press(f, "Plan")
  await press(f, "Yes")
  expect(picker(f).text).toBe("Agent: plan\nDefault saved.")
  expect(picker(f).buttons).toHaveLength(0)
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
  expect(f.store.get<unknown>("defaults")).toEqual({ model, agent: "plan" })
  const next = await f.gateway.newSession(2)
  expect(f.sessions.get(next)!.agent).toBe("plan")
  expect(f.sessions.get(next)!.model).toEqual(model)
})

test("session pages collapse to the selected session in one message", async () => {
  const f = fixture()
  for (let i = 0; i < 10; i++) await f.gateway.newSession(i, `Task ${i}`)
  await f.gateway.handle(message(20, "/sessions"))
  const id = picker(f).messageID
  await press(f, "Next")
  expect(picker(f).text).toBe("Sessions · 2/2")
  await press(f, "Task 0")
  expect(picker(f)).toMatchObject({ messageID: id, text: "Session: Task 0", buttons: [] })
  expect(f.store.get<string>("active")).toBe("ses_tg_999_42_0")
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
})

test("busy and idle checks add no chat messages or status edits", async () => {
  const f = fixture()
  const id = await f.gateway.newSession(1)
  // Existing installations can contain an old status message record.
  f.store.set(`status:${id}`, { id: 123, text: "Working", busy: true })
  f.running[id] = { type: "running" }
  await f.gateway.reconcile()
  delete f.running[id]
  await f.gateway.reconcile()
  expect(f.telegram.filter(t => t.method === "sendMessage" || t.method === "editMessageText")).toHaveLength(0)
  expect(f.telegram.some(t => t.method === "sendChatAction" && t.payload.action === "typing")).toBe(true)
})

test("status resolves the upstream default model instead of hiding it behind a placeholder", async () => {
  const f = fixture()
  await f.gateway.handle(message(1, "/status"))
  expect(picker(f).text).toContain("Model: provider/model-0")
  expect(picker(f).text).not.toContain("ses_tg_")
})

describe("owner boundary", () => {
  test("rejects other users and group callbacks before any OpenCode request", async () => {
    const f = fixture()
    await f.gateway.handle(message(1, "run something", 7))
    const update: Update = { update_id: 2, callback_query: { id: "cb", chat_instance: "chat", from: { id: 42, first_name: "Owner", is_bot: false }, data: "a:forged", message: { message_id: 2, date: 1, chat: { id: -123, type: "group", title: "Group" } } } }
    expect(authorized(update, 42)).toBe(false)
    await f.gateway.handle(update)
    expect(f.calls).toHaveLength(0)
    expect(f.telegram).toHaveLength(0)
  })
})

test("gateway startup does not require an existing owner chat", async () => {
  const f = fixture()
  await f.gateway.initialize()
  expect(f.telegram.find(t => t.method === "setMyCommands")!.payload.scope).toEqual({ type: "all_private_chats" })
  await f.gateway.handle(message(1, "Do work", 7))
  expect(f.calls).toHaveLength(0)
})

test("replayed /new creates one session", async () => {
  const f = fixture()
  await f.gateway.handle(message(10, "/new Planning"))
  await f.gateway.handle(message(10, "/new Planning"))
  expect(f.sessions.size).toBe(1)
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(1)
})

test("reconciliation catches up paginated completed responses without replaying them", async () => {
  const f = fixture()
  const id = await f.gateway.newSession(1)
  const model = { providerID: "fake", id: "test" }
  const replies: SessionMessageAssistant[] = [1, 2, 3].map(i => ({ id: `msg_${i}`, type: "assistant", agent: "build", model, time: { created: i, completed: i }, content: [{ type: "text", text: `Answer ${i}` }], finish: "stop" }))
  replies.push({ id: "msg_streaming", type: "assistant", agent: "build", model, time: { created: 4 }, content: [{ type: "text", text: "unfinished" }] })
  f.messages.set(id, replies)
  await f.gateway.reconcile()
  await f.gateway.reconcile()
  const sent = f.telegram.filter(t => t.method === "sendMessage").map(t => t.payload.text)
  expect(sent).toEqual(["Answer 1", "Answer 2", "Answer 3"])
  replies[3]!.time.completed = 5
  await f.gateway.reconcile()
  expect(f.telegram.filter(t => t.method === "sendMessage").map(t => t.payload.text)).toEqual([...sent, "unfinished"])
})

test("permission decisions are upstream-native and stale buttons cannot grant access", async () => {
  const f = fixture()
  f.gateway.config.autoApprove = false
  const id = await f.gateway.newSession(1)
  f.permissions.set(id, [{ id: "per_1", sessionID: id, action: "shell", resources: ["git push"], save: ["git push *"] }])
  await f.gateway.reconcile()
  const send = f.telegram.find(t => String(t.payload.text).includes("Permission requested"))!
  const keyboard = send.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }
  const action = f.store.action(keyboard.inline_keyboard[0]![0]!.callback_data)!
  await f.gateway.callback(action)
  await f.gateway.callback(action)
  expect(f.calls.filter(c => c.path.endsWith("/permission/per_1/reply"))).toHaveLength(1)
  expect(f.calls.find(c => c.path.endsWith("/permission/per_1/reply"))!.body).toEqual({ decision: "once" })
})

test("existing configurations default to auto-approve and accept an explicit opt-out", () => {
  const config = { token: "999:fake", ownerID: 42, directory: "/agent/workspace" }
  expect(parseConfig(config).autoApprove).toBe(true)
  expect(parseConfig({ ...config, autoApprove: false }).autoApprove).toBe(false)
  expect(() => parseConfig({ ...config, autoApprove: "false" })).toThrow("autoApprove must be true or false")
})

test("auto-approve handles parent and child requests once without Telegram prompts", async () => {
  const f = fixture()
  const id = await f.gateway.newSession(1)
  const child = { ...f.sessions.get(id)!, id: "ses_child", parentID: id }
  f.sessions.set(child.id, child)
  for (const sessionID of [id, child.id]) {
    f.permissions.set(sessionID, [{ id: `per_${sessionID}`, sessionID, action: "shell", resources: ["git status"], save: ["git *"] }])
  }
  await f.gateway.reconcile()
  await f.gateway.reconcile()
  const replies = f.calls.filter(c => /\/permission\/.*\/reply$/.test(c.path))
  expect(replies).toHaveLength(2)
  expect(replies.map(c => c.body)).toEqual([{ decision: "once" }, { decision: "once" }])
  expect(f.telegram.filter(t => t.method === "sendMessage")).toHaveLength(0)
})

test("auto-approve resolves previously displayed requests after gateway reconstruction", async () => {
  const f = fixture()
  f.gateway.config.autoApprove = false
  const id = await f.gateway.newSession(1)
  f.permissions.set(id, [{ id: "per_old", sessionID: id, action: "shell", resources: ["git status"], save: ["git *"] }])
  await f.gateway.reconcile()
  const restored = new Gateway({ ...f.gateway.config, autoApprove: true }, f.store, f.gateway.client, f.gateway.api, 0)
  await restored.reconcile()
  await restored.reconcile()
  expect(f.calls.filter(c => c.path.endsWith("/permission/per_old/reply"))).toHaveLength(1)
  expect(picker(f).text).toBe("Permission resolved in OpenCode.")
  expect(picker(f).buttons).toHaveLength(0)
})

test("structured questions survive gateway reconstruction and submit a complete typed answer", async () => {
  const f = fixture()
  const id = await f.gateway.newSession(1)
  const form: FormInfo = { id: "frm_test", sessionID: id, title: "Plan", fields: [
    { key: "source", type: "string", hidden: true, default: "telegram" },
    { key: "mode", type: "string", required: true, options: [{ label: "Build", value: "build" }, { label: "Review", value: "review" }] },
    { key: "count", type: "integer", required: true, minimum: 1, when: [{ key: "mode", op: "eq", value: "build" }] },
  ] }
  f.forms.set(id, [form])
  await f.gateway.reconcile()
  await f.gateway.forms.act({ kind: "form-value", sessionID: id, id: form.id, field: "mode", value: "build" })
  const restored = new Gateway(f.gateway.config, f.store, f.gateway.client, f.gateway.api, 0)
  const answering = restored.forms.act({ kind: "form-value", sessionID: id, id: form.id, field: "count" }, "3")
  const reconciling = restored.forms.reconcile(id)
  await answering
  expect(await reconciling).toEqual([])
  expect(f.calls.filter(c => c.path.endsWith("/form"))).toHaveLength(2)
  expect(f.calls.find(c => c.path.endsWith("/form/frm_test/reply"))!.body).toEqual({ answer: { source: "telegram", mode: "build", count: 3 } })
})

test("question parsing respects closed choices, numeric bounds, and conditional visibility", () => {
  expect(() => parseAnswer({ key: "n", type: "integer", minimum: 1 }, "1.5")).toThrow()
  expect(() => parseAnswer({ key: "s", type: "string", options: [{ value: "a", label: "A" }] }, "b")).toThrow()
  expect(visible({ key: "x", type: "string", when: [{ key: "mode", op: "eq", value: "build" }] }, { mode: "review" })).toBe(false)
})

test("long formatted text preserves Unicode and entity offsets across Telegram chunks", () => {
  const content = "😃<> &".repeat(1500)
  const chunks = formatText("```txt\n" + content + "```\n**Done**")
  expect(chunks.map(c => c.text).join("")).toBe(content + "\nDone")
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(3900)
    expect(c.text.isWellFormed()).toBe(true)
    for (const entity of c.entities) {
      expect(entity.offset).toBeGreaterThanOrEqual(0)
      expect(entity.offset + entity.length).toBeLessThanOrEqual(c.text.length)
    }
  }
})

test("owned runtime cannot inherit host credentials or service overrides", () => {
  const env = runtimeEnv({ PATH: "/usr/bin", HOME: "/host", XDG_CONFIG_HOME: "/host/config", OPENAI_API_KEY: "host-secret", OPENCODE_SERVER_PASSWORD: "host-password", OPENCODE_CONFIG: "/host/config.json", OPENCODE_DB: "/host/db" })
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.OPENCODE_CONFIG).toBeUndefined()
  expect(env.OPENCODE_DB).toBeUndefined()
  expect(env.HOME).toContain(".opencode-agent/runtime/home")
  expect(env.XDG_CONFIG_HOME).toContain(".opencode-agent/runtime/config")
  expect(registrationFile()).toContain("runtime/state/opencode/service.json")
})

test("systemd paths escape specifiers and reject directive injection", () => {
  expect(systemdQuote('/home/A B/%x/"')).toBe('"/home/A B/%%x/\\""')
  expect(() => systemdQuote("/tmp/path\nExecStart=bad")).toThrow()
})
