import assert from "node:assert/strict"
import { Api } from "grammy"
import type { InlineKeyboardMarkup } from "grammy/types"
import type { ModelRef } from "@opencode/client"
import { loadConfig } from "../src/config"
import { connect } from "../src/opencode"
import { Gateway } from "../src/gateway"
import { Store, type Action } from "../src/store"

// This test sends and edits one real Telegram message. It does not poll for updates
// or call a model. Gateway preferences exist only in this in-memory test store.
if (process.env.OPENCODE_AGENT_TEST_TELEGRAM !== "1") {
  throw new Error("Set OPENCODE_AGENT_TEST_TELEGRAM=1 to test with your configured Telegram bot.")
}
const config = await loadConfig()
const client = await connect()
const api = new Api(config.token)
const store = new Store(":memory:")
store.set("binding", `picker_test_${crypto.randomUUID().replaceAll("-", "")}`)
const gateway = new Gateway(config, store, client, api)
const sessions: string[] = []
const sent: number[] = []
let edits = 0
let text = ""
let keyboard: InlineKeyboardMarkup = { inline_keyboard: [] }
api.config.use(async (previous, method, payload, signal) => {
  const result = await previous(method, payload, signal)
  if (result.ok && (method === "sendMessage" || method === "editMessageText")) {
    const data = payload as { text: string; message_id?: number; reply_markup?: InlineKeyboardMarkup }
    text = data.text
    keyboard = data.reply_markup ?? { inline_keyboard: [] }
    if (method === "sendMessage") sent.push((result.result as { message_id: number }).message_id)
    else { assert.equal(data.message_id, sent[0]); edits++ }
  }
  return result
})

function find(predicate: (action: Action) => boolean): Action | undefined {
  for (const button of keyboard.inline_keyboard.flat()) {
    if (!("callback_data" in button)) continue
    const action = store.action(button.callback_data)
    if (action && predicate(action)) return action
  }
}

try {
  const sessionID = await gateway.newSession(1, "Telegram picker test")
  sessions.push(sessionID)
  await gateway.modelMenu(sessionID, "", 0)
  const next = find(a => a.kind === "models" && a.page === 1)
  if (next) {
    await gateway.callback(next)
    const back = find(a => a.kind === "models" && a.page === 0)
    assert.ok(back)
    await gateway.callback(back)
  }
  const selection = find(a => a.kind === "model")
  assert.ok(selection, "The provider must have at least one enabled model.")
  await gateway.callback(selection)
  const variant = find(a => a.kind === "variant" && JSON.parse(a.value!).variant === "high") ?? find(a => a.kind === "variant")
  if (variant) await gateway.callback(variant)
  assert.ok(text.includes("Set as default for new sessions?"))
  const save = find(a => a.kind === "model-apply" && a.field === "default")
  assert.ok(save)
  await gateway.callback(save)
  assert.equal(sent.length, 1)
  assert.ok(edits >= 2)
  assert.equal(keyboard.inline_keyboard.length, 0)
  assert.ok(text.includes("Default saved."))
  assert.equal(gateway.pickers.current(save), false)
  const expected = JSON.parse(save.value!) as ModelRef
  assert.deepEqual((await client.session.get({ sessionID })).model, expected)
  const restored = new Gateway(config, store, client, api)
  const nextSession = await restored.newSession(2, "Telegram default test")
  sessions.push(nextSession)
  assert.deepEqual((await client.session.get({ sessionID: nextSession })).model, expected)
  console.log(`Telegram picker passed: one message, ${edits} edits, no final buttons, and the same default in a new session.`)
} finally {
  try {
    for (const id of sent) await api.deleteMessage(config.ownerID, id)
  } finally {
    for (const sessionID of sessions) await client.session.remove({ sessionID })
    store.close()
  }
}
