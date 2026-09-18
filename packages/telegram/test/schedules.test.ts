import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { nextRun, Schedules, type JobInput } from "../src/schedules"

const start = Date.parse("2026-09-18T12:00:00Z")
const input: JobInput = { name: "Daily report", prompt: "Send the daily report.", schedule: { cron: "0 9 * * *" }, timezone: "Europe/Stockholm", directory: "/work" }

test("one-time and cron schedules validate dates and honor timezones", () => {
  expect(nextRun(input.schedule, input.timezone, start)).toBe(Date.parse("2026-09-19T07:00:00Z"))
  expect(nextRun({ at: "2026-09-19T09:00:00+02:00" }, "UTC", start)).toBe(Date.parse("2026-09-19T07:00:00Z"))
  for (const at of ["2026-09-19T09:00:00", "2027-02-29T12:00:00Z", "2026-02-31T12:00:00Z", "2026-09-19T24:00:00Z"]) {
    expect(() => nextRun({ at }, "UTC", start)).toThrow()
  }
  expect(nextRun({ at: "2028-02-29T12:00:00Z" }, "UTC", start)).toBe(Date.parse("2028-02-29T12:00:00Z"))
  expect(() => nextRun({ cron: "* * * * * *" }, "UTC", start)).toThrow("five-field")
})

test("DST changes never return an overdue recurrence", () => {
  const fallback = Date.parse("2026-11-01T06:00:00Z")
  const fallNext = nextRun({ cron: "30 1 * * *" }, "America/New_York", fallback)!
  expect(fallNext).toBeGreaterThan(fallback)
  expect(nextRun({ cron: "30 1 * * *" }, "America/New_York", fallNext)!).toBeGreaterThan(fallNext)
  const spring = Date.parse("2026-03-08T06:59:00Z")
  expect(nextRun({ cron: "30 2 * * *" }, "America/New_York", spring)!).toBeGreaterThan(spring)
})

test("restart skips overdue tasks and retains pending submissions with stable IDs", async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  const home = await mkdtemp("/tmp/opencode/agent-schedule-test-")
  let jobs = new Schedules(join(home, "jobs.sqlite"))
  try {
    const once = jobs.create({ ...input, schedule: { at: "2026-09-18T12:01:00Z" } }, start)
    const recurring = jobs.create({ ...input, schedule: { cron: "* * * * *" } }, start)
    const claimed = jobs.claim(start + 60_000)
    expect(claimed).toHaveLength(2)
    expect(jobs.claim(start + 60_000).map(run => run.id)).toEqual(claimed.map(run => run.id))
    jobs.close()
    jobs = new Schedules(join(home, "jobs.sqlite"))
    jobs.skipMissed(start + 10 * 60_000)
    expect(jobs.get(once.id).enabled).toBe(false)
    expect(jobs.get(recurring.id)).toMatchObject({ nextAt: start + 11 * 60_000, last: { state: "missed" } })
    expect(jobs.pending().map(run => run.id)).toEqual(claimed.map(run => run.id))
    for (const run of claimed) jobs.complete(run)
    expect(jobs.claim(start + 10 * 60_000)).toHaveLength(0)
  } finally { jobs.close(); await rm(home, { recursive: true, force: true }) }
})

test("missed one-time tasks never execute on startup", () => {
  const jobs = new Schedules(":memory:")
  try {
    const job = jobs.create({ ...input, schedule: { at: "2026-09-18T12:01:00Z" } }, start)
    jobs.skipMissed(start + 120_000)
    expect(jobs.get(job.id)).toMatchObject({ enabled: false, nextAt: null, last: { state: "missed" } })
    expect(jobs.claim(start + 120_000)).toHaveLength(0)
  } finally { jobs.close() }
})

test("skipping downtime keeps the preceding session ID for overlap checks", () => {
  const jobs = new Schedules(":memory:")
  try {
    const job = jobs.create({ ...input, schedule: { cron: "* * * * *" } }, start)
    const run = jobs.claim(start + 60_000)[0]!
    jobs.complete(run)
    jobs.skipMissed(start + 120_000)
    expect(jobs.get(job.id).last).toMatchObject({ state: "missed", sessionID: run.sessionID })
    expect(jobs.claim(start + 180_000)[0]?.job.last?.sessionID).toBe(run.sessionID)
  } finally { jobs.close() }
})

test.each(["pause", "remove", "update"])("%s cancels pending submissions, including snapshots already read by the gateway", action => {
  const jobs = new Schedules(":memory:")
  try {
    const job = jobs.create({ ...input, schedule: { cron: "* * * * *" } }, start)
    const run = jobs.claim(start + 60_000)[0]!
    expect(jobs.current(run)).toBe(true)
    if (action === "pause") jobs.enable(job.id, false, start + 60_000)
    if (action === "remove") jobs.remove(job.id)
    if (action === "update") jobs.update(job.id, { prompt: "Changed instructions" }, start + 60_000)
    expect(jobs.current(run)).toBe(false)
    expect(jobs.pending()).toHaveLength(0)
  } finally { jobs.close() }
})

test("concurrent handles cannot claim separate runs for one occurrence", async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  const home = await mkdtemp("/tmp/opencode/agent-schedule-lock-test-")
  const a = new Schedules(join(home, "jobs.sqlite"))
  const b = new Schedules(join(home, "jobs.sqlite"))
  try {
    a.create({ ...input, schedule: { cron: "* * * * *" } }, start)
    const first = a.claim(start + 60_000)
    const second = b.claim(start + 60_000)
    expect(first.map(run => run.id)).toEqual(second.map(run => run.id))
    expect(a.pending()).toHaveLength(1)
    b.complete(second[0]!)
    expect(a.current(first[0]!)).toBe(false)
  } finally { a.close(); b.close(); await rm(home, { recursive: true, force: true }) }
})
