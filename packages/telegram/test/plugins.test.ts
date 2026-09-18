import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import plugin, { applicationContext, telegramContext } from "../../plugins/context"
import { bundledPlugins, installPlugins } from "../src/plugins"

test("context applies to Telegram descendants and preserves base instructions and tool definitions", async () => {
  const sessions: Record<string, { parentID?: string; metadata?: Record<string, string> }> = {
    root: { metadata: { source: "opencode-agent", transport: "telegram" } },
    child: { parentID: "root" }, grandchild: { parentID: "child" }, other: {},
    wrongTransport: { metadata: { source: "opencode-agent", transport: "other" } },
    cycle: { parentID: "cycle" },
  }
  let hook!: (event: SessionContext) => Promise<void>
  await plugin.setup({ session: {
    get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
    hook: async (name: string, fn: typeof hook) => { expect(name).toBe("context"); hook = fn },
  } } as unknown as Context)
  for (const sessionID of Object.keys(sessions)) {
    const base = { type: "text" as const, text: "Model-specific or custom base prompt." }
    const tools = { shell: { description: "Run commands", input: {} } }
    const event = { sessionID, system: [base], tools } as unknown as SessionContext
    await hook(event)
    await hook(event)
    expect(event.system[0]).toBe(base)
    expect(event.tools).toBe(tools)
    expect(event.system.map(part => part.text)).toEqual(
      ["root", "child", "grandchild"].includes(sessionID) ? [base.text, applicationContext, telegramContext] : [base.text],
    )
  }
})

test("plugin synchronization adds, updates, renames, removes, and restores the managed set", async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/agent-context-install-")
  const firstRoot = join(directory, "first")
  const secondRoot = join(directory, "second")
  const config = join(directory, "config")
  try {
    for (const root of [firstRoot, secondRoot]) await mkdir(join(root, "packages/plugins/research"), { recursive: true })
    await writeFile(join(firstRoot, "packages/plugins/notes.ts"), "export default { id: 'notes', setup() {} }")
    await writeFile(join(firstRoot, "packages/plugins/research/server.ts"), "export default { id: 'research', setup() {} }")
    await writeFile(join(firstRoot, "packages/plugins/research/helper.ts"), "export const value = 1")
    await writeFile(join(secondRoot, "packages/plugins/writing.js"), "export default { id: 'notes', setup() {} }")
    await writeFile(join(secondRoot, "packages/plugins/research/index.ts"), "export default { id: 'research', setup() {} }")
    await mkdir(join(config, "opencode/plugins"), { recursive: true })
    const legacy = join(config, "opencode/plugins/opencode-agent-context.ts")
    await writeFile(legacy, "previous bundled context")
    expect(await installPlugins(config, firstRoot)).toBe(true)
    expect(await Bun.file(legacy).exists()).toBe(false)
    const path = join(config, "opencode/plugins/opencode-agent-file-notes.ts")
    const first = await stat(path)
    expect(await installPlugins(config, firstRoot)).toBe(false)
    expect((await stat(path)).mtimeMs).toBe(first.mtimeMs)
    const other = join(config, "opencode/plugins/custom.ts")
    await writeFile(other, "unrelated plugin")
    expect(await installPlugins(config, secondRoot)).toBe(true)
    expect(await Bun.file(path).exists()).toBe(false)
    const renamed = join(config, "opencode/plugins/opencode-agent-file-writing.js")
    expect(await readFile(renamed, "utf8")).toContain(join(secondRoot, "packages/plugins/writing.js"))
    expect(await readFile(join(config, "opencode/plugins/opencode-agent-package-research.ts"), "utf8")).toContain("research/index.ts")
    expect(await installPlugins(config, firstRoot)).toBe(true)
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await Bun.file(renamed).exists()).toBe(false)
    expect(await installPlugins(config, join(directory, "empty"))).toBe(true)
    expect(await Bun.file(path).exists()).toBe(false)
    expect(await readFile(other, "utf8")).toBe("unrelated plugin")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("plugin packages resolve their entrypoints and preserve unrelated generated-name collisions", async () => {
  const directory = await mkdtemp("/tmp/opencode/agent-plugins-collision-")
  try {
    const root = join(directory, "source")
    await mkdir(join(root, "packages/plugins/research"), { recursive: true })
    await writeFile(join(root, "packages/plugins/research/package.json"), '{"main":"entry.js"}')
    await writeFile(join(root, "packages/plugins/research/entry.js"), "export default {}")
    expect([...(await bundledPlugins(root)).values()]).toEqual([join(root, "packages/plugins/research/entry.js")])
    const config = join(directory, "config")
    await mkdir(join(config, "opencode/plugins"), { recursive: true })
    const collision = join(config, "opencode/plugins/opencode-agent-package-research.ts")
    await writeFile(collision, "user plugin")
    await expect(installPlugins(config, root)).rejects.toThrow("unrelated plugin")
    expect(await readFile(collision, "utf8")).toBe("user plugin")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
