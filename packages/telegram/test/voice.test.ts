import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defaultVoiceSettings, prepareVoice, transcribeVoice } from "../src/voice"

async function temporaryHome() {
  await mkdir("/tmp/opencode", { recursive: true })
  return mkdtemp("/tmp/opencode/agent-voice-test-")
}

async function fakePython(home: string, body: string) {
  const binary = join(home, "voice", "venv", "bin", "python")
  await mkdir(join(binary, ".."), { recursive: true })
  await writeFile(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 })
  await chmod(binary, 0o700)
  return binary
}

test("voice defaults select the English CPU profile", () => {
  expect(defaultVoiceSettings).toEqual({
    enabled: true,
    model: "tiny.en",
    language: "en",
    threads: 4,
    timeoutSeconds: 120,
  })
})

test("voice preparation installs the pinned decoder and prepares the selected model", async () => {
  const home = await temporaryHome()
  const log = join(home, "calls.jsonl")
  try {
    await fakePython(home, `
import { appendFile } from "node:fs/promises"
const args = Bun.argv.slice(2)
await appendFile(${JSON.stringify(log)}, JSON.stringify({ args, env: {
  HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  HF_HOME: process.env.HF_HOME, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS,
} }) + "\\n")
if (args[0] === "-c") process.exit(1)
`)
    await prepareVoice(home, { model: "base.en", language: "en", threads: 2, timeoutSeconds: 5 })
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(calls).toHaveLength(3)
    expect(calls[1].args).toContain("faster-whisper==1.2.1")
    expect(calls[2].args.slice(-5)).toEqual(["prepare", "base.en", "en", "2", join(home, "voice", "models")])
    expect(calls[2].env).toEqual({
      HOME: join(home, "voice", "home"),
      XDG_CACHE_HOME: join(home, "voice", "cache"),
      HF_HOME: join(home, "voice", "cache", "huggingface"),
      OMP_NUM_THREADS: "2",
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("voice transcription passes paths as arguments and returns trimmed text", async () => {
  const home = await temporaryHome()
  const log = join(home, "call.json")
  const audio = join(home, "voice note;$(invalid).ogg")
  try {
    await writeFile(audio, "audio")
    await fakePython(home, `
const args = Bun.argv.slice(2)
await Bun.write(${JSON.stringify(log)}, JSON.stringify(args))
console.log("  Local transcript.  ")
`)
    const text = await transcribeVoice(home, audio, { model: "tiny.en", language: "en", threads: 3, timeoutSeconds: 5 })
    expect(text).toBe("Local transcript.")
    const args = JSON.parse(await readFile(log, "utf8"))
    expect(args.slice(-6)).toEqual(["transcribe", "tiny.en", "en", "3", join(home, "voice", "models"), audio])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("voice transcription stops a process after its timeout", async () => {
  const home = await temporaryHome()
  const audio = join(home, "voice.ogg")
  try {
    await writeFile(audio, "audio")
    await fakePython(home, "await Bun.sleep(30_000)\n")
    const started = Date.now()
    await expect(transcribeVoice(home, audio, { timeoutSeconds: 1 })).rejects.toThrow("timed out after 1 second")
    expect(Date.now() - started).toBeLessThan(3000)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("voice transcription stops output above its limit", async () => {
  const home = await temporaryHome()
  const audio = join(home, "voice.ogg")
  try {
    await writeFile(audio, "audio")
    await fakePython(home, "console.log('x'.repeat(1024 * 1024 + 1))\n")
    await expect(transcribeVoice(home, audio, { timeoutSeconds: 5 })).rejects.toThrow("output exceeded its limit")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("gateway cancellation terminates voice decoding before its normal timeout", async () => {
  const home = await temporaryHome()
  const audio = join(home, "voice.ogg")
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await writeFile(audio, "audio")
    await fakePython(home, "await Bun.sleep(30_000)\n")
    const started = Date.now()
    const work = transcribeVoice(home, audio, { timeoutSeconds: 30 }, controller.signal)
    timer = setTimeout(() => controller.abort(), 100)
    await expect(work).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
  } finally {
    if (timer) clearTimeout(timer)
    await rm(home, { recursive: true, force: true })
  }
})

test("voice settings reject unbounded resource values", async () => {
  await expect(prepareVoice("/unused", { threads: 0 })).rejects.toThrow("Voice threads")
  await expect(prepareVoice("/unused", { timeoutSeconds: 3601 })).rejects.toThrow("Voice timeout")
  await expect(prepareVoice("/unused", { language: "bad language" })).rejects.toThrow("Voice language")
})

test("disabled voice preparation does not create files", async () => {
  const home = await temporaryHome()
  try {
    await prepareVoice(home, { enabled: false })
    expect(await Bun.file(join(home, "voice")).exists()).toBe(false)
  } finally { await rm(home, { recursive: true, force: true }) }
})
