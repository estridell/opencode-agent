import type { FormAnswer, FormField, FormInfo } from "@opencode/client"
import type { Client } from "./opencode"
import { isNotFound } from "./opencode"
import { errorText } from "./config"
import type { Action, Store } from "./store"
import type { Keyboard, Telegram } from "./telegram"

type Progress = { answer: FormAnswer; skipped: string[]; field?: string; messageID?: number; revision: number }

export function visible(field: FormField, answer: FormAnswer): boolean {
  if (field.type === "external") return true
  return !field.hidden && (field.when ?? []).every(condition =>
    condition.op === "eq" ? answer[condition.key] === condition.value : answer[condition.key] !== condition.value)
}

export function parseAnswer(field: FormField, text: string): FormAnswer[string] {
  if (field.type === "external") throw new Error("Use the link to complete this step.")
  if (field.type === "boolean") {
    if (/^(yes|true)$/i.test(text)) return true
    if (/^(no|false)$/i.test(text)) return false
    throw new Error("Answer yes or no.")
  }
  if (field.type === "number" || field.type === "integer") {
    const value = Number(text)
    if (!text.trim() || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) throw new Error(`Enter a valid ${field.type}.`)
    if (field.minimum !== undefined && value < Number(field.minimum)) throw new Error(`Minimum: ${field.minimum}`)
    if (field.maximum !== undefined && value > Number(field.maximum)) throw new Error(`Maximum: ${field.maximum}`)
    return value
  }
  if (field.type === "multiselect") {
    const values = [...new Set(text.split(",").map(s => s.trim()).filter(Boolean))]
    if (!field.custom && values.some(v => !field.options.some(o => o.value === v))) throw new Error("Use the choice buttons, then Done.")
    if (field.minItems !== undefined && values.length < field.minItems) throw new Error(`Select at least ${field.minItems}.`)
    if (field.maxItems !== undefined && values.length > field.maxItems) throw new Error(`Select at most ${field.maxItems}.`)
    return values
  }
  if (field.options?.length && !field.custom && !field.options.some(o => o.value === text)) throw new Error("Choose one of the listed options.")
  if (field.minLength !== undefined && text.length < field.minLength) throw new Error(`Minimum length: ${field.minLength}`)
  if (field.maxLength !== undefined && text.length > field.maxLength) throw new Error(`Maximum length: ${field.maxLength}`)
  return text
}

