import { describe, expect, it } from 'vitest'
import { addWorkingHours, dueState, isWorkingDay, localDate, localToUtc, workingDaysAfter, workingMinutesBetween, type WorkCalendar } from './workdays.ts'

// England and Wales bank holidays around the cases below
const cal: WorkCalendar = { timeZone: 'Europe/London', startMinute: 540, endMinute: 1080, holidays: new Set(['2026-08-31', '2026-12-25', '2026-12-28']) }
const due = (received: string, hours: number) => addWorkingHours(cal, received, hours)

describe('working days and due times (C-RTE-1)', () => {
  it('TC-RTE-01 Friday 17:00 + 2 working hours → Monday 10:00; Monday a bank holiday → Tuesday 10:00', () => {
    expect(due('2026-10-16T16:00:00Z', 2)).toBe('2026-10-19T09:00:00.000Z') // BST: 17:00 local = 16:00Z
    expect(due('2026-08-28T16:00:00Z', 2)).toBe('2026-09-01T09:00:00.000Z') // Monday 31 August is a bank holiday
  })
  it('TC-RTE-02 received on Saturday → counted from Monday 09:00', () => {
    expect(due('2026-11-07T12:00:00Z', 2)).toBe('2026-11-09T11:00:00.000Z')
    expect(due('2026-11-07T12:00:00Z', 9)).toBe('2026-11-09T18:00:00.000Z')
  })
  it('TC-RTE-03 across the clock change: Friday 23 October 17:00 BST → Monday 26 October 10:00 GMT', () => {
    expect(due('2026-10-23T16:00:00Z', 2)).toBe('2026-10-26T10:00:00.000Z')
  })
  it('TC-RTE-04 one working day = 9 working hours: Tuesday 15:00 → Wednesday 15:00', () => {
    expect(due('2026-11-10T15:00:00Z', 9)).toBe('2026-11-11T15:00:00.000Z')
  })
  it('before, at and after working hours', () => {
    expect(due('2026-11-10T07:00:00Z', 2)).toBe('2026-11-10T11:00:00.000Z') // before 09:00 → from 09:00
    expect(due('2026-11-10T18:00:00Z', 2)).toBe('2026-11-11T11:00:00.000Z') // at 18:00 → next day
    expect(due('2026-11-10T17:00:00Z', 1)).toBe('2026-11-10T18:00:00.000Z') // ends exactly at closing time
    expect(due('2026-12-24T17:30:00Z', 1)).toBe('2026-12-29T09:30:00.000Z') // Christmas, weekend, substitute Boxing Day
  })
  it('follow-up reminder: 10 working days from receipt (C-RTE-2)', () => {
    expect(due('2026-10-29T10:15:00Z', 90)).toBe('2026-11-12T10:15:00.000Z')
  })
  it('working days after a date, inclusive of the end (C-DRF-4)', () => {
    const c = { holidays: cal.holidays }
    expect(workingDaysAfter(c, '2026-10-22', '2026-10-29')).toBe(5) // TC-DRF-05: 22 Oct paid, 29 Oct received
    expect(workingDaysAfter(c, '2026-10-23', '2026-10-29')).toBe(4)
    expect(workingDaysAfter(c, '2026-10-29', '2026-10-29')).toBe(0)
    expect(workingDaysAfter(c, '2026-10-30', '2026-10-29')).toBe(0)
    expect(workingDaysAfter(c, '2026-10-30', '2026-11-01')).toBe(0) // Friday → Sunday
    expect(workingDaysAfter(c, '2026-10-31', '2026-11-02')).toBe(1) // Saturday → Monday
    expect(workingDaysAfter(c, '2026-12-24', '2026-12-29')).toBe(1)
    expect(isWorkingDay(c, '2026-12-28')).toBe(false)
  })
  it('local dates and wall clock in the deployment time zone', () => {
    expect(localDate('Europe/London', '2026-10-29T23:30:00Z')).toBe('2026-10-29') // GMT
    expect(localDate('Europe/London', '2026-10-24T23:30:00Z')).toBe('2026-10-25') // BST
    expect(localToUtc('Europe/London', '2026-03-29', 90)).toBe('2026-03-29T01:30:00.000Z') // 01:30 is skipped → 02:30 BST
    expect(localToUtc('Europe/London', '2026-10-25', 90)).toBe('2026-10-25T01:30:00.000Z') // repeated hour: the later one
  })
  it('TC-RTE-06 reminder at 25% left, red when past', () => {
    const r = '2026-11-10T09:00:00Z'
    const d = due(r, 2) // 11:00
    expect(workingMinutesBetween(cal, r, d)).toBe(120)
    expect(dueState(cal, r, d, '2026-11-10T10:00:00Z', 0.25)).toBe('ok')
    expect(dueState(cal, r, d, '2026-11-10T10:30:00Z', 0.25)).toBe('due_soon')
    expect(dueState(cal, r, d, '2026-11-10T11:00:00Z', 0.25)).toBe('due_soon') // at the due time, not yet past it
    expect(dueState(cal, r, d, '2026-11-10T11:00:01Z', 0.25)).toBe('overdue')
    // overnight: the remaining time counts working minutes only
    const r2 = '2026-11-10T17:00:00Z'
    const d2 = due(r2, 2) // Wed 10:00
    expect(dueState(cal, r2, d2, '2026-11-10T20:00:00Z', 0.25)).toBe('ok') // 60 of 120 left
    expect(dueState(cal, r2, d2, '2026-11-11T09:40:00Z', 0.25)).toBe('due_soon')
  })
})
