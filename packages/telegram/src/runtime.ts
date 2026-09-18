import { join } from "node:path"
import { mkdir, access } from "node:fs/promises"
import { createServer } from "node:net"
import { agentHome } from "./config"
import manifest from "../package.json"
import { installContextPlugin } from "./plugins"

export const upstreamVersion = manifest.dependencies["@opencode/client"]
export const runtimeHome = () => join(agentHome(), "runtime", "home")
export const upstreamBinary = () => join(runtimeHome(), ".opencode", "bin", "opencode")
export const registrationFile = () => join(agentHome(), "runtime", "state", "opencode", "service.json")
export const workspace = () => join(agentHome(), "workspace")

/** No host provider credentials, OPENCODE_* overrides, or existing HOME/XDG state leak into the owned runtime. */
export function runtimeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (source[key]) env[key] = source[key]!
  }
  const root = join(agentHome(), "runtime")
  return {
    ...env,
    HOME: runtimeHome(),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "run"),
    TMPDIR: join(root, "tmp"),
    PATH: `${join(runtimeHome(), ".opencode", "bin")}:${source.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  }
}

export async function prepareRuntime() {
  const env = runtimeEnv()
  for (const path of [agentHome(), workspace(), env.HOME!, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_STATE_HOME!, env.XDG_CACHE_HOME!, env.XDG_RUNTIME_DIR!, env.TMPDIR!]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
}

export async function requireRuntime() {
  await prepareRuntime()
  try { await access(upstreamBinary()) }
  catch { throw new Error("The separate OpenCode V2 runtime is missing. Run opencode-agent setup.") }
  await configureService()
  await installContextPlugin(runtimeEnv().XDG_CONFIG_HOME!)
}

async function configureService() {
  const env = runtimeEnv()
  if (await Bun.file(join(env.XDG_CONFIG_HOME!, "opencode", "service.json")).exists()) return
  // V2's managed-service default port is fixed, and service config does not accept zero.
  // Allocate a free loopback port once, then persist it using upstream's own CLI.
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a service port"))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
  const child = Bun.spawn([upstreamBinary(), "service", "set", "port", String(port)], { env, cwd: workspace(), stdout: "pipe", stderr: "pipe" })
  if (await child.exited !== 0) throw new Error("Cannot configure the separate OpenCode service port.")
}

export async function installRuntime() {
  await prepareRuntime()
  await downloadRuntime(upstreamVersion, runtimeHome())
  await configureService()
  console.log(`OpenCode V2 ${upstreamVersion} installed.`)
}

export async function downloadRuntime(version: string, home: string) {
  const env = runtimeEnv()
  await mkdir(home, { recursive: true, mode: 0o700 })
  // Download completely before executing; pin both the V2 installer and the requested V2 release.
  const response = await fetch("https://opencode.ai/v2/install", { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`OpenCode V2 installer download failed: HTTP ${response.status}`)
  const installer = join(home, "install-opencode.sh")
  await Bun.write(installer, await response.text())
  // The upstream installer reports any opencode on PATH as "Installed version".
  // Limit this install-only PATH to our binary and system utilities.
  const installEnv = { ...env, HOME: home, TMPDIR: home, PATH: `${join(home, ".opencode", "bin")}:/usr/bin:/bin` }
  const child = Bun.spawn(["bash", installer, "--version", version, "--no-modify-path"], {
    env: installEnv, cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    const log = join(home, "install-opencode.log")
    await Bun.write(log, stdout + stderr)
    throw new Error(`OpenCode V2 installation failed. Read the log: ${log}`)
  }
  const binary = join(home, ".opencode", "bin", "opencode")
  const check = Bun.spawn([binary, "--version"], { env, stdout: "pipe", stderr: "pipe" })
  const output = (await new Response(check.stdout).text()).trim()
  if (await check.exited !== 0 || !output.endsWith(`v${version}`) && !output.endsWith(` ${version}`)) throw new Error(`Unexpected OpenCode version: ${output}`)
  return binary
}

export async function runOpenCode(args: string[], directory = workspace()) {
  await requireRuntime()
  const child = Bun.spawn([upstreamBinary(), ...args], { cwd: directory, env: runtimeEnv(), stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return child.exited
}
