import { expect, test } from "bun:test"
import { recall } from "../src/recall"

function history() {
  const calls: { sessionID: string; cursor?: string }[] = []
  const sessions = ["recent", "older"]
  const client = {
    session: {
      async list({ cursor }: { cursor?: string }) {
        const index = Number(cursor ?? 0)
        return { data: sessions[index] ? [{ id: sessions[index], title: sessions[index], time: { updated: index } }] : [], cursor: { next: index === 0 ? "1" : null } }
      },
    },
    message: {
      async list(input: { sessionID: string; cursor?: string }) {
        calls.push(input)
        const index = Number(input.cursor ?? 0)
        if (input.sessionID === "recent") return { data: [{ id: `recent-${index}`, type: "user", text: "Unrelated recent message" }], cursor: { next: index < 5 ? String(index + 1) : null } }
        return { data: [{ id: "old-user", type: "user", text: "The booking reference was XY123." }, { id: "old-assistant", type: "assistant", content: [{ type: "text", text: "I saved booking XY123 in the report." }] }], cursor: {} }
      },
    },
  } as unknown as Parameters<typeof recall>[0]
  return { client, calls }
}

test("bounded recall continues into older sessions through native API cursors", async () => {
  const f = history()
  const first = await recall(f.client, { query: "booking xy123" })
  expect("matches" in first && first.matches).toEqual([])
  expect(first.cursor).toBeString()
  expect(f.calls).toHaveLength(5)
  const second = await recall(f.client, { query: "booking xy123", cursor: first.cursor! })
  expect("matches" in second && second.matches?.map(m => m.messageID)).toEqual(["old-user", "old-assistant"])
  expect(second.cursor).toBeNull()
  expect(f.calls[5]).toMatchObject({ sessionID: "recent", cursor: "5" })
  expect(f.calls[6]).toMatchObject({ sessionID: "older" })
})

test("recall reads user and assistant text and rejects a mismatched search cursor", async () => {
  const f = history()
  const read = await recall(f.client, { sessionID: "older" })
  expect("messages" in read && read.messages?.map(m => m.text)).toEqual(["The booking reference was XY123.", "I saved booking XY123 in the report."])
  const search = await recall(f.client, { query: "booking" })
  await expect(recall(f.client, { query: "different", cursor: search.cursor! })).rejects.toThrow("Invalid search cursor")
})
