import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Service } from "@opencode/client/service"
import { connect } from "../src/opencode"
import { agentHome } from "../src/config"
import { agentSkillAddition } from "../src/assistant"
import { installRuntime, registrationFile, upstreamBinary, workspace } from "../src/runtime"

// Explicit opt-in: this script starts a real upstream service, but never calls a model provider.
if (!process.env.OPENCODE_AGENT_HOME?.startsWith("/tmp/opencode/") || await Bun.file(`${agentHome()}/config.json`).exists()) {
  throw new Error("Set OPENCODE_AGENT_HOME to a disposable directory under /tmp/opencode, without Telegram config.")
}
if (!await Bun.file(upstreamBinary()).exists()) await installRuntime()
const client = await connect()
const events: string[] = []
const controller = new AbortController()
const watching = (async () => {
  for await (const event of client.event.subscribe({ signal: controller.signal })) events.push(event.type)
})()
const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Live smoke check timed out")
    await sleep(50)
  }
}
let sessionID: string | undefined
try {
  await waitFor(() => events.includes("server.connected"))
  const session = await client.session.create({
    id: `ses_tg_smoke_${Date.now()}`, title: "Integration smoke test", location: { directory: workspace() },
    permissions: [{ action: "smoke", resource: "*", effect: "ask" }],
  })
  sessionID = session.id
  const location = { directory: workspace() }
  const managedPlugins = ["opencode-agent.context", "opencode-agent.recall", "opencode-agent.schedules"]
  await waitFor(async () => {
    const plugins = await client.plugin.list({ location })
    const selected = plugins.data.filter(plugin => typeof plugin.id === "string" && managedPlugins.includes(plugin.id))
    const failed = selected.find(plugin => plugin.state.status === "failed")
    if (failed) throw new Error(`Managed plugin failed to load: ${JSON.stringify(failed)}`)
    return managedPlugins.every(id => selected.some(plugin => plugin.id === id && plugin.state.status === "active"))
  })
  const skills = await client.skill.list({ location })
  const nativeSkill = skills.data.find(skill => skill.id === "opencode")
  const agentSkill = skills.data.find(skill => skill.id === "opencode-agent")
  assert.ok(nativeSkill, `The runtime must provide the native OpenCode skill: ${JSON.stringify(skills)}`)
  assert.ok(agentSkill, `The runtime must provide the OpenCode Agent skill: ${JSON.stringify(skills)}`)
  assert.equal(agentSkill.content, `${agentSkillAddition}\n${nativeSkill.content}`)
  const first = await client.session.prompt({ sessionID, id: `msg_tg_smoke_${Date.now()}`, text: "Admission test only", delivery: "steer", resume: false })
  const second = await client.session.prompt({ sessionID, id: first.id, text: "Admission test only", delivery: "steer", resume: false })
  assert.equal(first.id, second.id)
  assert.equal((await client.session.inbox.list({ sessionID })).length, 1)
  await client.session.inbox.cancel({ sessionID, inboxID: first.id })

  const image = { uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNwONBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAC3PAFuD+GVmAAAAAElFTkSuQmCC", name: "pixel.png" }
  const attached = await client.session.prompt({ sessionID, id: `msg_image_${Date.now()}`, text: "Image admission test", files: [image], delivery: "steer", resume: false })
  assert.equal(attached.payload.files?.[0]?.name, "pixel.png")
  assert.equal(attached.payload.files?.[0]?.mime, "image/png")
  assert.ok(attached.payload.files?.[0]?.data)
  await client.session.inbox.cancel({ sessionID, inboxID: attached.id })

  const form = await client.session.form.create({ sessionID, title: "Choose", fields: [{ key: "choice", type: "string", required: true, options: [{ label: "Yes", value: "yes" }] }] })
  assert.equal((await client.session.form.list({ sessionID }))[0]?.id, form.id)
  await client.session.form.reply({ sessionID, formID: form.id, answer: { choice: "yes" } })
  assert.equal((await client.session.form.get({ sessionID, formID: form.id })).state.status, "answered")

  const permission = client.permission.create({ sessionID, action: "smoke", resources: ["test"], save: ["test"] })
  // Attach immediately so a failing request cannot become an unhandled rejection while waiting.
  let permissionError: unknown
  const requested = permission.catch(error => { permissionError = error; return undefined })
  await waitFor(async () => {
    if (permissionError) throw permissionError
    return (await client.permission.list({ sessionID: sessionID! })).length > 0
  })
  const pending = (await client.permission.list({ sessionID }))[0]!
  await client.permission.reply({ sessionID, requestID: pending.id, decision: "once" })
  assert.equal((await requested)?.effect, "ask")
  assert.equal((await client.permission.list({ sessionID })).length, 0)
  await client.session.interrupt({ sessionID, resume: false })
  await client.message.list({ sessionID, type: "assistant", order: "desc" })
  await waitFor(() => events.includes("permission.replied") && events.includes("form.replied"))
  console.log(`Live OpenCode ${(await client.server.info()).version}: plugins, skills, sessions, attachments, forms, permissions, history, and events passed.`)
} finally {
  controller.abort()
  await watching.catch(() => {})
  if (sessionID) await client.session.remove({ sessionID })
  await Service.stop({ file: registrationFile() })
}
