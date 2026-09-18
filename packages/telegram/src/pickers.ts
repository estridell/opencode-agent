import type { Action, Store } from "./store"
import type { Telegram } from "./telegram"

type PickerState = { messageID: number; revision: number; closed: boolean }
export type Choice = { text: string; action: Action }

/** A Telegram picker uses one message for all pages and its final result. */
export class Pickers {
  constructor(readonly store: Store, readonly telegram: Telegram) {}

  current(action: Action, messageID?: number): boolean {
    if (!action.pickerID) return false
    const state = this.store.get<PickerState>(`picker:${action.pickerID}`)
    return !!state && !state.closed && state.revision === action.revision
      && (messageID === undefined || state.messageID === messageID)
  }

  async show(text: string, rows: Choice[][], pickerID: string = crypto.randomUUID()): Promise<string> {
    const previous = this.store.get<PickerState>(`picker:${pickerID}`)
    const revision = (previous?.revision ?? 0) + 1
    const keyboard = rows.map(row => row.map(choice => ({
      text: choice.text.slice(0, 60),
      callback_data: this.store.button({ ...choice.action, pickerID, revision }),
    })))
    let messageID = previous?.messageID
    if (messageID) await this.telegram.edit(messageID, text, keyboard, true)
    else messageID = await this.telegram.send(text, keyboard, `picker:${pickerID}`)
    this.store.set(`picker:${pickerID}`, { messageID, revision, closed: rows.length === 0 } satisfies PickerState)
    return pickerID
  }

  async finish(pickerID: string, text: string) {
    await this.show(text, [], pickerID)
  }
}
