import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client"

type History = Pick<OpenCodeClient, "session" | "message">
export type RecallInput = { query?: string; sessionID?: string; cursor?: string }
type SearchCursor = { query: string; sessionID?: string; sessionCursor?: string; messageCursor?: string; nextSessionCursor?: string }

function textOf(message: SessionMessageInfo) {
  if (message.type === "user") return message.text
  if (message.type === "assistant") return message.content.filter(c => c.type === "text").map(c => c.text).join("\n")
  return ""
}

/** Search bounded pages through the public API. OpenCode remains the only transcript store. */
export async function recall(client: History, input: RecallInput) {
  if (input.sessionID) {
    const page = await client.message.list({ sessionID: input.sessionID, order: "desc", limit: 20, ...(input.cursor ? { cursor: input.cursor } : {}) })
    return {
      sessionID: input.sessionID,
      messages: page.data.map(m => ({ id: m.id, type: m.type, text: textOf(m).slice(0, 4000) })).filter(m => m.text),
      cursor: page.cursor.next ?? null,
      note: "Messages are newest first. Long messages are limited to 4000 characters.",
    }
  }
  if (!input.query?.trim()) {
    const page = await client.session.list({ parentID: null, order: "desc", limit: 20, ...(input.cursor ? { cursor: input.cursor } : {}) })
    return { sessions: page.data.map(s => ({ id: s.id, title: s.title, updated: s.time.updated })), cursor: page.cursor.next ?? null }
  }
  const query = input.query.trim().toLowerCase()
  if (query.length > 500) throw new Error("Use a search query of 500 characters or fewer.")
  let state: SearchCursor = { query }
  if (input.cursor) {
    try {
      if (input.cursor.length > 4096) throw new Error()
      const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))
      if (!parsed || typeof parsed !== "object" || parsed.query !== query || Object.values(parsed).some(value => typeof value !== "string")) throw new Error()
      state = parsed
    } catch { throw new Error("Invalid search cursor. Use the same query with the returned cursor.") }
  }
  const terms = query.split(/\s+/)
  const matches: { sessionID: string; messageID: string; role: string; text: string }[] = []
  let done = false
  let scanned = 0
  for (let pageCount = 0; pageCount < 5; pageCount++) {
    if (!state.sessionID) {
      const page = await client.session.list({ parentID: null, order: "desc", limit: 1, ...(state.sessionCursor ? { cursor: state.sessionCursor } : {}) })
      const session = page.data[0]
      if (!session) { done = true; break }
      state.sessionID = session.id
      state.nextSessionCursor = page.cursor.next ?? undefined
    }
    const page = await client.message.list({ sessionID: state.sessionID, order: "desc", limit: 50, ...(state.messageCursor ? { cursor: state.messageCursor } : {}) })
    for (const message of page.data) {
      const text = textOf(message)
      scanned++
      const lower = text.toLowerCase()
      if (!terms.every(term => lower.includes(term))) continue
      const start = Math.max(0, lower.indexOf(terms[0]!) - 120)
      matches.push({ sessionID: state.sessionID, messageID: message.id, role: message.type, text: text.slice(start, start + 600) })
    }
    state.messageCursor = page.cursor.next ?? undefined
    if (!state.messageCursor) {
      state.sessionID = undefined
      state.sessionCursor = state.nextSessionCursor
      state.nextSessionCursor = undefined
      if (!state.sessionCursor) { done = true; break }
    }
    if (matches.length) break
  }
  return { matches, scanned, cursor: done ? null : Buffer.from(JSON.stringify(state)).toString("base64url"), note: "Search covers user and assistant text. Continue with the same query and cursor to search older messages." }
}
