import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// What the booking pages show until the real rules arrive. They match the rules a fresh database starts with.
export const DEFAULT_RULES = { horizonDays: 40, noticeHours: 2, freeHours: 24, graceMinutes: 60 }

export function rulesFromRow(row) {
  const number = (value, fallback) => Number.isInteger(value) && value >= 0 ? value : fallback
  return {
    horizonDays: number(row?.booking_horizon_days, DEFAULT_RULES.horizonDays) || DEFAULT_RULES.horizonDays,
    noticeHours: number(row?.minimum_notice_hours, DEFAULT_RULES.noticeHours),
    freeHours: number(row?.free_cancellation_hours, DEFAULT_RULES.freeHours),
    graceMinutes: number(row?.grace_minutes, DEFAULT_RULES.graceMinutes),
  }
}

const hoursWord = hours => `${hours} ${hours === 1 ? 'hour' : 'hours'}`

// The note shown above the payment button, in words that match the Admin's own settings. It is the same for bank transfer and cash:
// free to change or cancel while there is time, and a late fee of up to the full price (which Vad can reduce or waive) after that.
export function cancellationNote(rules) {
  if (rules.freeHours === 0) return 'You can cancel or change your appointment at any time before it begins.'
  return `Free to change or cancel more than ${hoursWord(rules.freeHours)} before your appointment. After that, a late fee of up to the full appointment price may apply.`
}

export function useBookingRules(client = supabase) {
  const [rules, setRules] = useState(DEFAULT_RULES)
  useEffect(() => {
    let live = true
    client.rpc('get_booking_rules').then(({ data, error }) => { if (live && !error && data) setRules(rulesFromRow(data)) }, () => {})
    return () => { live = false }
  }, [client])
  return rules
}
