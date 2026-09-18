import { constants } from "node:fs"
import { access, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type VoiceSettings = {
  enabled: boolean
  model: string
  language: string
  threads: number
  timeoutSeconds: number
}

export const defaultVoiceSettings: Readonly<VoiceSettings> = Object.freeze({
  enabled: true,
  model: "tiny.en",
  language: "en",
  threads: 4,
  timeoutSeconds: 120,
})

const fasterWhisperVersion = "1.2.1"
const script = fileURLToPath(new URL("../assets/transcribe.py", import.meta.url))
const stdoutLimit = 1024 * 1024
const stderrLimit = 64 * 1024

export function parseVoiceSettings(input: Partial<VoiceSettings> = {}): VoiceSettings {
  const value = { ...defaultVoiceSettings, ...input }
  if (typeof value.enabled !== "boolean") throw new Error("Voice enabled must be true or false.")
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 500 || /[\x00-\x1f\x7f]/.test(value.model)) {
    throw new Error("Voice model must be a valid model name or path.")
  }
  if (typeof value.language !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(value.language)) {
    throw new Error("Voice language must be a valid language code.")
  }
  if (!Number.isInteger(value.threads) || value.threads < 1 || value.threads > 64) {
    throw new Error("Voice threads must be an integer from 1 through 64.")
  }
  if (!Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 3600) {
    throw new Error("Voice timeout must be an integer from 1 through 3600 seconds.")
  }
  return value
}

const voiceRoot = (home: string) => join(home, "voice")
const venvRoot = (home: string) => join(voiceRoot(home), "venv")
const pythonPath = (home: string) => join(venvRoot(home), "bin", "python")
const modelRoot = (home: string) => join(voiceRoot(home), "models")

function voiceEnv(home: string, threads: number): Record<string, string> {
  const root = voiceRoot(home)
  const env: Record<string, string> = {}
  for (const key of ["LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"]) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return {
    ...env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    HF_HOME: join(root, "cache", "huggingface"),
    TMPDIR: join(root, "tmp"),
    PATH: `${join(venvRoot(home), "bin")}:/usr/bin:/bin`,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_PROGRESS_BAR: "off",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TOKENIZERS_PARALLELISM: "false",
    OMP_NUM_THREADS: String(threads),
    MKL_NUM_THREADS: String(threads),
  }
}

type Captured = { text: string; truncated: boolean; failed: boolean }

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, stop: () => void): Promise<Captured> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let length = 0
  let truncated = false
  let failed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - length
      if (value.length > remaining) {
        if (remaining > 0) { chunks.push(Buffer.from(value.subarray(0, remaining))); length += remaining }
        truncated = true
        stop()
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(Buffer.from(value))
      length += value.length
    }
  } catch {
    failed = true
  } finally {
    reader.releaseLock()
  }
  return { text: Buffer.concat(chunks, length).toString("utf8"), truncated, failed }
}

async function run(args: string[], env: Record<string, string>, cwd: string, timeoutSeconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  let child
  try {
    child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    throw new Error("Voice process could not start.", { cause: error })
  }
  let timedOut = false
  let stopping = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (stopping) return
    stopping = true
    try { child.kill("SIGTERM") } catch {}
    forceKill = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 1000)
  }
  const timeout = setTimeout(() => { timedOut = true; stop() }, timeoutSeconds * 1000)
  const abort = () => stop()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) stop()
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, stdoutLimit, stop),
      readBounded(child.stderr, stderrLimit, stop),
    ])
    if (signal?.aborted) throw new Error("Voice transcription was cancelled.")
    if (timedOut) throw new Error(`Voice process timed out after ${timeoutSeconds} ${timeoutSeconds === 1 ? "second" : "seconds"}.`)
    if (stdout.truncated || stderr.truncated) throw new Error("Voice process output exceeded its limit.")
    if (stdout.failed || stderr.failed) throw new Error("Voice process output could not be read.")
    return { code, stdout: stdout.text, stderr: stderr.text }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
    if (forceKill) clearTimeout(forceKill)
  }
}

async function checkedRun(args: string[], env: Record<string, string>, cwd: string, timeoutSeconds: number, label: string, signal?: AbortSignal) {
  const result = await run(args, env, cwd, timeoutSeconds, signal)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-2000)
    throw new Error(`${label} failed.${detail ? `\n${detail}` : ""}`)
  }
  return result.stdout
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true }
  catch { return false }
}

/** Install the local decoder and download the selected model. */
export async function prepareVoice(home: string, input: Partial<VoiceSettings> = {}): Promise<void> {
  const value = parseVoiceSettings(input)
  if (!value.enabled) return
  const root = voiceRoot(home)
  const preparationTimeout = Math.max(600, value.timeoutSeconds)
  const env = voiceEnv(home, value.threads)
  for (const path of [root, env.HOME!, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_STATE_HOME!, env.XDG_CACHE_HOME!, env.HF_HOME!, env.TMPDIR!, modelRoot(home)]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }

  const python = pythonPath(home)
  if (!await executable(python)) {
    const systemPython = Bun.which("python3")
    if (!systemPython) throw new Error("Python 3.9 or later is required for voice transcription.")
    const version = await run([systemPython, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"], env, root, value.timeoutSeconds)
    if (version.code !== 0) throw new Error("Python 3.9 or later is required for voice transcription.")
    await checkedRun([systemPython, "-m", "venv", venvRoot(home)], env, root, value.timeoutSeconds, "Voice environment creation")
  }

  const installed = await run([
    python, "-c", "import importlib.metadata as m; print(m.version('faster-whisper'))",
  ], env, root, value.timeoutSeconds)
  if (installed.code !== 0 || installed.stdout.trim() !== fasterWhisperVersion) {
    await checkedRun([
      python, "-m", "pip", "install", "--no-input", "--disable-pip-version-check", `faster-whisper==${fasterWhisperVersion}`,
    ], env, root, preparationTimeout, "Voice dependency installation")
  }
  await checkedRun([
    python, script, "prepare", value.model, value.language, String(value.threads), modelRoot(home),
  ], env, root, preparationTimeout, "Voice model preparation")
}

/** Transcribe one audio file with the prepared local decoder. */
export async function transcribeVoice(home: string, path: string, input: Partial<VoiceSettings> = {}, signal?: AbortSignal): Promise<string> {
  const value = parseVoiceSettings(input)
  if (!value.enabled) throw new Error("Voice transcription is disabled.")
  const python = pythonPath(home)
  if (!await executable(python)) throw new Error("Voice transcription is not prepared. Run setup.")
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) throw new Error("The voice file is missing.")
  const root = voiceRoot(home)
  const output = await checkedRun([
    python, script, "transcribe", value.model, value.language, String(value.threads), modelRoot(home), path,
  ], voiceEnv(home, value.threads), root, value.timeoutSeconds, "Voice transcription", signal)
  return output.trim()
}
