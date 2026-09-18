import { createHash } from "node:crypto"
import { appendFile, copyFile, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { Api, GrammyError } from "grammy"
import { Service } from "@opencode/client/service"
import { agentHome, errorText, loadConfig } from "./config"
import { cliPath, unitName } from "./service"
import { downloadRuntime, prepareRuntime, registrationFile, upstreamBinary } from "./runtime"

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
      process.execPath, cliPath(), "update", "_run", id, ...(messageID ? [String(messageID)] : []),
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

/** Preparation errors leave the running service intact. Recovery never downgrades a migrated runtime database. */
export async function applyUpdate(steps: {
  prepare(): Promise<void | false>; stop(): Promise<void>; activate(): Promise<void>
  start(): Promise<void>; verify(): Promise<void>; recover(): Promise<void>
}) {
  if (await steps.prepare() === false) return false
  try {
    await steps.stop()
    await steps.activate()
    await steps.start()
    await steps.verify()
    return true
  } catch (error) {
    try { await steps.recover() }
    catch (recovery) { throw new Error(`${errorText(error)}\nRestart also failed: ${errorText(recovery)}`) }
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
        if (runtimeChanged) {
          await report(`Downloading OpenCode V2 ${version}.`)
          binary = await downloadRuntime(version, join(stage, ".runtime"))
        }
      },
      stop: async () => {
        await report(runtimeChanged ? "Restarting the gateway and OpenCode. Active tasks can be interrupted." : "Restarting the Telegram gateway. Plugin changes can also restart OpenCode.")
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
            await writeFile(join(agentHome(), "installed.json"), JSON.stringify({ commit, version, source: stage, time: Date.now() }, null, 2), { mode: 0o600 })
            return
          }
          await sleep(1000)
        }
        throw new Error("The gateway did not connect within 60 seconds. Run opencode-agent gateway logs.")
      },
      recover: async () => {
        if (stopped) await run(["systemctl", "--user", "restart", unitName])
      },
    })
    await report(changed ? `Update complete.\nApplication: ${commit}\nOpenCode: ${version}\nTelegram connected.` : `Already up to date.\nApplication: ${commit}\nOpenCode: ${version}`, "done")
  } catch (error) {
    await report(`Update failed.\n${errorText(error, [config.token])}\nLog: ${log}`, "failed")
    process.exitCode = 1
  }
}

export async function markGatewayReady(version: string) {
  const state = { time: Date.now(), pid: process.pid, version, source: await realpath(sourceRoot()) }
  await writeFile(join(agentHome(), "gateway-ready.json"), JSON.stringify(state), { mode: 0o600 })
}
