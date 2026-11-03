// PRD C-RTE-1 and C-RTE-2: working days, working hours and due times in the deployment time zone. Pure functions;
// the calendar (time zone, hours, holidays) comes from the configuration. Wall-clock conversion uses Intl only.

export interface WorkCalendar {
  timeZone: string // IANA, e.g. Europe/London
  startMinute: number // working hours start, minutes after midnight (09:00 = 540)
  endMinute: number // working hours end (18:00 = 1080)
  holidays: ReadonlySet<string> // ISO dates that are not working days
}

const DAY_MS = 86_400_000

/** Weekday of an ISO date: 0 = Sunday … 6 = Saturday. */
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** Monday to Friday and not a configured holiday (C-RTE-1). */
export function isWorkingDay(cal: Pick<WorkCalendar, 'holidays'>, iso: string): boolean {
  const w = weekday(iso)
  return w !== 0 && w !== 6 && !cal.holidays.has(iso)
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function wallParts(timeZone: string, ms: number): { date: string; minute: number; offsetMs: number } {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    formatters.set(timeZone, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const date = `${p.year}-${p.month}-${p.day}`
  const wallMs = Date.parse(`${date}T${p.hour}:${p.minute}:${p.second}Z`)
  return { date, minute: Number(p.hour) * 60 + Number(p.minute), offsetMs: wallMs - (ms - (ms % 1000)) }
}

/** The local calendar date of an instant in the deployment time zone (e.g. the receipt date of C-RSK-2a, C-DRF-4). */
export const localDate = (timeZone: string, utc: string) => wallParts(timeZone, Date.parse(utc)).date

/** The instant of a local wall-clock time. Times inside a spring-forward gap move forward by the gap; a repeated hour resolves to the later occurrence (working hours never fall in either). */
export function localToUtc(timeZone: string, iso: string, minute: number): string {
  const wall = Date.parse(`${iso}T00:00:00Z`) + minute * 60_000
  let ms = wall - wallParts(timeZone, wall).offsetMs
  ms = wall - wallParts(timeZone, ms).offsetMs
  return new Date(ms).toISOString()
}

/** Working days strictly after `from` up to and including `to` (C-DRF-4; C-RSK-2a, PRD v0.7.12). 0 when `to` ≤ `from`. */
export function workingDaysAfter(cal: Pick<WorkCalendar, 'holidays'>, from: string, to: string): number {
  let n = 0
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isWorkingDay(cal, d)) n++
  return n
}

/** First working moment at or after an instant: [date, minute] in local time. */
function clampToWork(cal: WorkCalendar, utc: string): { date: string; minute: number } {
  let { date, minute } = wallParts(cal.timeZone, Date.parse(utc))
  if (minute < cal.startMinute) minute = cal.startMinute
  for (let guard = 0; !isWorkingDay(cal, date) || minute >= cal.endMinute; guard++) {
    if (guard > 3660) throw new Error('no working day within ten years')
    date = addDays(date, 1)
    minute = cal.startMinute
  }
  return { date, minute }
}

/** Due time: `hours` working hours after the receipt time (C-RTE-1; follow-up of C-RTE-2 = 10 working days × day length). */
export function addWorkingHours(cal: WorkCalendar, receivedUtc: string, hours: number): string {
  let { date, minute } = clampToWork(cal, receivedUtc)
  let left = Math.round(hours * 60)
  for (let guard = 0; ; guard++) {
    if (guard > 3660) throw new Error('no working day within ten years')
    const room = cal.endMinute - minute
    if (left <= room) return localToUtc(cal.timeZone, date, minute + left)
    left -= room
    do date = addDays(date, 1)
    while (!isWorkingDay(cal, date))
    minute = cal.startMinute
  }
}

/** Working minutes between two instants (0 when `to` ≤ `from`). */
export function workingMinutesBetween(cal: WorkCalendar, fromUtc: string, toUtc: string): number {
  if (Date.parse(toUtc) <= Date.parse(fromUtc)) return 0
  const a = clampToWork(cal, fromUtc)
  const end = wallParts(cal.timeZone, Date.parse(toUtc))
  let n = 0
  for (let date = a.date, minute = a.minute; date <= end.date; date = addDays(date, 1), minute = cal.startMinute) {
    if (!isWorkingDay(cal, date)) continue
    const stop = date === end.date ? Math.min(cal.endMinute, Math.max(cal.startMinute, end.minute)) : cal.endMinute
    n += Math.max(0, stop - minute)
  }
  return n
}

export type DueState = 'ok' | 'due_soon' | 'overdue'

/** R-RTE-02: a reminder when the remaining working time is at most `remindShare` of the target, red once past due. */
export function dueState(cal: WorkCalendar, receivedUtc: string, dueUtc: string, nowUtc: string, remindShare: number): DueState {
  if (Date.parse(nowUtc) > Date.parse(dueUtc)) return 'overdue'
  const total = workingMinutesBetween(cal, receivedUtc, dueUtc)
  const left = workingMinutesBetween(cal, nowUtc, dueUtc)
  return left <= total * remindShare ? 'due_soon' : 'ok'
}
