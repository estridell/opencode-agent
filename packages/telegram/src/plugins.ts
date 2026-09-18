import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { agentHome } from "./config"
import { optionalText, writeAtomic } from "./files"

/** Resolve the selected application even when this module belongs to an older gateway. */
export async function pluginSourceRoot() {
  return realpath(join(agentHome(), "current")).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return fileURLToPath(new URL("../../..", import.meta.url))
  })
}

/** Match V2's local server entrypoints. Other files remain available as plugin assets and imports. */
export async function bundledPlugins(root: string): Promise<Map<string, string>> {
  const directory = join(root, "packages/plugins")
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return []
  })
  const plugins = new Map<string, string>()
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const path = join(directory, entry.name)
    const info = entry.isSymbolicLink() ? await stat(path) : entry
    if (info.isFile() && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      plugins.set(`opencode-agent-file-${entry.name}`, path)
    } else if (info.isDirectory()) {
      // Upstream checks server before the package's main/index entrypoint.
      for (const candidate of [join(path, "server"), path]) {
        try {
          plugins.set(`opencode-agent-package-${entry.name}.ts`, Bun.resolveSync(candidate, directory))
          break
        } catch (error) {
          if (!["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        }
      }
      if (!plugins.has(`opencode-agent-package-${entry.name}.ts`) && await Bun.file(join(path, "package.json")).exists()) {
        throw new Error(`Plugin package has no server entrypoint: ${entry.name}.`)
      }
    }
  }
  return plugins
}

/** Synchronize the complete bundled plugin set. OpenCode watches these generated entrypoints. */
export async function installPlugins(configDirectory: string, root?: string): Promise<boolean> {
  root ??= await pluginSourceRoot()
  const plugins = await bundledPlugins(root)
  const config = join(configDirectory, "opencode")
  const directory = join(config, "plugins")
  const inventory = join(config, "opencode-agent-plugins.json")
  const saved = await optionalText(inventory)
  const managed: string[] = saved ? JSON.parse(saved) : []
  if (!Array.isArray(managed) || managed.some(name => typeof name !== "string" || basename(name) !== name || !/^opencode-agent-.*\.(ts|js)$/.test(name))) {
    throw new Error("Invalid managed plugin inventory.")
  }
  // This exact file was managed by the first context-plugin installer.
  const legacy = "opencode-agent-context.ts"
  if (!saved && await optionalText(join(directory, legacy)) !== undefined) managed.push(legacy)
  const desired = new Map([...plugins].map(([name, source]) => [name, `export { default } from ${JSON.stringify(source)}\n`]))
  const changes = new Map<string, string>()
  for (const [name, text] of desired) {
    const existing = await optionalText(join(directory, name))
    if (existing !== undefined && !managed.includes(name)) throw new Error(`An unrelated plugin already uses ${name}.`)
    if (existing !== text) changes.set(name, text)
  }
  const removed = managed.filter(name => !desired.has(name))
  if (!changes.size && !removed.length && saved) return false
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Record additions before writing them so a failed activation can restore the old set.
  await writeAtomic(inventory, JSON.stringify([...new Set([...managed, ...desired.keys()])]))
  for (const [name, text] of changes) await writeAtomic(join(directory, name), text)
  for (const name of removed) await rm(join(directory, name), { force: true })
  await writeAtomic(inventory, JSON.stringify([...desired.keys()]))
  return changes.size > 0 || removed.length > 0
}
