import { createHash } from "node:crypto"
import { appendFile, copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { Api, GrammyError } from "grammy"
import { Service } from "@opencode/client/service"
import { agentHome, errorText, loadConfig } from "./config"
import { installedCliPath, unitName } from "./service"
import { downloadRuntime, prepareRuntime, registrationFile, runtimeEnv, upstreamBinary } from "./runtime"
import { installPlugins } from "./plugins"
import { OpenCode } from "@opencode/client"

export type UpdateState = { id: string; phase: "running" | "done" | "failed"; text: string; time: number; messages?: string[] }
export const updateUnit = () => `opencode-agent-update-${createHash("sha256").update(agentHome()).digest("hex").slice(0, 12)}`
const sourceRoot = () => fileURLToPath(new URL("../../..", import.meta.url))
const jobFile = (id: string) => join(agentHome(), "updates", `${id}.json`)

export async function command(args: string[], cwd = agentHome(), env = process.env): Promise<string> {
  const child = Bun.spawn(args, { cwd, env: { ...env, NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`${args[0]} failed (${code}).\n${(out + err).trim().slice(-1500)}`)
  return out.trim()
}

/** The user service manager owns the worker, so gateway restarts cannot kill it. */
export async function startUpdate(messageID?: number): Promise<string> {
  await mkdir(join(agentHome(), "updates"), { recursive: true, mode: 0o700 })
  const id = crypto.randomUUID()
  const state: UpdateState = { id, phase: "running", text: "Starting update.", time: Date.now() }
  await writeFile(jobFile(id), JSON.stringify(state), { mode: 0o600 })
  try {
    await command([
      "systemd-run", "--user", "--collect", `--unit=${updateUnit()}`, "--property=Type=exec",
      "--property=UMask=0077", `--working-directory=${sourceRoot()}`,
      `--setenv=OPENCODE_AGENT_HOME=${agentHome()}`, `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
      ...(process.env.XDG_CONFIG_HOME ? [`--setenv=XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`] : []),
      "--", "flock", "--no-fork", "--nonblock", join(agentHome(), "update.lock"),
      process.execPath, installedCliPath(), "update", "_run", id, ...(messageID ? [String(messageID)] : []),
    ])
  } catch (error) {
    await writeFile(jobFile(id), JSON.stringify({ ...state, phase: "failed", text: errorText(error) }))
    throw new Error("Cannot start the update. Another update may be running. Check the systemd user service.", { cause: error })
  }
  return id
}

export async function followUpdate(id: string) {
  let count = 0
  for (;;) {
    const state = await Bun.file(jobFile(id)).json() as UpdateState
    const messages = state.messages ?? []
    for (const text of messages.slice(count)) console.log(text)
    count = messages.length
    if (state.phase !== "running") { process.exitCode = state.phase === "done" ? 0 : 1; return }
    const active = await command(["systemctl", "--user", "show", `${updateUnit()}.service`, "--property=ActiveState", "--value"])
    if (!["active", "activating", "reloading"].includes(active)) throw new Error(`The update worker stopped. Read ${join(agentHome(), "updates", `${id}.log`)}.`)
    await sleep(1000)
  }
}

export function releaseVersion(value: unknown): string {
  const version = (value as { version?: unknown } | null)?.version
  if (typeof version !== "string" || !/^2\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("The update service did not return an OpenCode V2 version.")
  return version
}

/** Fingerprint only the gateway's resolved dependency graph, not plugin or development dependencies. */
export async function gatewayDependencies(root: string): Promise<string> {
  const lock = Bun.JSON5.parse(await readFile(join(root, "bun.lock"), "utf8")) as {
    lockfileVersion: number
    workspaces: Record<string, { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>
    packages: Record<string, [string, string?, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }?]>
  }
  if (lock.lockfileVersion !== 1) throw new Error("Unsupported Bun lockfile version.")
  const graph = new Map<string, unknown>()
  const visit = (name: string, from: string[], optional = false) => {
    let key: string | undefined
    for (let length = from.length; length >= 0; length--) {
      const candidate = [...from.slice(0, length), name].join("/")
      if (lock.packages[candidate]) { key = candidate; break }
    }
    if (!key) {
      if (optional) return
      throw new Error(`Missing gateway dependency: ${name}.`)
    }
    if (graph.has(key)) return
    const entry = lock.packages[key]!
    graph.set(key, entry)
    const workspace = entry[0].split("@workspace:")[1]
    const metadata = workspace ? lock.workspaces[workspace] : entry[2]
    if (workspace) graph.set(`workspace:${workspace}`, metadata)
    const parents = key.match(/(?:@[^/]+\/)?[^/]+/g)!
    for (const dep of Object.keys(metadata?.dependencies ?? {})) visit(dep, parents)
    for (const dep of Object.keys(metadata?.optionalDependencies ?? {})) visit(dep, parents, true)
    if (metadata && "peerDependencies" in metadata) {
      for (const dep of Object.keys(metadata.peerDependencies ?? {})) visit(dep, parents, true)
    }
  }
  const gateway = lock.workspaces["packages/telegram"]
  if (!gateway) throw new Error("The gateway is missing from the Bun lockfile.")
  for (const name of Object.keys(gateway.dependencies ?? {})) visit(name, [gateway.name])
  for (const name of Object.keys(gateway.optionalDependencies ?? {})) visit(name, [gateway.name], true)
  for (const name of Object.keys(gateway.peerDependencies ?? {})) visit(name, [gateway.name], true)
  const manifests = await Promise.all(["package.json", "packages/telegram/package.json"].map(async file => {
    const manifest = JSON.parse(await readFile(join(root, file), "utf8"))
    return Object.fromEntries(["type", "imports", "exports", ...(file.startsWith("packages/") ? ["dependencies", "optionalDependencies", "peerDependencies"] : [])]
      .map(key => [key, manifest[key]]))
  }))
  const configText = await readFile(join(root, "tsconfig.json"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return "{}"
  })
  const config = Bun.JSON5.parse(configText) as { extends?: unknown; compilerOptions?: Record<string, unknown> }
  // Bun reads these settings during execution; type-check-only settings need no restart.
  const transforms = Object.fromEntries(["target", "module", "moduleResolution", "paths", "baseUrl", "jsx", "jsxFactory", "jsxFragmentFactory", "jsxImportSource", "experimentalDecorators", "emitDecoratorMetadata", "useDefineForClassFields", "verbatimModuleSyntax"]
    .map(key => [key, config.compilerOptions?.[key]]))
  return JSON.stringify([manifests, config.extends, transforms, [...graph].sort(([a], [b]) => a.localeCompare(b))])
}

/** No restart is the default. Only these gateway/installation inputs trigger a restart. */
const gatewayRestartFiles = new Set(["install.sh", "bunfig.toml", "packages/telegram/bunfig.toml"])

export async function requiresGatewayRestart(current: string, next: string, runtimeChanged: boolean): Promise<boolean> {
  if (runtimeChanged) return true
  const inventories = await Promise.all([current, next].map(async directory =>
    (await command(["git", "ls-files", "-z"], directory)).split("\0").filter(Boolean)))
  for (const file of new Set(inventories.flat())) {
    if (!file.startsWith("packages/telegram/src/") && !gatewayRestartFiles.has(file)) continue
    const read = async (root: string) => {
      const path = join(root, file)
      const info = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        return undefined
      })
      if (!info) return undefined
      const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path)
      return `${info.mode}:${createHash("sha256").update(bytes).digest("hex")}`
    }
    const [before, after] = await Promise.all([read(current), read(next)])
    if (before !== after) return true
  }
  // An invalid dependency snapshot fails preparation; it does not request a speculative restart.
  return await gatewayDependencies(current) !== await gatewayDependencies(next)
}

export async function selectApplication(directory: string, home = agentHome()) {
  const temporary = join(home, `current.next.${crypto.randomUUID()}`)
  await symlink(directory, temporary)
  try { await rename(temporary, join(home, "current")) }
  finally { await rm(temporary, { force: true }) }
}

type UpdateActions = { activate(): Promise<void>; verify(): Promise<void>; recover(): Promise<void> }

/** Preparation errors leave the running service intact. Recovery never downgrades a migrated runtime database. */
export async function applyUpdate(steps: UpdateActions & {
  prepare(): Promise<void | false>
  restart?: UpdateActions & { required(): boolean; stop(): Promise<void>; start(): Promise<void> }
}) {
  if (await steps.prepare() === false) return false
  const restart = steps.restart?.required() ? steps.restart : undefined
  const actions = restart ?? steps
  try {
    await restart?.stop()
    await actions.activate()
    await restart?.start()
    await actions.verify()
    return true
  } catch (error) {
    try { await actions.recover() }
    catch (recovery) { throw new Error(`${errorText(error)}\nUpdate recovery also failed: ${errorText(recovery)}`) }
    throw error
  }
}

export async function runUpdate(id: string, messageID?: number) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid update ID.")
  const config = await loadConfig()
  const api = new Api(config.token, { timeoutSeconds: 15 })
  const log = join(agentHome(), "updates", `${id}.log`)
  let lastEdit = 0
  const messages: string[] = []
  const report = async (text: string, phase: UpdateState["phase"] = "running") => {
    text = errorText(text, [config.token])
    messages.push(text)
    const state: UpdateState = { id, phase, text, time: Date.now(), messages }
    await writeFile(`${jobFile(id)}.next`, JSON.stringify(state), { mode: 0o600 })
    await rename(`${jobFile(id)}.next`, jobFile(id))
    await appendFile(log, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 })
    console.log(text)
    if (!messageID) return
    await sleep(Math.max(0, lastEdit + 1200 - Date.now()))
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await api.editMessageText(config.ownerID, messageID, text); break }
      catch (error) {
        if (error instanceof GrammyError && /message is not modified/i.test(error.description)) break
        if (attempt === 2) { console.error(errorText(error, [config.token])); break }
        await sleep(error instanceof GrammyError && error.parameters.retry_after ? error.parameters.retry_after * 1000 : 1500)
      }
    }
    lastEdit = Date.now()
  }
  const run = async (args: string[], cwd?: string) => {
    const result = await command(args, cwd)
    if (result) await appendFile(log, `${errorText(result, [config.token])}\n`)
    return result
  }
  const root = sourceRoot()
  const stage = join(agentHome(), "versions", id)
  let binary = ""
  let version = ""
  let commit = ""
  let runtimeChanged = false
  let restartAt = 0
  let stopped = false
  let restartRequired = false
  let gatewayPID = ""
  let runtimePID = 0
  let selected = false
  const saveInstalled = async () => {
    const file = join(agentHome(), "installed.json")
    await writeFile(`${file}.next`, JSON.stringify({ commit, version, source: stage, time: Date.now() }, null, 2), { mode: 0o600 })
    await rename(`${file}.next`, file)
  }
  try {
    const changed = await applyUpdate({
      prepare: async () => {
        await report("Fetching application updates.")
        await prepareRuntime()
        const repo = await command(["git", "remote", "get-url", "origin"], root)
        await mkdir(dirname(stage), { recursive: true, mode: 0o700 })
        await run(["git", "clone", "--depth=1", "--branch=main", "--", repo, stage])
        commit = await command(["git", "rev-parse", "--short=12", "HEAD"], stage)
        await report("Checking the latest OpenCode V2 release.")
        const response = await fetch("https://opencode.ai/update/api/latest/cli/npm", { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`OpenCode release check failed: HTTP ${response.status}`)
        version = releaseVersion(await response.json())
        const installed = await command([upstreamBinary(), "--version"])
        runtimeChanged = !installed.endsWith(` ${version}`) && !installed.endsWith(`v${version}`)
        const current = await Bun.file(join(agentHome(), "installed.json")).json().catch(() => undefined)
        if (current?.commit === commit && current.version === version && !runtimeChanged && resolve(current.source) === resolve(root)) {
          await rm(stage, { recursive: true, force: true })
          return false
        }
        const packageFile = join(stage, "packages/telegram/package.json")
        const manifest = await Bun.file(packageFile).json()
        const clientChanged = manifest.dependencies["@opencode/client"] !== version
        manifest.dependencies["@opencode/client"] = version
        if (clientChanged) await writeFile(packageFile, JSON.stringify(manifest, null, 2) + "\n")
        const rootPackageFile = join(stage, "package.json")
        const rootManifest = await Bun.file(rootPackageFile).json()
        const pluginChanged = rootManifest.devDependencies?.["@opencode/plugin"] !== version
        rootManifest.devDependencies ??= {}
        rootManifest.devDependencies["@opencode/plugin"] = version
        if (pluginChanged) await writeFile(rootPackageFile, JSON.stringify(rootManifest, null, 2) + "\n")
        await report(`Installing dependencies and OpenCode client ${version}.`)
        await run([process.execPath, "install", ...(clientChanged || pluginChanged ? [] : ["--frozen-lockfile"])], stage)
        await report("Checking the application.")
        await run([process.execPath, "run", "check"], stage)
        await run([process.execPath, "test"], stage)
        restartRequired = await requiresGatewayRestart(root, stage, runtimeChanged)
        if (!restartRequired) {
          const currentPath = await realpath(join(agentHome(), "current")).catch(() => "")
          gatewayPID = await command(["systemctl", "--user", "show", unitName, "--property=MainPID", "--value"])
          const endpoint = await Service.discover({ file: registrationFile() })
          if (currentPath !== await realpath(root)) throw new Error("Run the update from the selected application.")
          if (Number(gatewayPID) <= 0 || !endpoint) throw new Error("The gateway and OpenCode must be running for a live update.")
          runtimePID = (await Bun.file(registrationFile()).json()).pid
        }
        if (runtimeChanged) {
          await report(`Downloading OpenCode V2 ${version}.`)
          binary = await downloadRuntime(version, join(stage, ".runtime"))
        }
      },
      activate: async () => {
        await report("Applying updates. Telegram and OpenCode remain running.")
        await selectApplication(stage)
        selected = true
        await installPlugins(runtimeEnv().XDG_CONFIG_HOME!, stage)
      },
      verify: async () => {
        const endpoint = await Service.discover({ file: registrationFile() })
        if (!endpoint) throw new Error("The separate OpenCode service is unavailable.")
        const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        const info = await client.server.info({ signal: AbortSignal.timeout(15_000) })
        const pid = await command(["systemctl", "--user", "show", unitName, "--property=MainPID", "--value"])
        if (pid !== gatewayPID || (await Bun.file(registrationFile()).json()).pid !== runtimePID || info.version !== version) {
          throw new Error("A service changed during the live update.")
        }
        await saveInstalled()
      },
      recover: async () => {
        if (!selected) return
        await selectApplication(root)
        await installPlugins(runtimeEnv().XDG_CONFIG_HOME!, root)
      },
      restart: {
        required: () => restartRequired,
        stop: async () => {
          await report(runtimeChanged ? "Restarting the gateway and OpenCode. Active tasks can be interrupted." : "Restarting the Telegram gateway.")
          stopped = true
          await run(["systemctl", "--user", "stop", unitName])
          // Also wait for the child to release the gateway lock before touching files.
          await run(["flock", "--wait", "20", join(agentHome(), "gateway.lock"), "true"])
          if (runtimeChanged) {
            await Service.stop({ file: registrationFile() })
            await copyFile(upstreamBinary(), join(stage, "opencode.previous"))
            await copyFile(binary, `${upstreamBinary()}.next`)
            await rename(`${upstreamBinary()}.next`, upstreamBinary())
          }
        },
        activate: async () => {
          // The current installer updates the stable launcher, Bun, and dependencies.
          await run(["bash", join(stage, "install.sh"), "--source", stage, "--no-setup"])
          await run([join(agentHome(), "tools/bun/bin/bun"), join(stage, "packages/telegram/src/main.ts"), "gateway", "_install"])
        },
        start: async () => {
          restartAt = Date.now()
          await run(["systemctl", "--user", "start", unitName])
        },
        verify: async () => {
          await report("Waiting for the gateway to connect.")
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            const ready = await Bun.file(join(agentHome(), "gateway-ready.json")).json().catch(() => undefined)
            if (ready?.time >= restartAt && ready.version === version && resolve(ready.source) === resolve(stage)) {
              await saveInstalled()
              return
            }
            await sleep(1000)
          }
          throw new Error("The gateway did not connect within 60 seconds. Run opencode-agent gateway logs.")
        },
        recover: async () => {
          if (stopped) await run(["systemctl", "--user", "restart", unitName])
        },
      },
    })
    await report(changed ? `Update complete.\nApplication: ${commit}\nOpenCode: ${version}\n${restartRequired ? "Telegram connected." : "Services kept running."}` : `Already up to date.\nApplication: ${commit}\nOpenCode: ${version}`, "done")
  } catch (error) {
    await report(`Update failed.\n${errorText(error, [config.token])}\nLog: ${log}`, "failed")
    process.exitCode = 1
  }
}

export async function markGatewayReady(version: string) {
  const state = { time: Date.now(), pid: process.pid, version, source: await realpath(sourceRoot()) }
  await writeFile(join(agentHome(), "gateway-ready.json"), JSON.stringify(state), { mode: 0o600 })
}
