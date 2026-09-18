import assert from "node:assert/strict"
import { mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Service } from "@opencode/client/service"
import { applicationContext } from "../../plugins/context"
import { agentHome } from "../src/config"
import { connect } from "../src/opencode"
import { installPlugins } from "../src/plugins"
import { selectApplication } from "../src/update"
import { installRuntime, prepareRuntime, registrationFile, runtimeEnv, upstreamBinary, workspace } from "../src/runtime"

if (!process.env.OPENCODE_AGENT_HOME?.startsWith("/tmp/opencode/") || await Bun.file(join(agentHome(), "config.json")).exists()) {
  throw new Error("Set OPENCODE_AGENT_HOME to a temporary directory under /tmp/opencode without Telegram configuration.")
}

// Capture real provider requests from the upstream runtime without a remote model or credentials.
const requests: { messages: { role: string; content: unknown }[] }[] = []
let holdResponse: Promise<void> | undefined
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json() as typeof requests[number] & { model: string }
    requests.push(body)
    await holdResponse
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})
const previous = await readlink(join(agentHome(), "current")).catch(() => undefined)
let selected = false

try {
  await prepareRuntime()
  if (!await Bun.file(upstreamBinary()).exists()) await installRuntime()
  const configDirectory = join(runtimeEnv().XDG_CONFIG_HOME!, "opencode")
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "fixture/gpt-context-test",
    providers: { fixture: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only" },
      models: { "gpt-context-test": {}, "gpt-6-context-test": {} },
    } },
    agents: { custom: { mode: "primary", system: "Custom base instructions for the integration test." } },
  }))
  let client = await connect()
  const location = { directory: workspace() }
  const parent = await client.session.create({ title: "Context parent", location, metadata: { source: "opencode-agent", transport: "telegram" } })
  const unrelated = await client.session.create({ title: "Context unrelated", location })
  const custom = await client.session.create({ title: "Context custom", location, agent: "custom", metadata: parent.metadata })

  const check = async (sessionID: string, expected: boolean, base: string, note = applicationContext) => {
    requests.length = 0
    await client.session.prompt({ sessionID, text: "Context integration probe. Reply OK." })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const history = await client.message.list({ sessionID, type: "assistant", order: "desc", limit: 1 })
      const response = history.data[0]
      if (response?.type === "assistant" && response.error) throw new Error(JSON.stringify(response.error))
      if (requests.length && !Object.hasOwn(await client.session.active(), sessionID)) break
      await sleep(100)
    }
    assert.ok(requests.length, "No request reached the local provider.")
    const system = requests.at(-1)!.messages.filter(m => m.role === "system" || m.role === "developer").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    assert.ok(system.includes(base), "The upstream or custom base prompt must remain present.")
    assert.equal(system.split(note).length - 1, expected ? 1 : 0, `Unexpected plugin note: ${note}`)
  }

  await check(parent.id, true, "You are an AI agent running in OpenCode")
  const plugins = await client.plugin.list({ location })
  assert.ok(JSON.stringify(plugins).includes("opencode-agent.context"), `The runtime must load the deployed plugin: ${JSON.stringify(plugins)}`)
  await check(parent.id, true, "You are an AI agent running in OpenCode")
  await check(unrelated.id, false, "You are an AI agent running in OpenCode")
  await check(custom.id, true, "Custom base instructions")
  await client.session.switchModel({ sessionID: parent.id, model: { providerID: "fixture", id: "gpt-6-context-test" } })
  await check(parent.id, true, "Do not settle for a partial")

  // Update a loaded plugin and reconnect through the old gateway module.
  // The selected checkout must supply the note without replacing the service.
  const before = await Bun.file(registrationFile()).json()
  const stage = join(agentHome(), "versions", crypto.randomUUID())
  await mkdir(join(stage, "packages/plugins"), { recursive: true })
  const source = await readFile(new URL("../../plugins/context.ts", import.meta.url), "utf8")
  const revised = applicationContext.replace("Keep replies suitable for a Telegram conversation.", "Keep replies short for this live reload test.")
  await writeFile(join(stage, "packages/plugins/context.ts"), source.replace(applicationContext, revised))
  let release!: () => void
  holdResponse = new Promise<void>(resolve => { release = resolve })
  requests.length = 0
  await client.session.prompt({ sessionID: parent.id, text: "Keep this request active during the plugin update." })
  const waiting = Date.now() + 10_000
  while (!requests.length && Date.now() < waiting) await sleep(50)
  assert.ok(requests.length, "The model request must start before the plugin update.")
  await selectApplication(stage)
  selected = true
  await installPlugins(runtimeEnv().XDG_CONFIG_HOME!)
  await sleep(500)
  assert.ok(Object.hasOwn(await client.session.active(), parent.id), "Plugin reload must preserve the active request.")
  release()
  holdResponse = undefined
  const finishing = Date.now() + 10_000
  while (Object.hasOwn(await client.session.active(), parent.id) && Date.now() < finishing) await sleep(50)
  assert.ok(!Object.hasOwn(await client.session.active(), parent.id), "The active request must finish after plugin reload.")
  // Watcher notification and the upstream 100 ms debounce are asynchronous.
  const deadline = Date.now() + 10_000
  for (;;) {
    try { await check(parent.id, true, "Do not settle for a partial", revised); break }
    catch (error) { if (!(error instanceof assert.AssertionError) || Date.now() >= deadline) throw error }
    await sleep(100)
  }
  client = await connect()
  const after = await Bun.file(registrationFile()).json()
  assert.equal(before.pid, after.pid)
  await check(parent.id, true, "Do not settle for a partial", revised)
  const eventually = async (note: string, present: boolean) => {
    const deadline = Date.now() + 10_000
    for (;;) {
      try { await check(parent.id, present, "Do not settle for a partial", note); return }
      catch (error) { if (!(error instanceof assert.AssertionError) || Date.now() >= deadline) throw error }
      await sleep(100)
    }
  }
  // A second plugin has its own package entrypoint, relative import, and data file.
  const extra = join(stage, "packages/plugins/research")
  await mkdir(extra, { recursive: true })
  const dependency = join(extra, "node_modules/fixture-plugin-dependency")
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, "package.json"), '{"name":"fixture-plugin-dependency","version":"1.0.0","type":"module","main":"index.js"}')
  await writeFile(join(dependency, "index.js"), 'export const suffix = " Package dependency loaded."\n')
  await writeFile(join(extra, "package.json"), '{"main":"entry.js","dependencies":{"fixture-plugin-dependency":"1.0.0"}}')
  await writeFile(join(extra, "note.json"), JSON.stringify({ text: "Research plugin revision one." }))
  await writeFile(join(extra, "helper.js"), 'import data from "./note.json"; import { suffix } from "fixture-plugin-dependency"; export const note = data.text + suffix\n')
  await writeFile(join(extra, "entry.js"), 'import { note } from "./helper.js"; export default { id: "fixture.research", async setup(ctx) { await ctx.session.hook("context", event => { event.system.push({ type: "text", text: note }) }) } }\n')
  await installPlugins(runtimeEnv().XDG_CONFIG_HOME!)
  await eventually("Research plugin revision one.", true)
  await eventually("Package dependency loaded.", true)
  await writeFile(join(extra, "note.json"), JSON.stringify({ text: "Research plugin revision two." }))
  await eventually("Research plugin revision two.", true)
  const renamed = join(stage, "packages/plugins/writing")
  await rename(extra, renamed)
  await installPlugins(runtimeEnv().XDG_CONFIG_HOME!)
  const renameDeadline = Date.now() + 10_000
  for (;;) {
    const inventory = await client.plugin.list({ location })
    if (inventory.data.some(plugin => plugin.id === "fixture.research" && plugin.state.status === "active" && plugin.source.type === "local" && plugin.source.path.endsWith("opencode-agent-package-writing.ts"))) break
    assert.ok(Date.now() < renameDeadline, "The renamed plugin must become active.")
    await sleep(100)
  }
  await eventually("Research plugin revision two.", true)
  await rm(renamed, { recursive: true })
  await installPlugins(runtimeEnv().XDG_CONFIG_HOME!)
  await eventually("Research plugin revision two.", false)
  await rm(join(stage, "packages/plugins/context.ts"))
  await installPlugins(runtimeEnv().XDG_CONFIG_HOME!)
  await eventually(revised, false)
  // An old gateway's reconnect must preserve removals, including the original context plugin.
  client = await connect()
  await eventually(revised, false)
  assert.equal(before.pid, (await Bun.file(registrationFile()).json()).pid)
  console.log("Plugin lifecycle passed: addition, package dependencies and assets, changes, rename, removal, active requests, preserved prompts, unchanged runtime process, and gateway reconnection.")
} finally {
  await Service.stop({ file: registrationFile() })
  await server.stop(true)
  if (selected) {
    if (previous) await selectApplication(previous)
    else await rm(join(agentHome(), "current"))
  }
}
