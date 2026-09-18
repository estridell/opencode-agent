import { createHash } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, basename } from "node:path"

/** Keep incoming files on the agent machine so native tools can use every format. */
export async function cacheAttachment(home: string, name: string, bytes: Uint8Array) {
  name = basename(name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200)
  if (!name || name === "." || name === "..") name = "attachment.bin"
  const hash = createHash("sha256").update(bytes).digest("hex")
  const directory = join(home, "attachments", hash)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, name)
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  return path
}

/** Only standalone markers request a delivery. Ordinary paths and code examples remain text. */
export function responseAttachments(text: string): { text: string; paths: string[] } {
  const paths: string[] = []
  let fence: string | undefined
  const lines = text.split("\n").filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]![0]
      else if (marker[1]![0] === fence) fence = undefined
      return true
    }
    if (fence) return true
    const match = /^MEDIA:\s*(.+?)\s*$/.exec(line)
    if (!match) return true
    const path = match[1]!.replace(/^(["'])(.*)\1$/, "$2")
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) return true
    if (!paths.includes(path)) paths.push(path)
    return false
  })
  return { text: lines.join("\n").trim(), paths }
}
