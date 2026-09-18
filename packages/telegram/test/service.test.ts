import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { serviceUnit, verifyService } from "../src/service"

// Use systemd's parser to test the complete file, not only our escape function.
const available = process.platform === "linux" && !!Bun.which("systemd-analyze")

test.skipIf(!available)("systemd accepts the generated unit with spaces and percent signs in its paths", async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  const temporary = await mkdtemp("/tmp/opencode/agent-service-test-")
  try {
    const home = join(temporary, "agent home %test")
    await mkdir(home)
    const file = join(temporary, "opencode-agent-test.service")
    await writeFile(file, serviceUnit(process.execPath, join(temporary, "main.ts"), home, "/usr/bin:/bin"))
    await verifyService(file)
    // Check that the verifier detects the actual failure from the first installer.
    await writeFile(file, `[Service]\nExecStart=/usr/bin/true\nWorkingDirectory="${home}"\n`)
    await expect(verifyService(file)).rejects.toThrow("path is not absolute")
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
