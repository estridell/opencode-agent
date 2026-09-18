import { Database } from "bun:sqlite"
import { Cron } from "croner"
import type { ModelRef, SessionInfo } from "@opencode/client"
import { join } from "node:path"
import { agentHome } from "./config"

export type Schedule = { at: string } | { cron: string }
export type Job = {
  id: string; name: string; prompt: string; schedule: Schedule; timezone: string; directory: string
  model?: ModelRef; agent?: string; enabled: boolean; nextAt: number | null
  revision?: number
  last?: { at: number; state: "missed" | "skipped" | "submitted" | "failed"; sessionID?: string; error?: string }
}
export type ScheduledRun = { id: string; sessionID: string; due: number; job: Job }
export type JobInput = Pick<Job, "name" | "prompt" | "schedule" | "timezone" | "directory" | "model" | "agent">

export function nextRun(schedule: Schedule, timezone: string, after: number): number | null {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }) }
  catch { throw new Error("Supply an IANA timezone name.") }
  if ("at" in schedule) {
    const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.exec(schedule.at)
    if (!parts) throw new Error("Supply an ISO date with a timezone offset for at.")
    const [year, month, day, hour, minute, second] = parts.slice(1).map(value => Number(value ?? 0)) as [number, number, number, number, number, number]
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59) throw new Error("Invalid scheduled date.")
    const value = Date.parse(schedule.at)
    if (!Number.isFinite(value)) throw new Error("Invalid scheduled date.")
    return value > after ? value : null
  }
  if (typeof schedule.cron !== "string" || schedule.cron.trim().split(/\s+/).length !== 5) throw new Error("Use a five-field cron expression: minute hour day month weekday.")
  try {
    const cron = new Cron(schedule.cron, { timezone, paused: true })
    // During a repeated DST hour, Croner can resolve a wall time into the past.
    // Advance through that repeated hour; a returned occurrence must be in the future.
    for (let minutes = 0; minutes <= 180; minutes++) {
      const next = cron.nextRun(new Date(after + minutes * 60_000))?.getTime()
      if (next === undefined) return null
      if (next > after) return next
    }
    throw new Error("No future occurrence after the timezone transition.")
  }
  catch { throw new Error("Invalid cron expression or timezone.") }
}

function validate(input: JobInput, now: number): JobInput {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new Error("Supply a task name of 1 to 200 characters.")
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32_000) throw new Error("Supply task instructions of 1 to 32000 characters.")
  if (!input.directory.startsWith("/")) throw new Error("The task directory must be absolute.")
  if (!input.schedule || typeof input.schedule !== "object" || ("at" in input.schedule) === ("cron" in input.schedule)) throw new Error("Supply either at or cron for the schedule.")
  if (nextRun(input.schedule, input.timezone, now) === null) throw new Error("The schedule must have a future run.")
  return input
}

