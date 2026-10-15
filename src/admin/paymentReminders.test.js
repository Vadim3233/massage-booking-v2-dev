import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeReminder, clearReminder, fingerprint, getReminders, londonInstant, parseReminders, reminderChoices, reminderWhen, setReminder, startOf, subscribeReminders } from './paymentReminders.js'

// Thursday 15 October 2026, 12:00 UTC, which is 13:00 in London (summer time until the clocks go back on Sunday 25 October).
const now = Date.UTC(2026, 9, 15, 12, 0)
const booking = (date, start, extra = {}) => ({ id: 'b1', date, start_minutes: start, updated_at: '2026-10-14T10:00:00Z', booking_payments: { updated_at: '2026-10-14T10:05:00Z' }, ...extra })

describe('London times, either side of the clocks changing', () => {
  it('knows when a London time happens in summer and in winter time', () => {
    expect(londonInstant('2026-10-16', 540)).toBe(Date.UTC(2026, 9, 16, 8, 0))
    expect(londonInstant('2026-10-26', 540)).toBe(Date.UTC(2026, 9, 26, 9, 0))
  })
  it('gets the days the clocks change right', () => {
    // They go back at 02:00 on Sunday 25 October: 09:00 that morning is already winter time.
    expect(londonInstant('2026-10-24', 540)).toBe(Date.UTC(2026, 9, 24, 8, 0))
    expect(londonInstant('2026-10-25', 540)).toBe(Date.UTC(2026, 9, 25, 9, 0))
    // They go forward at 01:00 on Sunday 29 March.
    expect(londonInstant('2026-03-28', 540)).toBe(Date.UTC(2026, 2, 28, 9, 0))
    expect(londonInstant('2026-03-29', 540)).toBe(Date.UTC(2026, 2, 29, 8, 0))
  })
  it('says when an appointment starts', () => {
    expect(startOf(booking('2026-10-20', 690))).toBe(Date.UTC(2026, 9, 20, 10, 30))
  })
})

describe('when a reminder can be set', () => {
  it('offers three times for an appointment days away, each in the future and before it starts', () => {
    const choices = reminderChoices(booking('2026-10-20', 690), now)
    expect(choices.map(choice => choice.key)).toEqual(['hours', 'tomorrow', 'before'])
    expect(choices.map(choice => choice.until)).toEqual([Date.UTC(2026, 9, 15, 15, 0), Date.UTC(2026, 9, 16, 8, 0), Date.UTC(2026, 9, 19, 8, 0)])
    expect(choices.map(choice => choice.label)).toEqual(['In 3 hours · 16:00', 'Tomorrow morning · Fri 16 Oct, 09:00', 'The day before · Mon 19 Oct, 09:00'])
  })
  it('has no "day before" when that morning has gone or is the same as tomorrow morning', () => {
    expect(reminderChoices(booking('2026-10-16', 690), now).map(choice => choice.key)).toEqual(['hours', 'tomorrow'])
    expect(reminderChoices(booking('2026-10-17', 690), now).map(choice => choice.key)).toEqual(['hours', 'tomorrow'])
  })
  it('never offers a time after the appointment has started', () => {
    // Tomorrow at 08:00 starts before tomorrow's 09:00 reminder, so only the one three hours away is left.
    expect(reminderChoices(booking('2026-10-16', 480), now).map(choice => choice.key)).toEqual(['hours'])
  })
  it('offers a short reminder when the appointment is close, and the start itself when it is very close', () => {
    // 15:00 today, two hours away: three hours later is too late.
    const close = reminderChoices(booking('2026-10-15', 900), now)
    expect(close).toEqual([{ key: 'soon', until: now + 30 * 60000, label: 'In 30 minutes · 13:30' }])
    // 13:20 today, twenty minutes away.
    const verySoon = reminderChoices(booking('2026-10-15', 800), now)
    expect(verySoon).toEqual([{ key: 'soon', until: Date.UTC(2026, 9, 15, 12, 20), label: 'When it starts · 13:20' }])
  })
  it('does not hold back a reminder about an appointment that has already happened', () => {
    const choices = reminderChoices(booking('2026-10-12', 600), now)
    expect(choices.map(choice => choice.key)).toEqual(['hours', 'tomorrow'])
  })
  it('puts tomorrow morning in winter time when the clocks go back overnight', () => {
    const saturdayNight = Date.UTC(2026, 9, 24, 20, 0)
    const tomorrow = reminderChoices(booking('2026-10-30', 600), saturdayNight).find(choice => choice.key === 'tomorrow')
    expect(tomorrow).toEqual({ key: 'tomorrow', until: Date.UTC(2026, 9, 25, 9, 0), label: 'Tomorrow morning · Sun 25 Oct, 09:00' })
  })
})

