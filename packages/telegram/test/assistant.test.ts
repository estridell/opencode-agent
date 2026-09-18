import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assistantContext, prepareMemory } from "../src/assistant"
import { configure, loadConfig, loadSettings, managedHome, saveConfig } from "../src/config"
import { cacheAttachment, responseAttachments } from "../src/attachments"

async function withHome(work: (home: string) => Promise<void>) {
  const home = await mkdtemp("/tmp/opencode/agent-assistant-test-")
  const original = process.env.OPENCODE_AGENT_HOME
  process.env.OPENCODE_AGENT_HOME = home
  try { await work(home) }
  finally {
    if (original === undefined) delete process.env.OPENCODE_AGENT_HOME
    else process.env.OPENCODE_AGENT_HOME = original
    await rm(home, { recursive: true, force: true })
  }
}

test("configuration changes preserve credentials and unrelated settings while reads hide credentials", async () => {
  await withHome(async home => {
    await saveConfig({ token: "999:secret", ownerID: 42, directory: "/work", autoApprove: false })
    expect(await configure("get", "token")).toBe("[redacted]")
    expect(JSON.stringify(await configure("get"))).not.toContain("999:secret")
    await configure("set", "memory.maxChars", "1500")
    await configure("set", "timezone", "Europe/Stockholm")
    await configure("set", "progress", "false")
    const current = await loadConfig()
    expect(current).toMatchObject({ token: "999:secret", ownerID: 42, directory: "/work", autoApprove: false, progress: false, memory: { maxChars: 1500 }, timezone: "Europe/Stockholm" })
    const saved = await readFile(join(home, "config.json"), "utf8")
    await expect(configure("set", "token", "123:replacement")).rejects.toThrow("setup")
    await expect(configure("set", "ownerID", "123")).rejects.toThrow("setup")
    for (const [key, value] of [["memory.maxChars", "0"], ["timezone", "not/a/timezone"], ["voice.threads", "10000"], ["__proto__.x", "true"], ["memory.unknown", "1"]]) {
      await expect(configure("set", key, value)).rejects.toThrow()
    }
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(saved)
  })
})

test("parallel configuration setters preserve each independent change", async () => {
  await withHome(async () => {
    await saveConfig({ token: "999:secret", ownerID: 42, directory: "/work" })
    await Promise.all([
      configure("set", "progress", "false"),
      configure("set", "memory.maxChars", "1700"),
      configure("set", "timezone", "Europe/Stockholm"),
    ])
    expect(await loadConfig()).toMatchObject({ progress: false, memory: { maxChars: 1700 }, timezone: "Europe/Stockholm" })
  })
})

test("memory survives preparation and reflects changes and configured context limits", async () => {
  await withHome(async home => {
    await prepareMemory()
    await writeFile(join(home, "memory/USER.md"), "Prefers concise answers.")
    await writeFile(join(home, "memory/MEMORY.md"), "A".repeat(2500))
    await prepareMemory()
    const context = await assistantContext()
    expect(context).toContain("Prefers concise answers.")
    expect(context).toContain("Memory exceeds its context limit")
    expect(context).not.toContain("A".repeat(2201))
    await saveConfig({ token: "999:secret", ownerID: 42, directory: "/work" })
    await configure("set", "memory.maxChars", "3000")
    expect(await assistantContext()).toContain("A".repeat(2500))
    await configure("set", "memory.enabled", "false")
    expect(await assistantContext()).not.toContain("saved-memory")
    expect(await readFile(join(home, "memory/USER.md"), "utf8")).toBe("Prefers concise answers.")
  })
})

test("old managed service environments still locate the same agent home", () => {
  const original = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, agent: process.env.OPENCODE_AGENT_HOME }
  try {
    delete process.env.OPENCODE_AGENT_HOME
    process.env.HOME = "/isolated/agent/runtime/home"
    process.env.XDG_CONFIG_HOME = "/isolated/agent/runtime/config"
    expect(managedHome()).toBe("/isolated/agent")
    process.env.HOME = "/other"
    expect(managedHome()).toBeUndefined()
  } finally {
    for (const [key, value] of [["HOME", original.home], ["XDG_CONFIG_HOME", original.config], ["OPENCODE_AGENT_HOME", original.agent]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
  }
})

test("file caching isolates untrusted names and reuses identical uploads", async () => {
  await withHome(async home => {
    const bytes = Buffer.from("document contents")
    const path = await cacheAttachment(home, "../../escape.txt", bytes)
    expect(path.startsWith(join(home, "attachments") + "/")).toBe(true)
    expect(await readFile(path, "utf8")).toBe("document contents")
    expect(await cacheAttachment(home, "escape.txt", bytes)).toBe(path)
    expect(await cacheAttachment(home, "..", bytes)).toEndWith("/attachment.bin")
  })
})

test("only standalone file markers outside code fences cause an upload", () => {
  const result = responseAttachments('Here is the report.\nMEDIA:"/work/a report.pdf"\nMEDIA:/work/a report.pdf\n```text\nMEDIA:/example.txt\n```\nA path: /work/notes.txt\nMEDIA:relative.txt')
  expect(result.paths).toEqual(["/work/a report.pdf"])
  expect(result.text).toContain("MEDIA:/example.txt")
  expect(result.text).toContain("MEDIA:relative.txt")
  expect(result.text).not.toContain('MEDIA:"/work/a report.pdf"')
})

test("settings have usable defaults before Telegram setup", async () => {
  await withHome(async () => {
    const settings = await loadSettings()
    expect(settings.voice).toMatchObject({ enabled: true, model: "tiny.en", language: "en" })
    expect(settings.memory.enabled).toBe(true)
    expect(settings.progress).toBe(true)
  })
})
