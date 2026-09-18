import { readFile, rename, rm, writeFile } from "node:fs/promises"

export async function optionalText(path: string) {
  return readFile(path, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  })
}

/** Replace a complete file through a private temporary file in the same directory. */
export async function writeAtomic(path: string, text: string, mode = 0o600) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
