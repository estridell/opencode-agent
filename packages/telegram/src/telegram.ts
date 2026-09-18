import { Api, GrammyError, InputFile } from "grammy"
import { stat } from "node:fs/promises"
import { basename, extname } from "node:path"
import type { InlineKeyboardMarkup } from "grammy/types"
import { setTimeout as sleep } from "node:timers/promises"
import { formatText } from "./format"
import type { Store } from "./store"

export type Keyboard = InlineKeyboardMarkup["inline_keyboard"]

export class Telegram {
  private tail: Promise<unknown> = Promise.resolve()
  private last = 0
  private lastTyping = 0
  constructor(readonly api: Api, readonly chatID: number, readonly store: Store, readonly spacing = 1050) {}

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await sleep(Math.max(0, this.last + this.spacing - Date.now()))
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await work() }
          catch (error) {
            if (!(error instanceof GrammyError) || !error.parameters.retry_after || attempt >= 3) throw error
            await sleep(error.parameters.retry_after * 1000)
          }
        }
      } finally { this.last = Date.now() }
    })
    this.tail = result.catch(() => {})
    return result
  }

  async send(text: string, keyboard?: Keyboard, key?: string, quiet = false, statusKey?: string): Promise<number> {
    let id = 0
    const chunks = formatText(text)
    for (const [index, chunk] of chunks.entries()) {
      const partKey = key ? `${key}:${index}` : undefined
      id = await this.queued(async () => {
        const delivered = (messageID: number) => {
          if (partKey) this.store.delivered(partKey, messageID)
          if (index === 0 && statusKey) this.store.delete(statusKey)
          return messageID
        }
        const sent = partKey && this.store.sent(partKey)
        if (sent) {
          if (index === 0 && statusKey && this.store.get<{ id: number }>(statusKey)?.id === sent) this.store.delete(statusKey)
          return sent
        }
        const replaceID = index === 0 && statusKey ? this.store.get<{ id: number }>(statusKey)?.id : undefined
        if (index === 0 && replaceID) {
          try {
            await this.api.editMessageText(this.chatID, replaceID, chunk.text, {
              entities: chunk.entities, link_preview_options: { is_disabled: true },
              reply_markup: { inline_keyboard: chunks.length === 1 ? keyboard ?? [] : [] },
            })
            return delivered(replaceID)
          } catch (error) {
            if (error instanceof GrammyError && /message is not modified/i.test(error.description)) {
              return delivered(replaceID)
            }
            if (!(error instanceof GrammyError) || !/message to edit not found|message can't be edited/i.test(error.description)) throw error
          }
        }
        const message = await this.api.sendMessage(this.chatID, chunk.text, {
          entities: chunk.entities,
          disable_notification: quiet,
          link_preview_options: { is_disabled: true },
          reply_markup: index === chunks.length - 1 && keyboard ? { inline_keyboard: keyboard } : undefined,
        })
        return delivered(message.message_id)
      })
    }
    return id
  }

  async file(path: string, key: string): Promise<number> {
    const sent = this.store.sent(key)
    if (sent) return sent
    const info = await stat(path).catch(error => {
      if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined
      throw error
    })
    if (!info?.isFile() || !info.size || info.size > 50 * 1024 * 1024) {
      const id = await this.send(`Cannot attach ${basename(path)}. The file must exist and contain between 1 byte and 50 MiB.`, undefined, key)
      this.store.delivered(key, id)
      return id
    }
    return this.queued(async () => {
      const delivered = this.store.sent(key)
      if (delivered) return delivered
      const file = new InputFile(path)
      const photo = [".png", ".jpg", ".jpeg"].includes(extname(path).toLowerCase()) && info.size <= 10 * 1024 * 1024
      let message
      try {
        message = photo ? await this.api.sendPhoto(this.chatID, file) : await this.api.sendDocument(this.chatID, file)
      } catch (error) {
        // A valid file can still exceed Telegram's photo dimensions. Deliver it as a document.
        if (!photo || !(error instanceof GrammyError) || error.error_code !== 400) throw error
        message = await this.api.sendDocument(this.chatID, new InputFile(path))
      }
      this.store.delivered(key, message.message_id)
      return message.message_id
    })
  }

  async status(sessionID: string, text: string) {
    const key = `progress:${sessionID}`
    if (this.store.get<{ text: string }>(key)?.text === text) return
    await this.queued(async () => {
      const current = this.store.get<{ id: number; text: string }>(key)
      if (current?.text === text) return
      let id = current?.id
      if (id) {
        try { await this.api.editMessageText(this.chatID, id, text, { reply_markup: { inline_keyboard: [] } }) }
        catch (error) {
          if (error instanceof GrammyError && /message is not modified/i.test(error.description)) { /* Already current. */ }
          else if (error instanceof GrammyError && /message to edit not found|message can't be edited/i.test(error.description)) id = undefined
          else throw error
        }
      }
      id ??= (await this.api.sendMessage(this.chatID, text, { disable_notification: true })).message_id
      this.store.set(key, { id, text })
    })
  }

  async finish(sessionID: string, text: string, key: string, keyboard?: Keyboard) {
    await this.send(text, keyboard, key, false, `progress:${sessionID}`)
  }

  async edit(messageID: number, text: string, keyboard: Keyboard = [], strict = false) {
    const chunk = formatText(text)[0]
    if (!chunk) return
    await this.queued(async () => {
      try {
        await this.api.editMessageText(this.chatID, messageID, chunk.text, {
          entities: chunk.entities, reply_markup: { inline_keyboard: keyboard }, link_preview_options: { is_disabled: true },
        })
      } catch (error) {
        if (error instanceof GrammyError && /message is not modified/i.test(error.description)) return
        if (!strict && error instanceof GrammyError && /message to edit not found|message can't be edited/i.test(error.description)) return
        throw error
      }
    })
  }

  async typing() {
    if (Date.now() - this.lastTyping < 4000) return
    this.lastTyping = Date.now()
    // A temporary typing indicator must not delay responses or input processing.
    await this.api.sendChatAction(this.chatID, "typing").catch(() => {})
  }
}
