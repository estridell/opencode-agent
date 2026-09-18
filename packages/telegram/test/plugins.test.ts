import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import plugin, { applicationContext } from "../../plugins/context"
import { installContextPlugin } from "../src/plugins"

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
      ["root", "child", "grandchild"].includes(sessionID) ? [base.text, applicationContext] : [base.text],
    )
  }
})

test("plugin installation replaces only its managed file and skips unchanged copies", async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/agent-context-install-")
  try {
    expect(await installContextPlugin(directory)).toBe(true)
    const path = join(directory, "opencode/plugins/opencode-agent-context.ts")
    const first = await stat(path)
    expect(await installContextPlugin(directory)).toBe(false)
    expect((await stat(path)).mtimeMs).toBe(first.mtimeMs)
    const other = join(directory, "opencode/plugins/custom.ts")
    await writeFile(other, "unrelated plugin")
    await writeFile(path, "old plugin")
    expect(await installContextPlugin(directory)).toBe(true)
    expect(await readFile(path, "utf8")).toContain(applicationContext)
    expect(await readFile(other, "utf8")).toBe("unrelated plugin")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
