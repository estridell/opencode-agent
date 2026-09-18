import type { Action, Store } from "./store"
import type { Telegram } from "./telegram"

type PickerState = { messageID: number; revision: number; closed: boolean }
export type Choice = { text: string; action: Action }

/** A Telegram picker uses one message for all pages and its final result. */
export class Pickers {
  constructor(readonly store: Store, readonly telegram: Telegram) {}

  async page(title: string, choices: Choice[], navigation: Action, pickerID?: string, empty?: string) {
    const size = 8
    const pages = Math.max(1, Math.ceil(choices.length / size))
    const page = Math.max(0, Math.min(navigation.page ?? 0, pages - 1))
    const rows: Choice[][] = choices.slice(page * size, (page + 1) * size)
      .map(choice => [{ ...choice, action: { ...choice.action, page } }])
    const nav: Choice[] = []
    if (page) nav.push({ text: "Previous", action: { ...navigation, page: page - 1 } })
    if (page + 1 < pages) nav.push({ text: "Next", action: { ...navigation, page: page + 1 } })
    if (nav.length) rows.push(nav)
    rows.push([{ text: "Cancel", action: { kind: "cancel", sessionID: navigation.sessionID } }])
    return this.show(!choices.length && empty ? empty : `${title} · ${page + 1}/${pages}`, rows, pickerID)
  }

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
