import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { optionalText, writeAtomic } from "../src/files"

test("atomic replacement keeps files private and removes temporary files after a failed rename", async () => {
  const directory = await mkdtemp("/tmp/opencode/agent-files-")
  try {
    const state = join(directory, "state.json")
    await writeFile(state, "old", { mode: 0o644 })
    await writeAtomic(state, "new")
    expect(await optionalText(state)).toBe("new")
    expect((await stat(state)).mode & 0o777).toBe(0o600)

    const blocked = join(directory, "blocked")
    await mkdir(blocked)
    await writeFile(join(blocked, "keep"), "existing data")
    await expect(writeAtomic(blocked, "replacement")).rejects.toThrow()
    expect(await optionalText(join(blocked, "keep"))).toBe("existing data")
    expect((await readdir(directory)).sort()).toEqual(["blocked", "state.json"])
    expect(await optionalText(join(directory, "missing"))).toBeUndefined()
    await expect(optionalText(blocked)).rejects.toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
