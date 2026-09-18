import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Service } from "@opencode/client/service"
import { applicationContext } from "../../plugins/context"
import { agentHome } from "../src/config"
import { connect } from "../src/opencode"
import { installRuntime, prepareRuntime, registrationFile, runtimeEnv, upstreamBinary, workspace } from "../src/runtime"

if (!process.env.OPENCODE_AGENT_HOME?.startsWith("/tmp/opencode/") || await Bun.file(join(agentHome(), "config.json")).exists()) {
  throw new Error("Set OPENCODE_AGENT_HOME to a temporary directory under /tmp/opencode without Telegram configuration.")
}

// Capture real provider requests from the upstream runtime without a remote model or credentials.
const requests: { messages: { role: string; content: unknown }[] }[] = []
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json() as typeof requests[number] & { model: string }
    requests.push(body)
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})

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

  const check = async (sessionID: string, expected: boolean, base: string) => {
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
    assert.equal(system.split(applicationContext).length - 1, expected ? 1 : 0)
  }

  await check(parent.id, true, "You are an AI agent running in OpenCode")
  const plugins = await client.plugin.list({ location })
  assert.ok(JSON.stringify(plugins).includes("opencode-agent.context"), `The runtime must load the deployed plugin: ${JSON.stringify(plugins)}`)
  await check(parent.id, true, "You are an AI agent running in OpenCode")
  await check(unrelated.id, false, "You are an AI agent running in OpenCode")
  await check(custom.id, true, "Custom base instructions")
  await client.session.switchModel({ sessionID: parent.id, model: { providerID: "fixture", id: "gpt-6-context-test" } })
  await check(parent.id, true, "Do not settle for a partial")

  // Simulate an older deployed plugin: connect must repair it and restart the owned service.
  const before = await Bun.file(registrationFile()).json()
  await writeFile(join(configDirectory, "plugins", "opencode-agent-context.ts"), 'export default { id: "opencode-agent.context", setup() {} }\n')
  client = await connect()
  const after = await Bun.file(registrationFile()).json()
  assert.notEqual(before?.pid, after?.pid)
  await check(parent.id, true, "Do not settle for a partial")
  console.log("Context plugin passed: Telegram scope, unrelated sessions, custom and model-specific prompts, repeated requests, and activation after restart.")
} finally {
  await Service.stop({ file: registrationFile() })
  await server.stop(true)
}
