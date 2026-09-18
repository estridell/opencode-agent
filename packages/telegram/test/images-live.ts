import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Api, InputFile } from "grammy"
import { loadConfig } from "../src/config"
import { connect } from "../src/opencode"
import { Gateway } from "../src/gateway"
import { Store } from "../src/store"

if (process.env.OPENCODE_AGENT_TEST_TELEGRAM !== "1") {
  throw new Error("Set OPENCODE_AGENT_TEST_TELEGRAM=1 to test image downloads with the configured bot.")
}
const config = await loadConfig()
const api = new Api(config.token)
const client = await connect()
const store = new Store(":memory:")
store.set("binding", `image_test_${crypto.randomUUID().replaceAll("-", "")}`)
const gateway = new Gateway(config, store, client, api, 0)
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNwONBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAC3PAFuD+GVmAAAAAElFTkSuQmCC", "base64")
const sent: number[] = []
const sessions: string[] = []
const prompt = client.session.prompt.bind(client.session)
let runModel = false
client.session.prompt = input => prompt({ ...input, resume: runModel })

try {
  for (const kind of ["document", "photo"] as const) {
    const id = Date.now()
    const sessionID = await gateway.newSession(id, `Image ${kind} test`)
    sessions.push(sessionID)
    runModel = kind === "photo" && process.env.OPENCODE_AGENT_TEST_MODEL === "1"
    const caption = "Name the main color in this image. Reply with one word. Do not use tools."
    const uploaded = kind === "photo"
      ? await api.sendPhoto(config.ownerID, new InputFile(bytes, "color.png"), { caption, disable_notification: true })
      : await api.sendDocument(config.ownerID, new InputFile(bytes, "color.png"), { caption, disable_notification: true })
    sent.push(uploaded.message_id)
    // Use the real Telegram file IDs through the same owner-only message handler.
    await gateway.handle({ update_id: id, message: {
      ...uploaded, chat: { id: config.ownerID, type: "private", first_name: "Owner" },
      from: { id: config.ownerID, is_bot: false, first_name: "Owner" },
    } })
    if (!runModel) {
      const inbox = await client.session.inbox.list({ sessionID })
      const item = inbox.find(i => i.type === "user")
      assert.ok(item && item.type === "user")
      assert.equal(item.payload.text, caption)
      assert.equal(item.payload.files?.length, 1)
      assert.match(item.payload.files![0]!.mime, /^image\/(png|jpeg)$/)
      await client.session.inbox.cancel({ sessionID, inboxID: item.id })
      console.log(`Telegram ${kind} download and OpenCode image admission passed.`)
      continue
    }
    let answer = ""
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const history = await client.message.list({ sessionID, type: "assistant", order: "desc", limit: 10 })
      const completed = history.data.find(m => m.type === "assistant" && m.time.completed)
      if (completed?.type === "assistant") {
        if (completed.error) throw new Error(JSON.stringify(completed.error))
        answer = completed.content.filter(c => c.type === "text").map(c => c.text).join("\n")
        if (answer) break
      }
      await sleep(1000)
    }
    assert.match(answer, /green/i)
    console.log(`Telegram photo reached the model. Image answer: ${answer.trim()}`)
  }
} finally {
  for (const sessionID of sessions) {
    await client.session.interrupt({ sessionID, resume: false }).catch(() => {})
    await client.session.remove({ sessionID })
  }
  for (const id of sent) await api.deleteMessage(config.ownerID, id)
  store.close()
}
