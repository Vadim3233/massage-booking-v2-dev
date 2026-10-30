import { createHash } from 'node:crypto'
import { createBookingApi, quoteParams } from '../../src/client/booking/bookingApi.js'
import { buildCalendarFile } from '../../src/client/booking/calendarFile.js'
import { telegramLink } from '../../src/client/booking/telegramLink.js'
import { areaForPostcode, areasHavePostcodes, postcodeOf } from '../../src/lib/address.js'

// The actions a client's own AI assistant can take, signed in as that client (see api/mcp.js). Each one goes through the same client functions
// as the app, so the database's rules (free times, notice, how far ahead, prices, one hold per client, the client's own bookings only) decide.
// Deliberately left to the app: three or more people, extras, new addresses, health notes, moving and cancelling.

export const MAX_PEOPLE = 2
const MAX_DAYS = 7

// What the assistant is told about this connector as a whole, once, when it connects.
export const INSTRUCTIONS = `This connector books mobile massage appointments with Vad Massage (Vadim, a massage therapist who visits clients at home in London) for the signed-in client.
- Start with get_my_booking_options: it has the treatments, lengths, prices, saved addresses and the client's usual booking.
- Only offer times that find_free_times returned. Never guess a time, a price or an address.
- Before book_appointment, always show the client a summary (day, time, address, people and lengths, total price, payment method, cancellation terms) and wait for a clear yes.
- Prices are in pounds (GBP). Payment is by bank transfer or cash; you never take a payment yourself.
- Do not send health or medical details through this connector. Vadim asks about health separately.
- New addresses, bookings for three or more people, extras, and moving or cancelling are done in the app at the client's account page.`

export class ToolProblem extends Error {}

const pad = number => String(number).padStart(2, '0')
const clock = minutes => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`
const gbp = amount => `£${Number(amount).toFixed(2).replace(/\.00$/, '')}`
const dayName = date => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
const DATE = /^\d{4}-\d{2}-\d{2}$/

function addDays(date, days) {
  const moved = new Date(`${date}T12:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

export function londonToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new ToolProblem('Please give the time as HH:MM, for example 18:30.')
  return Number(match[1]) * 60 + Number(match[2])
}

function lengthsOf(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PEOPLE || !value.every(minutes => Number.isInteger(minutes) && minutes > 0)) {
    throw new ToolProblem(`Give one length in minutes for each person, for one or ${MAX_PEOPLE} people, for example [60] or [60, 90]. Bookings for more people are made in the app.`)
  }
  return value
}

// Messages the database writes for clients. Anything else is not shown, so nothing technical leaks into the conversation.
function readable(error) {
  if (error instanceof ToolProblem) return error.message
  const message = String(error?.message || '')
  if (['22023', 'P0001', '23P01', '22P02'].includes(error?.code) && message && message.length < 300 && !/[{}]|violates|constraint|relation|column/i.test(message)) {
    return error.code === '23P01' ? 'That time has just been taken. Please choose another time.' : message
  }
  if (error?.code === '42501' && /not available to this client/i.test(message)) return 'That booking is not on this account.'
  return 'Something went wrong on the booking side. Please try again, or book in the app.'
}

export function bookingSummary(booking) {
  return {
    reference: booking.booking_reference,
    date: booking.date,
    day: dayName(booking.date),
    start: clock(booking.start_minutes),
    end: clock(booking.start_minutes + booking.treatment_duration_minutes),
    treatments: booking.services || undefined,
    total: gbp(booking.total_gbp),
    status: STATUS_WORDS[booking.booking_status] || booking.booking_status,
    payment: PAYMENT_WORDS[booking.payment_status ?? booking.booking_payments?.status] || (booking.payment_status ?? booking.booking_payments?.status),
  }
}

const STATUS_WORDS = {
  awaiting_transfer: 'Reserved, waiting for the bank transfer', awaiting_payment_verification: 'Reserved, Vadim is checking the transfer',
  awaiting_cash_approval: 'Requested with cash, Vadim will confirm shortly', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'Missed',
}
// Every payment status the database has (booking_payments_status_valid).
const PAYMENT_WORDS = {
  awaiting_transfer: 'Not paid yet', awaiting_verification: 'Transfer sent, Vadim is checking it', awaiting_approval: 'Cash, waiting for Vadim',
  approved: 'Cash, to pay on the day', paid: 'Paid', rejected: 'No payment taken', refunded: 'Refunded',
}

