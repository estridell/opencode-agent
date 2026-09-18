import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Copy the self-contained plugin into the owned runtime's watched global plugin directory. */
export async function installContextPlugin(configDirectory: string): Promise<boolean> {
  const directory = join(configDirectory, "opencode", "plugins")
  const destination = join(directory, "opencode-agent-context.ts")
  const source = await readFile(new URL("../../plugins/context.ts", import.meta.url), "utf8")
  const existing = await readFile(destination, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  })
  if (existing === source) return false
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, source, { mode: 0o600 })
  await rename(temporary, destination)
  return true
}