/** This database owns schedules only. OpenCode owns all execution and session history. */
export class Schedules {
  readonly db: Database
  constructor(path = join(agentHome(), "schedules.sqlite")) {
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;")
    this.db.exec("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL);")
  }
  list(): Job[] { return this.db.query<{ value: string }, []>("SELECT value FROM jobs ORDER BY rowid").all().map(row => JSON.parse(row.value)) }
  get(id: string): Job {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM jobs WHERE id = ?").get(id)
    if (!row) throw new Error("Scheduled task not found.")
    return JSON.parse(row.value)
  }
  private save(job: Job) { this.db.query("INSERT OR REPLACE INTO jobs VALUES (?, ?)").run(job.id, JSON.stringify(job)) }
  create(input: JobInput, now = Date.now()): Job {
    validate(input, now)
    const job: Job = { ...input, id: crypto.randomUUID().replaceAll("-", ""), revision: 1, enabled: true, nextAt: nextRun(input.schedule, input.timezone, now) }
    this.save(job)
    return job
  }
  update(id: string, patch: Partial<Pick<JobInput, "name" | "prompt" | "schedule" | "timezone">>, now = Date.now()): Job {
    return this.db.transaction(() => {
      const job = this.get(id)
      const updated = { ...job, ...patch, revision: (job.revision ?? 0) + 1 }
      if (!updated.name?.trim() || !updated.prompt?.trim() || updated.name.length > 200 || updated.prompt.length > 32000) throw new Error("Supply a name of 1 to 200 characters and instructions of 1 to 32000 characters.")
      if (patch.schedule || patch.timezone) {
        validate(updated, now)
        updated.nextAt = updated.enabled ? nextRun(updated.schedule, updated.timezone, now) : null
      }
      this.save(updated)
      this.cancelPending(id)
      return updated
    }).immediate()
  }
  enable(id: string, enabled: boolean, now = Date.now()): Job {
    return this.db.transaction(() => {
      const job = this.get(id)
      job.nextAt = enabled ? nextRun(job.schedule, job.timezone, now) : null
      if (enabled && job.nextAt === null) throw new Error("Set a future date before resuming this task.")
      job.enabled = enabled
      job.revision = (job.revision ?? 0) + 1
      this.save(job)
      this.cancelPending(id)
      return job
    }).immediate()
  }
  remove(id: string) {
    this.db.transaction(() => {
      this.get(id)
      this.db.query("DELETE FROM jobs WHERE id = ?").run(id)
      this.cancelPending(id)
    }).immediate()
  }
  private cancelPending(id: string) { this.db.query("DELETE FROM runs WHERE json_extract(value, '$.job.id') = ?").run(id) }
  current(run: ScheduledRun): boolean {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM jobs WHERE id = ?").get(run.job.id)
    return !!row && (JSON.parse(row.value) as Job).revision === run.job.revision && !!this.db.query("SELECT id FROM runs WHERE id = ?").get(run.id)
  }
  /** On startup or re-enable, advance all overdue schedules without submitting their work. */
  skipMissed(now = Date.now()) {
    this.db.transaction(() => {
      for (const job of this.list()) {
        if (!job.enabled || job.nextAt === null || job.nextAt > now) continue
        job.last = { at: job.nextAt, state: "missed", ...(job.last?.sessionID ? { sessionID: job.last.sessionID } : {}) }
        job.nextAt = "cron" in job.schedule ? nextRun(job.schedule, job.timezone, now) : null
        if (job.nextAt === null) job.enabled = false
        this.save(job)
      }
    }).immediate()
  }
  claim(now = Date.now()): ScheduledRun[] {
    return this.db.transaction(() => {
      const pending = this.pending()
      for (const job of this.list()) {
        if (!job.enabled || job.nextAt === null || job.nextAt > now) continue
        const due = job.nextAt
        job.nextAt = "cron" in job.schedule ? nextRun(job.schedule, job.timezone, now) : null
        if (job.nextAt === null) job.enabled = false
        this.save(job)
        // A connection failure must not create a growing backlog for one recurring task.
        if (pending.some(run => run.job.id === job.id)) continue
        const id = `${job.id}_${due}`
        const run: ScheduledRun = { id, due, sessionID: `ses_schedule_${id}`, job }
        this.db.query("INSERT INTO runs VALUES (?, ?)").run(id, JSON.stringify(run))
        pending.push(run)
      }
      return pending
    }).immediate()
  }
  pending(): ScheduledRun[] { return this.db.query<{ value: string }, []>("SELECT value FROM runs ORDER BY rowid").all().map(row => JSON.parse(row.value)) }
  complete(run: ScheduledRun, error?: string) {
    this.db.transaction(() => {
      const row = this.db.query<{ value: string }, [string]>("SELECT value FROM jobs WHERE id = ?").get(run.job.id)
      if (row) {
        const job: Job = JSON.parse(row.value)
        job.last = { at: run.due, state: error ? "failed" : "submitted", sessionID: run.sessionID, ...(error ? { error } : {}) }
        this.save(job)
      }
      this.db.query("DELETE FROM runs WHERE id = ?").run(run.id)
    }).immediate()
  }
  skipOverlap(run: ScheduledRun) {
    this.db.transaction(() => {
      if (!this.current(run)) return
      const job = this.get(run.job.id)
      job.last = { at: run.due, state: "skipped", sessionID: run.job.last?.sessionID }
      this.save(job)
      this.db.query("DELETE FROM runs WHERE id = ?").run(run.id)
    }).immediate()
  }
  close() { this.db.close() }
}

export function jobSession(run: ScheduledRun) {
  return {
    id: run.sessionID, title: `Scheduled: ${run.job.name}`, location: { directory: run.job.directory },
    ...(run.job.model ? { model: run.job.model } : {}), ...(run.job.agent ? { agent: run.job.agent } : {}),
    metadata: { source: "opencode-agent", transport: "telegram", scheduleID: run.job.id },
  }
}

export function jobDefaults(session: SessionInfo) {
  return { directory: session.location.directory, ...(session.model ? { model: session.model } : {}), ...(session.agent ? { agent: session.agent } : {}) }
}
