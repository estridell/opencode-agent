import assert from "node:assert/strict"
import { copyFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { Service } from "@opencode/client/service"
import { agentHome } from "../src/config"
import { connect } from "../src/opencode"
import { downloadRuntime, prepareRuntime, registrationFile, runtimeHome, upstreamBinary, upstreamVersion, workspace } from "../src/runtime"

if (!process.env.OPENCODE_AGENT_HOME?.startsWith("/tmp/opencode/") || await Bun.file(join(agentHome(), "config.json")).exists() || await Bun.file(upstreamBinary()).exists()) {
  throw new Error("Set OPENCODE_AGENT_HOME to a new temporary directory under /tmp/opencode.")
}

// Test a real binary replacement and persistent session data without model calls.
await prepareRuntime()
await downloadRuntime("2.0.7", runtimeHome())
let sessionID: string | undefined
try {
  const before = await connect()
  assert.equal((await before.server.info()).version, "2.0.7")
  sessionID = (await before.session.create({ title: "Runtime update test", location: { directory: workspace() } })).id
  const candidate = await downloadRuntime(upstreamVersion, join(agentHome(), "candidate"))
  await Service.stop({ file: registrationFile() })
  await copyFile(candidate, `${upstreamBinary()}.next`)
  await rename(`${upstreamBinary()}.next`, upstreamBinary())
  const after = await connect()
  assert.equal((await after.server.info()).version, upstreamVersion)
  assert.equal((await after.session.get({ sessionID })).title, "Runtime update test")
  await after.session.remove({ sessionID })
  console.log(`Runtime update passed: 2.0.7 to ${upstreamVersion}, with the saved session available after restart.`)
} finally {
  await Service.stop({ file: registrationFile() })
}
