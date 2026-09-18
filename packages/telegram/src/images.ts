import { Api, GrammyError } from "grammy"
import type { Message } from "grammy/types"
import type { SessionPromptInput } from "@opencode/client"

export const imageLimit = 20 * 1024 * 1024
const sizeError = "The attachment is too large. Send an attachment smaller than 20 MiB."
const formatError = "Unsupported image format. Send a PNG, JPEG, GIF, or WebP image."

export function imageType(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif"
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp"
}

/** Only image bytes and a display name reach OpenCode. Telegram download URLs contain the bot token. */
export class Images {
  fetchFile: typeof fetch = fetch
  constructor(readonly api: Api, readonly token: string) {}

  async attachment(message: Message): Promise<NonNullable<SessionPromptInput["files"]>[number]> {
    const { bytes, name } = await this.download(message)
    const mime = imageType(bytes)
    if (!mime) throw new Error(formatError)
    return { uri: `data:${mime};base64,${bytes.toString("base64")}`, name }
  }

  async download(message: Message): Promise<{ bytes: Buffer; name: string }> {
    const photo = message.photo?.reduce((best, item) => item.width * item.height > best.width * best.height ? item : best)
    const input = photo ?? message.document ?? message.voice
    if (!input) throw new Error("No attachment was found. Send a photo, document, or voice message.")
    if (input.file_size && input.file_size > imageLimit) throw new Error(sizeError)
    const file = await this.api.getFile(input.file_id).catch(error => {
      if (error instanceof GrammyError && /file is too big/i.test(error.description)) throw new Error(sizeError)
      throw error
    })
    if (file.file_size && file.file_size > imageLimit) throw new Error(sizeError)
    if (!file.file_path) throw new Error("Telegram did not provide an attachment download path. Send the attachment again.")
    let response: Response
    try {
      response = await this.fetchFile(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(30_000), redirect: "error",
      })
    } catch { throw new Error("Attachment download connection failed. The gateway will retry.") }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status >= 500 || response.status === 429) throw new Error("Attachment download connection failed. The gateway will retry.")
      throw new Error(`Attachment download failed: HTTP ${response.status}. Send the attachment again.`)
    }
    if (Number(response.headers.get("content-length")) > imageLimit) {
      await response.body?.cancel()
      throw new Error(sizeError)
    }
    if (!response.body) throw new Error("The attachment download is empty. Send the attachment again.")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > imageLimit) throw new Error(sizeError)
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof Error && error.message === sizeError) throw error
      throw new Error("Attachment download connection failed. The gateway will retry.")
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const bytes = Buffer.concat(chunks, length)
    const mime = imageType(bytes)
    const extension = mime === "image/jpeg" ? "jpg" : mime?.slice(6) ?? "bin"
    const name = photo ? `photo-${message.message_id}.${extension}`
      : message.document?.file_name?.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || (message.voice ? `voice-${message.message_id}.ogg` : `image-${message.message_id}.${extension}`)
    return { bytes, name: name === "." || name === ".." ? "attachment.bin" : name }
  }
}