describe('saying when a reminder is due', () => {
  it('uses today and tomorrow, and the day after that', () => {
    expect(reminderWhen(Date.UTC(2026, 9, 15, 15, 0), now)).toBe('today, 16:00')
    expect(reminderWhen(Date.UTC(2026, 9, 16, 8, 0), now)).toBe('tomorrow, 09:00')
    expect(reminderWhen(Date.UTC(2026, 9, 19, 8, 0), now)).toBe('Mon 19 Oct, 09:00')
  })
})

describe('a reminder lasts until its time, or until the booking changes', () => {
  const saved = { b1: { until: now + 3600000, seen: fingerprint(booking('2026-10-20', 690)) } }
  it('is active before its time for the booking as it was', () => {
    expect(activeReminder(booking('2026-10-20', 690), saved, now)).toBe(saved.b1)
  })
  it('has ended by its time', () => {
    expect(activeReminder(booking('2026-10-20', 690), saved, now + 3600000)).toBeNull()
    expect(activeReminder(booking('2026-10-20', 690), saved, now + 7200000)).toBeNull()
  })
  it('ends when the booking or its payment has changed since', () => {
    expect(activeReminder(booking('2026-10-20', 690, { updated_at: '2026-10-15T09:00:00Z' }), saved, now)).toBeNull()
    expect(activeReminder(booking('2026-10-20', 690, { booking_payments: { updated_at: '2026-10-15T09:00:00Z' } }), saved, now)).toBeNull()
  })
  it('belongs to one booking only', () => {
    expect(activeReminder(booking('2026-10-20', 690, { id: 'b2' }), saved, now)).toBeNull()
    expect(activeReminder(booking('2026-10-20', 690), {}, now)).toBeNull()
    expect(activeReminder(booking('2026-10-20', 690), undefined, now)).toBeNull()
  })
})

describe('reading what the device remembered', () => {
  it('keeps good entries and drops anything that is not one', () => {
    expect(parseReminders({ a: { until: 5, seen: 'x' }, b: { until: 'soon', seen: 'x' }, c: { until: 5 }, d: null, e: 'nope' })).toEqual({ a: { until: 5, seen: 'x' } })
    expect(parseReminders(null)).toEqual({})
    expect(parseReminders('text')).toEqual({})
  })
})

describe('remembering a reminder on this device', () => {
  const fake = () => { const data = {}; return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value) }, removeItem: key => { delete data[key] } } }
  afterEach(() => { vi.unstubAllGlobals(); for (const id of Object.keys(getReminders())) clearReminder(id) })

  it('saves it, tells the screens, and forgets it again', () => {
    const storage = fake()
    vi.stubGlobal('localStorage', storage)
    const heard = vi.fn()
    const stop = subscribeReminders(heard)
    const target = booking('2026-10-20', 690)
    setReminder(target, now + 3600000, now)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(getReminders()[target.id]).toEqual({ until: now + 3600000, seen: fingerprint(target) })
    expect(JSON.parse(storage.data['vad-admin-payment-reminders'])[target.id].until).toBe(now + 3600000)
    clearReminder(target.id)
    expect(heard).toHaveBeenCalledTimes(2)
    expect(getReminders()[target.id]).toBeUndefined()
    expect(JSON.parse(storage.data['vad-admin-payment-reminders'])).toEqual({})
    clearReminder(target.id)
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
  })
  it('drops reminders that are over when it saves a new one', () => {
    vi.stubGlobal('localStorage', fake())
    setReminder(booking('2026-10-20', 690, { id: 'old' }), now - 1000, now - 5000)
    setReminder(booking('2026-10-20', 690, { id: 'new' }), now + 1000, now)
    expect(Object.keys(getReminders())).toEqual(['new'])
  })
  it('still works for this visit when the device will not keep it', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('storage is full') } })
    setReminder(booking('2026-10-20', 690), now + 3600000, now)
    expect(activeReminder(booking('2026-10-20', 690), getReminders(), now)).not.toBeNull()
  })
})
