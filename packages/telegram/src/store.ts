import { Database } from "bun:sqlite"

export type TrackedSession = { id: string; title: string; created: number; parentID?: string; missing?: boolean }
export type Action = {
  kind: string; sessionID: string; id?: string; value?: string; page?: number; field?: string
  pickerID?: string; revision?: number; search?: string
}

/** Integration state only. OpenCode remains the source of truth for sessions. */
export class Store {
  readonly db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (key TEXT PRIMARY KEY, message_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (token TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL);
    `)
  }
  get<T>(key: string): T | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key)
    return row ? JSON.parse(row.value) as T : undefined
  }
  set(key: string, value: unknown) {
    this.db.query("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(key, JSON.stringify(value))
  }
  delete(key: string) { this.db.query("DELETE FROM kv WHERE key = ?").run(key) }
  sessions(): TrackedSession[] {
    return this.db.query<{ value: string }, []>("SELECT value FROM sessions ORDER BY rowid DESC").all().map(r => JSON.parse(r.value))
  }
  track(session: TrackedSession) {
    this.db.query("INSERT INTO sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(session.id, JSON.stringify(session))
  }
  sent(key: string): number | undefined {
    return this.db.query<{ message_id: number }, [string]>("SELECT message_id FROM deliveries WHERE key = ?").get(key)?.message_id
  }
  delivered(key: string, messageID: number) {
    this.db.query("INSERT OR REPLACE INTO deliveries VALUES (?, ?)").run(key, messageID)
  }
  button(action: Action): string {
    const token = crypto.randomUUID().replaceAll("-", "")
    this.db.query("INSERT INTO actions VALUES (?, ?, ?)").run(token, JSON.stringify(action), Date.now())
    return `a:${token}`
  }
  action(token: string): Action | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM actions WHERE token = ?").get(token.replace(/^a:/, ""))
    return row ? JSON.parse(row.value) as Action : undefined
  }
  pruneActions() {
    this.db.query("DELETE FROM actions WHERE created < ? AND json_extract(value, '$.kind') != 'permission' AND json_extract(value, '$.kind') NOT LIKE 'form-%'").run(Date.now() - 30 * 86400_000)
  }
  close() { this.db.close() }
}
