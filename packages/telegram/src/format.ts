import type { MessageEntity } from "grammy/types"

export type TextChunk = { text: string; entities: MessageEntity[] }

/** Telegram entities use UTF-16 offsets. Splitting happens after parsing, never inside a surrogate pair. */
export function formatText(source: string, limit = 3900): TextChunk[] {
  if (limit < 2) throw new Error("Text limit must be at least 2")
  source = source.toWellFormed()
  let text = ""
  const entities: MessageEntity[] = []
  const re = /```([^\n`]*)\n([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g
  let end = 0
  for (const match of source.matchAll(re)) {
    text += source.slice(end, match.index)
    const content = match[2] ?? match[3] ?? match[4] ?? ""
    const entity: MessageEntity = match[2] !== undefined
      ? { type: "pre", offset: text.length, length: content.length, language: match[1]?.trim() }
      : { type: match[3] !== undefined ? "code" : "bold", offset: text.length, length: content.length }
    if (content) entities.push(entity)
    text += content
    end = match.index + match[0].length
  }
  text += source.slice(end)
  const result: TextChunk[] = []
  for (let start = 0; start < text.length;) {
    let stop = Math.min(start + limit, text.length)
    if (stop < text.length && /[\uD800-\uDBFF]/.test(text[stop - 1]!)) stop--
    const chunkEntities = entities.flatMap(entity => {
      const left = Math.max(start, entity.offset)
      const right = Math.min(stop, entity.offset + entity.length)
      return right > left ? [{ ...entity, offset: left - start, length: right - left }] : []
    })
    result.push({ text: text.slice(start, stop), entities: chunkEntities })
    start = stop
  }
  return result
}
