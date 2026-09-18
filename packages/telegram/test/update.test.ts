import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { applyUpdate, command, releaseVersion } from "../src/update"

function steps(fail?: string) {
  const calls: string[] = []
  const step = (name: string) => async () => { calls.push(name); if (name === fail) throw new Error(`${name} failed`) }
  return { calls, prepare: step("prepare"), stop: step("stop"), activate: step("activate"), start: step("start"), verify: step("verify"), recover: step("recover") }
}

test("update preparation failures leave the running gateway intact", async () => {
  const plan = steps("prepare")
  await expect(applyUpdate(plan)).rejects.toThrow("prepare failed")
  expect(plan.calls).toEqual(["prepare"])
})

test("an unchanged release does not restart services", async () => {
  const plan = steps()
  expect(await applyUpdate({ ...plan, prepare: async () => false })).toBe(false)
  expect(plan.calls).toEqual([])
})

test("activation and connection failures attempt recovery and remain failures", async () => {
  for (const failure of ["stop", "activate", "start", "verify"]) {
    const plan = steps(failure)
    await expect(applyUpdate(plan)).rejects.toThrow(`${failure} failed`)
    expect(plan.calls.at(-1)).toBe("recover")
    expect(plan.calls.filter(c => c === "recover")).toHaveLength(1)
  }
  const plan = steps("verify")
  await expect(applyUpdate({ ...plan, recover: async () => { throw new Error("service unavailable") } })).rejects.toThrow("Restart also failed: service unavailable")
})

test("successful updates require the post-restart connection check", async () => {
  const plan = steps()
  expect(await applyUpdate(plan)).toBe(true)
  expect(plan.calls).toEqual(["prepare", "stop", "activate", "start", "verify"])
})

test("upstream update metadata must identify a V2 release", () => {
  expect(releaseVersion({ version: "2.0.9", metadata: { package: "@opencode/cli" } })).toBe("2.0.9")
  for (const value of [null, {}, { version: "1.2.3" }, { version: "latest" }, { version: "2.0.9; false" }]) {
    expect(() => releaseVersion(value)).toThrow("V2 version")
  }
})

test("installer switches the stable launcher without replacing local data or the source checkout", async () => {
  const temp = await mkdtemp("/tmp/opencode/agent-update-install-")
  const home = join(temp, "user home")
  const agent = join(home, ".opencode-agent")
  const bun = join(agent, "tools/bun/bin/bun")
  const installer = new URL("../../../install.sh", import.meta.url).pathname
  try {
    await mkdir(join(agent, "tools/bun/bin"), { recursive: true })
    // Keep this installer test offline. It still runs the real installer and launcher.
    await writeFile(bun, '#!/bin/bash\nif [[ "$1" == --version ]]; then echo 1.3.14; elif [[ "$1" != install ]]; then printf "%s\\n" "$1"; fi\n')
    await chmod(bun, 0o755)
    await writeFile(join(agent, "config.json"), "private configuration")
    for (const version of ["first checkout", "second checkout"]) {
      const source = join(temp, version)
      await mkdir(join(source, "packages/telegram/src"), { recursive: true })
      await writeFile(join(source, "packages/telegram/src/main.ts"), "// source\n")
      await command(["bash", installer, "--source", source, "--no-setup"], temp, { ...process.env, HOME: home, OPENCODE_AGENT_HOME: agent })
      expect(await readlink(join(agent, "current"))).toBe(source)
      expect(await command([join(home, ".local/bin/opencode-agent"), "--help"], temp)).toBe(join(agent, "current/packages/telegram/src/main.ts"))
      expect(await Bun.file(join(source, "packages/telegram/src/main.ts")).text()).toBe("// source\n")
    }
    expect(await Bun.file(join(agent, "config.json")).text()).toBe("private configuration")
  } finally { await rm(temp, { recursive: true, force: true }) }
})
