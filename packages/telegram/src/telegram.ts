import { Api, GrammyError } from "grammy"
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

  async send(text: string, keyboard?: Keyboard, key?: string, quiet = false): Promise<number> {
    let id = 0
    const chunks = formatText(text)
    for (const [index, chunk] of chunks.entries()) {
      const partKey = key ? `${key}:${index}` : undefined
      id = await this.queued(async () => {
        const sent = partKey && this.store.sent(partKey)
        if (sent) return sent
        const message = await this.api.sendMessage(this.chatID, chunk.text, {
          entities: chunk.entities,
          disable_notification: quiet,
          link_preview_options: { is_disabled: true },
          reply_markup: index === chunks.length - 1 && keyboard ? { inline_keyboard: keyboard } : undefined,
        })
        if (partKey) this.store.delivered(partKey, message.message_id)
        return message.message_id
      })
    }
    return id
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