// A Google Calendar link for an appointment, alongside the calendar file the app already makes.
export function googleCalendarLink(booking, address) {
  const stamp = minutes => {
    const day = minutes >= 1440 ? addDays(booking.date, 1) : booking.date
    const within = minutes % 1440
    return `${day.replaceAll('-', '')}T${pad(Math.floor(within / 60))}${pad(within % 60)}00`
  }
  const query = new URLSearchParams({
    action: 'TEMPLATE', text: 'Massage with Vad', ctz: 'Europe/London',
    dates: `${stamp(booking.start_minutes)}/${stamp(booking.start_minutes + booking.treatment_duration_minutes)}`,
    details: `Booking reference: ${booking.booking_reference}`, ...(address ? { location: address } : {}),
  })
  return `https://calendar.google.com/calendar/render?${query}`
}

export function createTools({ client, userId, origin = '', env = {}, now = () => new Date() }) {
  const api = createBookingApi(client)
  const rpc = async (name, args) => {
    const { data, error } = await client.rpc(name, args)
    if (error) throw error
    return data
  }
  // One hold per client at a time: holding a new time lets go of the last one, as in the app.
  const holdKey = `ai-assistant:${userId}`
  const accountLink = origin ? `${origin}/account` : 'the account page in the app'

  async function profile() {
    let found
    try { found = await api.activate() }
    catch (error) {
      if (/first name is required/i.test(error?.message || '')) throw new ToolProblem(`This account is not finished yet. Please open ${origin || 'the app'} once, make a booking or add your details, then try again.`)
      throw error
    }
    if (!found.online_booking_enabled) throw new ToolProblem("Online booking isn't available on this account just now. Please contact Vadim and he'll arrange the appointment.")
    return found
  }

  async function catalogue() {
    const all = await api.catalogue()
    return { ...all, areas: all.areas || [] }
  }

  async function addresses() { return api.addresses() }

  function areaFor(areas, address, areaId) {
    const chosen = areaId ? areas.find(area => area.id === areaId) : null
    if (areaId && !chosen) throw new ToolProblem('That area is not one Vadim covers. Use an area_id from get_my_booking_options.')
    const code = postcodeOf(address.address)
    if (areasHavePostcodes(areas) && code) {
      const found = areaForPostcode(areas, code)
      if (found && chosen && found.id !== chosen.id) throw new ToolProblem(`${code} is in ${found.name}, not ${chosen.name}. Use ${found.name} (area_id ${found.id}).`)
      if (found) return { area: found, outside: false }
      if (chosen) return { area: chosen, outside: true }
      throw new ToolProblem(`${code} is outside Vadim's usual areas. Ask the client which area is nearest (area_id from get_my_booking_options); Vadim will then check he can come before anything is paid.`)
    }
    if (chosen) return { area: chosen, outside: false }
    if (areas.length === 1) return { area: areas[0], outside: false }
    throw new ToolProblem('Please choose the area for this address: give an area_id from get_my_booking_options.')
  }

  async function selection({ treatment_id: treatmentId, lengths, address_id: addressId, area_id: areaId, second_person_name: secondName }) {
    const people = lengthsOf(lengths)
    const [all, saved] = await Promise.all([catalogue(), addresses()])
    const service = all.services.find(item => item.id === treatmentId)
    if (!service) throw new ToolProblem('That treatment is not available. Use a treatment_id from get_my_booking_options.')
    const priced = all.prices.filter(price => price.service_id === service.id).map(price => price.duration_minutes)
    const missing = people.find(minutes => !priced.includes(minutes))
    if (missing) throw new ToolProblem(`${service.name} is not offered for ${missing} minutes. Lengths: ${priced.join(', ')} minutes.`)
    const address = saved.find(item => item.id === addressId)
    if (!address) throw new ToolProblem(`That address is not saved on this account. New addresses are added in the app: ${accountLink}.`)
    const { area, outside } = areaFor(all.areas, address, areaId)
    const sessions = people.map((minutes, index) => ({ duration_minutes: minutes, recipient_name: index === 1 ? String(secondName ?? '').trim().slice(0, 60) : '', preference_ids: [] }))
    const draft = { areaId: area.id, serviceId: service.id, sessions, enhancementIds: [] }
    return { draft, service, address, area, outside, duration: people.reduce((sum, minutes) => sum + minutes, 0) }
  }

  async function rules() {
    try { return (await rpc('get_booking_rules')) || {} } catch { return {} }
  }

  function terms(row) {
    const hours = Number.isInteger(row.free_cancellation_hours) ? row.free_cancellation_hours : 24
    if (hours === 0) return 'Free to cancel or change any time before the appointment.'
    return `Free to change or cancel more than ${hours} hours before the appointment. After that, a late fee of up to the full price may apply.`
  }

  function priceLines(quote) {
    return {
      treatments: gbp(quote.service_subtotal_gbp),
      ...(Number(quote.travel_fee_gbp) ? { travel: gbp(quote.travel_fee_gbp) } : {}),
      ...(Number(quote.congestion_fee_gbp) ? { congestion_charge: gbp(quote.congestion_fee_gbp) } : {}),
      total: gbp(quote.total_gbp),
    }
  }

  async function findBooking(reference) {
    const wanted = String(reference ?? '').trim().toUpperCase()
    const rows = (await rpc('list_my_bookings')) || []
    const found = rows.find(row => String(row.booking_reference).toUpperCase() === wanted)
    if (!found) throw new ToolProblem('There is no booking with that reference on this account. list_my_bookings shows them.')
    return found
  }

  async function telegramOffer() {
    const username = env.TELEGRAM_CLIENT_BOT_USERNAME || env.VITE_TELEGRAM_CLIENT_BOT_USERNAME
    if (!username) return null
    try {
      if ((await rpc('my_telegram_status'))?.linked) return { connected: true }
      const link = telegramLink(username, await rpc('create_my_telegram_link'))
      return link ? { connected: false, link, note: 'Offer this link: tapping it and pressing Start in Telegram sends booking updates there. It works for two hours.' } : null
    } catch { return null }
  }

  async function calendar(booking) {
    const full = await rpc('get_my_booking', { p_booking_id: booking.id })
    const address = full.address_snapshot || [full.address_line_1_snapshot, full.address_line_2_snapshot, full.city_snapshot, full.postcode_snapshot].filter(Boolean).join(', ')
    return {
      google_calendar_link: googleCalendarLink(full, address),
      ics_file: buildCalendarFile({ ...full, address_snapshot: address }, now(), origin),
      note: 'If you can add events to the client\'s calendar yourself, add it with these details; otherwise give the Google Calendar link, or the .ics file for Apple or Outlook.',
      event: { title: 'Massage with Vad', date: full.date, start: clock(full.start_minutes), end: clock(full.start_minutes + full.treatment_duration_minutes), time_zone: 'Europe/London', location: address, reference: full.booking_reference },
    }
  }

  const tools = [
    {
      name: 'get_my_booking_options',
      title: 'Booking options',
      description: 'The treatments, lengths and prices, the client\'s saved addresses (with their area), the areas Vadim covers, the client\'s usual booking, and the booking rules. Call this first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async run() {
        const [me, all, saved, row, history] = await Promise.all([profile(), catalogue(), addresses(), rules(), rpc('list_my_bookings')])
        const treatments = all.services.map(service => ({
          treatment_id: service.id, name: service.name, description: service.short_description || undefined,
          lengths: all.prices.filter(price => price.service_id === service.id).map(price => ({ minutes: price.duration_minutes, price: gbp(price.price_gbp) })),
        })).filter(item => item.lengths.length)
        const places = saved.map(address => {
          let area = null
          try { area = areaFor(all.areas, address, null).area } catch { /* The assistant asks for the area. */ }
          return { address_id: address.id, label: address.label || undefined, address: address.address, is_default: Boolean(address.is_default), area_id: area?.id, area: area?.name }
        })
        // The usual: the treatment and lengths of the latest booking that was not cancelled, at the default address.
        let usual = null
        const last = (history || []).find(item => item.booking_status !== 'cancelled')
        if (last) {
          try {
            const full = await rpc('get_my_booking', { p_booking_id: last.id })
            const sessions = [...(full.booking_sessions || [])].sort((a, b) => a.position - b.position)
            const service = all.services.find(item => item.name === sessions[0]?.service_name_snapshot)
            if (service && sessions.length <= MAX_PEOPLE) usual = { treatment_id: service.id, treatment: service.name, lengths: sessions.map(session => session.duration_minutes), address_id: places.find(place => place.is_default)?.address_id || places[0]?.address_id, last_booked: last.date }
          } catch { /* No usual, then. */ }
        }
        return {
          client: { first_name: me.first_name, last_name: me.last_name },
          treatments,
          saved_addresses: places,
          areas: all.areas.map(area => ({ area_id: area.id, name: area.name, travel_fee: gbp(area.travel_surcharge_gbp || 0), congestion_charge: gbp(area.congestion_fee_gbp || 0) })),
          usual_booking: usual,
          max_people: MAX_PEOPLE,
          rules: {
            book_up_to_days_ahead: row.booking_horizon_days ?? undefined,
            minimum_notice_hours: row.minimum_notice_hours ?? undefined,
            cancellation: terms(row),
          },
          payment_methods: ['bank_transfer', 'cash'],
          ...(places.length ? {} : { note: `No saved address yet. The client adds one in the app: ${accountLink}.` }),
        }
      },
    },
    {
      name: 'find_free_times',
      title: 'Find free times',
      description: `Vadim's free start times for one or ${MAX_PEOPLE} people, over up to ${MAX_DAYS} days. Two people are seen one after the other, so the times fit both lengths together.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['lengths', 'from_date'],
        properties: {
          lengths: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: MAX_PEOPLE, description: 'Minutes for each person, for example [60] or [60, 60].' },
          from_date: { type: 'string', description: 'First day, YYYY-MM-DD (London).' },
          to_date: { type: 'string', description: `Last day, YYYY-MM-DD; at most ${MAX_DAYS} days after from_date. Defaults to from_date.` },
        },
      },
      annotations: { readOnlyHint: true },
      async run({ lengths, from_date: from, to_date: to }) {
        const total = lengthsOf(lengths).reduce((sum, minutes) => sum + minutes, 0)
        if (!DATE.test(from || '') || (to && !DATE.test(to))) throw new ToolProblem('Dates are YYYY-MM-DD, for example 2026-11-04.')
        const today = londonToday(now())
        const first = from < today ? today : from
        const last = to || from
        if (last < first) throw new ToolProblem('to_date is before from_date.')
        const days = []
        for (let day = first; day <= last && days.length < MAX_DAYS; day = addDays(day, 1)) days.push(day)
        await profile()
        const found = await Promise.all(days.map(async date => {
          const rows = await api.availability(date, total)
          return { date, day: dayName(date), times: rows.map(row => clock(row.start_minutes)) }
        }))
        const free = found.filter(day => day.times.length)
        return { length_in_total_minutes: total, days: free, ...(free.length ? {} : { note: 'No free times on those days. Try other days.' }) }
      },
    },
    {
      name: 'get_price',
      title: 'Check the price',
      description: 'The total price for a treatment, lengths and saved address, with the travel fees of its area and the cancellation terms. Nothing is booked.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['treatment_id', 'lengths', 'address_id'],
        properties: {
          treatment_id: { type: 'string' }, address_id: { type: 'string' },
          lengths: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: MAX_PEOPLE },
          area_id: { type: 'string', description: 'Only when the address has no area of its own.' },
        },
      },
      annotations: { readOnlyHint: true },
      async run(input) {
        await profile()
        const chosen = await selection(input)
        const [quote, row] = await Promise.all([api.quote(chosen.draft), rules()])
        return {
          treatment: chosen.service.name, lengths: chosen.draft.sessions.map(session => `${session.duration_minutes} min`), address: chosen.address.address, area: chosen.area.name,
          price: priceLines(quote), expected_total_gbp: Number(quote.total_gbp), cancellation: terms(row),
          ...(chosen.outside ? { note: 'This address is outside Vadim\'s usual areas: the booking is a request, and Vadim checks he can come before anything is paid.' } : {}),
        }
      },
    },
    {
      name: 'book_appointment',
      title: 'Book the appointment',
      description: 'Books the appointment. Only call this after showing the client the summary (day, time, address, lengths, total, payment method, cancellation terms) and the client clearly said yes.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['treatment_id', 'lengths', 'address_id', 'date', 'time', 'payment_method', 'expected_total_gbp', 'client_confirmed'],
        properties: {
          treatment_id: { type: 'string' }, address_id: { type: 'string' },
          lengths: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: MAX_PEOPLE },
          area_id: { type: 'string', description: 'Only when the address has no area of its own.' },
          date: { type: 'string', description: 'YYYY-MM-DD (London).' },
          time: { type: 'string', description: 'Start time HH:MM, one that find_free_times returned.' },
          payment_method: { type: 'string', enum: ['bank_transfer', 'cash'] },
          expected_total_gbp: { type: 'number', description: 'The total the client agreed to, from get_price.' },
          second_person_name: { type: 'string', description: 'Optional first name of the second person.' },
          client_confirmed: { type: 'boolean', const: true, description: 'True only when the client said yes to the summary.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run(input) {
        if (input.client_confirmed !== true) throw new ToolProblem('Show the client the summary and ask for a clear yes first.')
        if (!DATE.test(input.date || '')) throw new ToolProblem('The date is YYYY-MM-DD, for example 2026-11-04.')
        if (!['bank_transfer', 'cash'].includes(input.payment_method)) throw new ToolProblem('payment_method is bank_transfer or cash.')
        const start = parseTime(input.time)
        await profile()
        const chosen = await selection(input)
        // Asked twice (an assistant can retry), the same booking is found and not made again.
        const existing = ((await rpc('list_my_bookings')) || []).find(row => row.date === input.date && row.start_minutes === start && row.booking_status !== 'cancelled')
        if (existing) {
          // A cash booking is made as a bank transfer first and then switched; if the switch failed last time, it is done now.
          if (input.payment_method === 'cash' && existing.booking_status === 'awaiting_transfer') {
            const after = await api.confirmCash(existing.id)
            return { already_booked: true, booking: bookingSummary({ ...existing, booking_status: after.booking_status ?? existing.booking_status, payment_status: after.booking_payments?.status ?? existing.payment_status }),
              payment: { method: 'cash', note: 'Vadim confirms cash bookings himself. Tell the client "Vadim will confirm shortly", not that it is confirmed.' } }
          }
          return { already_booked: true, booking: bookingSummary(existing) }
        }
        const quote = await api.quote(chosen.draft)
        if (Math.abs(Number(quote.total_gbp) - Number(input.expected_total_gbp)) > 0.004) {
          throw new ToolProblem(`The total is now ${gbp(quote.total_gbp)}, not ${gbp(input.expected_total_gbp)}. Tell the client the new total and ask again.`)
        }
        const hold = await api.hold(input.date, start, chosen.duration, holdKey)
        // The hold is part of the key: a retry finds the same hold (same key, day and time), while booking the same time again after a
        // cancellation gets a new hold and so a new request, instead of being refused as a reused key.
        const key = createHash('sha256').update(JSON.stringify([userId, input.date, start, chosen.service.id, input.lengths, chosen.address.id, chosen.area.id, hold.hold_id])).digest('hex').slice(0, 48)
        const result = await api.finalize({
          p_hold_id: hold.hold_id, p_hold_token: hold.hold_token, p_hold_client_key: holdKey,
          ...quoteParams(chosen.draft),
          p_saved_address_id: chosen.address.id, p_address: null, p_address_line_1: null, p_address_line_2: null, p_city: null, p_postcode: null,
          p_entry_instructions: null, p_client_note: null, p_payment_method: 'bank_transfer', p_idempotency_key: `ai-${key}`,
        })
        let booking = { id: result.booking_id, booking_reference: result.booking_reference, booking_status: result.booking_status, payment_status: result.payment_status, date: input.date, start_minutes: start, treatment_duration_minutes: chosen.duration, total_gbp: result.total_gbp }
        let payment
        if (input.payment_method === 'cash') {
          const after = await api.confirmCash(result.booking_id)
          booking = { ...booking, booking_status: after.booking_status ?? booking.booking_status, payment_status: after.booking_payments?.status ?? booking.payment_status }
          payment = { method: 'cash', note: 'Vadim confirms cash bookings himself. Tell the client "Vadim will confirm shortly", not that it is confirmed.' }
        } else if (result.payment_status === 'awaiting_transfer') {
          const bank = await rpc('get_bank_details').catch(() => null)
          payment = {
            method: 'bank_transfer', amount: gbp(result.total_gbp), reference: result.payment_reference || result.booking_reference,
            ...(bank ? { bank_details: bank } : { note: 'The bank details are in the confirmation email.' }),
            next: 'When the client has sent the transfer, call i_have_paid. Vadim checks it and confirms.',
          }
        }
        const [calendarEvent, telegram] = await Promise.all([calendar(booking).catch(() => null), telegramOffer()])
        return {
          booked: true, booking: bookingSummary(booking), address: chosen.address.address, payment,
          ...(chosen.outside ? { area_note: 'The address is outside Vadim\'s usual areas: he will check he can come and let the client know before anything is paid.' } : {}),
          add_to_calendar: calendarEvent ? { question: 'Ask the client: shall I add it to your calendar?', ...calendarEvent } : undefined,
          telegram: telegram?.connected === false ? telegram : undefined,
          email: 'A confirmation email is on its way too.',
        }
      },
    },
    {
      name: 'i_have_paid',
      title: 'Tell Vadim the transfer is sent',
      description: 'Tells Vadim the client has sent the bank transfer for a booking. Only when the client says they have paid.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['booking_reference'], properties: { booking_reference: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run({ booking_reference: reference }) {
        const found = await findBooking(reference)
        if (found.payment_status !== 'awaiting_transfer') return { booking: bookingSummary(found), note: 'Nothing to do: this booking is not waiting for a transfer.' }
        const after = await api.declareTransfer(found.id)
        return { booking: bookingSummary({ ...found, booking_status: after.booking_status ?? found.booking_status, payment_status: after.booking_payments?.status ?? found.payment_status }), note: 'Vadim has been told. He checks the transfer and confirms.' }
      },
    },
    {
      name: 'list_my_bookings',
      title: 'My bookings',
      description: 'The client\'s upcoming bookings (and the last few past ones), with whether each is paid.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { include_past: { type: 'boolean' } } },
      annotations: { readOnlyHint: true },
      async run({ include_past: past } = {}) {
        const today = londonToday(now())
        const rows = (await rpc('list_my_bookings')) || []
        const upcoming = rows.filter(row => row.date >= today && row.booking_status !== 'cancelled').reverse()
        return {
          upcoming: upcoming.map(bookingSummary),
          ...(past ? { past: rows.filter(row => row.date < today || row.booking_status === 'cancelled').slice(0, 10).map(bookingSummary) } : {}),
          change_or_cancel: `Moving or cancelling is done in the app: ${accountLink}.`,
        }
      },
    },
    {
      name: 'add_to_calendar',
      title: 'Add to calendar',
      description: 'The details to add a booking to the client\'s calendar: the event, a Google Calendar link and an .ics file.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['booking_reference'], properties: { booking_reference: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      async run({ booking_reference: reference }) {
        return calendar(await findBooking(reference))
      },
    },
    {
      name: 'connect_telegram',
      title: 'Booking updates on Telegram',
      description: 'A link the client taps to get booking updates from Vadim on Telegram, or says they are already connected.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      async run() {
        await profile()
        const offer = await telegramOffer()
        if (!offer) return { note: 'Telegram updates are not available just now.' }
        return offer.connected ? { connected: true, note: 'Telegram is already connected for this account.' } : offer
      },
    },
  ]

  return {
    list: () => tools.map(tool => Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'run'))),
    async call(name, input = {}) {
      const tool = tools.find(item => item.name === name)
      if (!tool) return { isError: true, text: `There is no tool called ${name}.` }
      try {
        await rpc('note_ai_request')
        const result = await tool.run(input || {})
        return { isError: false, data: result }
      } catch (error) {
        return { isError: true, text: readable(error) }
      }
    },
  }
}