export class Forms {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly client: () => Client, readonly store: Store, readonly telegram: Telegram) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work)
    this.tail = next.catch(() => {})
    return next
  }
  progress(id: string): Progress { return this.store.get<Progress>(`form:${id}`) ?? { answer: {}, skipped: [], revision: 0 } }

  async present(form: FormInfo) {
    const p = this.progress(form.id)
    for (const f of form.fields) if (f.type !== "external" && f.hidden && f.default !== undefined) p.answer[f.key] = f.default
    const field = form.fields.find(f => visible(f, p.answer) && !(f.key in p.answer) && !p.skipped.includes(f.key))
    if (!field) {
      try {
        await this.client().session.form.reply({ sessionID: form.sessionID, formID: form.id, answer: p.answer })
        await this.settled(form.id, "Answered.")
      } catch (error) {
        if (isNotFound(error) || (error as { _tag?: string })._tag === "FormAlreadySettledError") return this.settled(form.id, "Resolved in OpenCode.")
        if ((error as { _tag?: string })._tag !== "FormInvalidAnswerError") throw error
        this.store.set(`form:${form.id}`, { answer: {}, skipped: [], revision: p.revision + 1 })
        await this.telegram.send(`OpenCode cannot accept that answer: ${errorText(error)}\nEnter the answer again.`)
      }
      return
    }
    if (p.field === field.key && p.messageID) return
    p.field = field.key
    p.revision++
    const keyboard: Keyboard = []
    const button = (label: string, kind: string, value?: string) => ({ text: label.slice(0, 60), callback_data: this.store.button({ kind, sessionID: form.sessionID, id: form.id, field: field.key, value }) })
    let text = `**${form.title}**\n\n${field.title ?? field.key}\n${field.description ?? ""}`
    if (field.type === "external") {
      if (/^https?:\/\//.test(field.url)) keyboard.push([{ text: "Open link", url: field.url }])
      text += `\n${field.url}`
      keyboard.push([button("Continue", "form-skip")])
    } else {
      if (field.type === "string" || field.type === "multiselect") {
        for (const option of (field.options ?? []).slice(0, 85)) {
          keyboard.push([button(option.label, field.type === "multiselect" ? "form-toggle" : "form-value", option.value)])
          if (option.description) text += `\n• ${option.label}: ${option.description}`
        }
        if (field.type === "multiselect") keyboard.push([button("Done", "form-done")])
      }
      if (field.type === "boolean") keyboard.push([button("Yes", "form-value", "yes"), button("No", "form-value", "no")])
      if (field.default !== undefined) keyboard.push([button("Use default", "form-default")])
      if (!field.required) keyboard.push([button("Skip", "form-skip")])
      text += "\n\nSelect a choice or reply to this message with your answer. Other messages give instructions to the current task."
    }
    keyboard.push([button("Cancel question", "form-cancel")])
    // Telegram permits at most 100 buttons; large forms can still be answered by text.
    p.messageID = await this.telegram.send(text, keyboard.slice(0, 98), `form:${form.id}:${p.revision}`)
    this.store.set(`form:${form.id}`, p)
    this.store.set(`form-reply:${p.messageID}`, { sessionID: form.sessionID, id: form.id, field: field.key })
    const pending = this.store.get<string[]>(`forms:${form.sessionID}`) ?? []
    this.store.set(`forms:${form.sessionID}`, [...new Set([...pending, form.id])])
  }

  async act(action: Action, text?: string) {
    return this.exclusive(() => this.answer(action, text))
  }

  private async answer(action: Action, text?: string) {
    if (!action.id) return
    const form = await this.client().session.form.get({ sessionID: action.sessionID, formID: action.id })
    if (form.state.status !== "pending") return this.settled(form.id, "Already resolved.")
    const p = this.progress(form.id)
    const field = form.fields.find(f => f.key === action.field)
    if (!field || p.field !== field.key) throw new Error("That question is no longer active. Use the latest question message.")
    if (action.kind === "form-cancel") {
      await this.client().session.form.cancel({ sessionID: form.sessionID, formID: form.id })
      return this.settled(form.id, "Cancelled.")
    }
    if (action.kind === "form-toggle" && field.type === "multiselect") {
      const selected = this.store.get<string[]>(`selected:${form.id}:${field.key}`) ?? []
      const value = action.value!
      if (!field.options.some(o => o.value === value)) throw new Error("Unknown choice.")
      const next = selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]
      this.store.set(`selected:${form.id}:${field.key}`, next)
      // Keep the original keyboard. The caller sends the selected values in a quiet message.
      return `Selected: ${next.map(v => field.options.find(o => o.value === v)?.label ?? v).join(", ") || "none"}`
    }
    if (action.kind === "form-skip") {
      if (field.type !== "external" && field.required) throw new Error("This answer is required.")
      p.skipped.push(field.key)
    } else if (action.kind === "form-default" && field.type !== "external" && field.default !== undefined) {
      p.answer[field.key] = field.default
    } else if (action.kind === "form-done" && field.type === "multiselect") {
      const values = this.store.get<string[]>(`selected:${form.id}:${field.key}`) ?? []
      if (field.minItems !== undefined && values.length < field.minItems) throw new Error(`Select at least ${field.minItems}.`)
      if (field.maxItems !== undefined && values.length > field.maxItems) throw new Error(`Select at most ${field.maxItems}.`)
      p.answer[field.key] = values
    } else p.answer[field.key] = parseAnswer(field, text ?? action.value ?? "")
    const previous = p.messageID
    p.field = undefined
    p.messageID = undefined
    this.store.set(`form:${form.id}`, p)
    if (previous) await this.telegram.edit(previous, `${form.title}\n${field.title ?? field.key}\nAnswer recorded.`)
    await this.present(form)
  }

  async settled(id: string, text = "Resolved in OpenCode.") {
    const p = this.store.get<Progress>(`form:${id}`)
    if (!p) return
    if (p.messageID) await this.telegram.edit(p.messageID, text)
    this.store.delete(`form:${id}`)
  }

  async reconcile(sessionID: string) {
    return this.exclusive(async () => {
      // Read pending forms inside the interaction lock. An earlier callback can resolve a form.
      const forms = await this.client().session.form.list({ sessionID })
      const pending = forms.map(f => f.id)
      for (const id of this.store.get<string[]>(`forms:${sessionID}`) ?? []) if (!pending.includes(id)) await this.settled(id)
      for (const form of forms) await this.present(form)
      this.store.set(`forms:${sessionID}`, pending)
      return forms
    })
  }
}
