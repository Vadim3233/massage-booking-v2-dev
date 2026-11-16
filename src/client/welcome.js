import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// Shown until the Admin writes her own welcome (More, Welcome message).
export const DEFAULT_WELCOME = 'No need to go anywhere for a proper relaxing or therapeutic massage. I come to you: no stress, no preparation. Trust me, the last thing you want after a massage is to drive. Strong or gentle, years of practice go into melting away tension and pain, with your safety and comfort first.'

export const paragraphs = text => String(text || '').split(/\n{2,}/).map(part => part.trim()).filter(Boolean)

export function welcomeFromRow(row) {
  const text = value => (typeof value === 'string' ? value.trim() : '')
  return { welcome: text(row?.welcome), about: text(row?.about) }
}

const hoursWord = hours => `${hours} ${hours === 1 ? 'hour' : 'hours'}`

// What a visitor needs to know before they start, in words that match the Admin's own cancellation window.
export function changesNote(rules) {
  if (!rules.freeHours) return 'You can change or cancel your appointment any time before it begins.'
  return `Free to change or cancel more than ${hoursWord(rules.freeHours)} before your appointment.`
}

export function useWelcome(client = supabase) {
  const [welcome, setWelcome] = useState({ welcome: '', about: '' })
  useEffect(() => {
    let live = true
    client.rpc('get_public_welcome').then(({ data, error }) => { if (live && !error && data) setWelcome(welcomeFromRow(data)) }, () => {})
    return () => { live = false }
  }, [client])
  return welcome
}
