import { useCallback, useEffect, useRef, useState } from 'react'
import { clientName, dateLabel, money, sessionSummary, time, today } from './calendarPresentation.js'
import { groupByClient, howLongAgo } from './reviewClients.js'
import { extraOwed, loadReviewResource, needsYou, paymentActions, paymentOverdue, paymentReviewApi } from './paymentReviewApi.js'
import { ActionDialog } from './BookingActions.jsx'
import { lifecycleApi } from './bookingLifecycleApi.js'
import { minutesWords, owedExtraMinutes } from './extendApi.js'
import { activeReminder, reminderWhen, useReminders } from './paymentReminders.js'
import PaymentActions from './PaymentActions.jsx'
import PaymentReminder, { ReminderBox } from './PaymentReminder.jsx'
import { combinedReminderText, dueForClient } from './shareBooking.js'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { toast } from '../ui/toast.js'
import Icon from '../ui/icons.jsx'

const extraWords = booking => owedExtraMinutes(booking) ? `the extra ${minutesWords(owedExtraMinutes(booking))}` : 'the extra'
// What is waiting on one booking, in a few words. `reminder` is set when the Admin has put it off with "Not yet".
function statusText(booking, reminder) {
  const cash = booking.booking_payments?.method === 'cash'
  if (reminder) return `Reminder set · back ${reminderWhen(reminder.until)}`
  if (extraOwed(booking)) return booking.balance_reported_at ? `Client says ${extraWords(booking)} is paid, check your bank` : `Session done · ${extraWords(booking)} not paid yet`
  if (paymentOverdue(booking)) return cash ? 'Session done · cash not marked received' : booking.booking_payments.status === 'awaiting_verification' ? 'Session done · client says paid, check your bank' : 'Session done · not paid yet'
  if (cash) return 'Cash request to decide'
  return booking.booking_payments?.status === 'awaiting_transfer' ? 'Transfer not yet declared by the client' : 'Bank transfer to verify'
}
// A session that is over and simply not paid yet: the kind several of can be marked received in one go.
const plainUnpaid = booking => !extraOwed(booking) && paymentOverdue(booking) && paymentActions(booking).length === 1 && ['receive', 'receiveBank'].includes(paymentActions(booking)[0])
const sessionWords = count => `${count} ${count === 1 ? 'session' : 'sessions'}`

function openBookingLink(openBooking, booking) {
  return event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); openBooking(booking.id) } }
}

// One booking inside a client's card: when, what, how much, and its own buttons.
function Line({ booking, openBooking, refresh, reminder }) {
  const extra = extraOwed(booking)
  const [receiving, setReceiving] = useState(false)
  return <li className={`admin-review-line ${needsYou(booking) && !reminder ? '' : 'wait'}`} data-reference={booking.booking_reference}>
    <div className="admin-review-line-text">
      <p className="admin-review-line-when">{dateLabel(booking.date)} · {time(booking.start_minutes)}</p>
      <p className="admin-review-line-what">{sessionSummary(booking)}</p>
      <p className="admin-review-line-status">{statusText(booking, reminder)}</p>
    </div>
    <strong className="admin-review-line-amount">{extra ? `${money(booking.balance_due_gbp)} extra` : money(booking.total_gbp)}</strong>
    <div className="admin-review-line-actions">
      {extra ? <div className="admin-payment-buttons"><button className="btn--primary btn--small" onClick={() => setReceiving(true)}>Mark extra received</button></div>
        : <PaymentActions booking={booking} refresh={refresh} short later />}
      <a className="admin-review-line-view" href={`/admin/bookings/${booking.id}`} onClick={openBookingLink(openBooking, booking)} aria-label={`View booking, ${dateLabel(booking.date)} ${time(booking.start_minutes)}`}>View <Icon name="right" size={16} /></a>
    </div>
    {receiving && <ActionDialog kind="balance" booking={booking} api={lifecycleApi} close={() => setReceiving(false)} done={async () => { setReceiving(false); await refresh() }} />}
  </li>
}

// "All 3 received": for a client who paid every session in one transfer. Each booking is marked received on its own, as if pressed one by one,
// so receipts, income and alerts are exactly as usual. One that changed meanwhile (marked on another phone, say) is skipped and named.
function AllReceived({ group, refresh }) {
  const ref = useRef(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const keys = useRef(new Map())
  const items = group.items
  const total = items.reduce((sum, booking) => sum + Number(booking.total_gbp), 0)
  const name = clientName(group.first)
  const label = `${items.length === 2 ? 'Both' : `All ${items.length}`} received · ${money(total)}`
  useEffect(() => {
    if (!asking) return undefined
    const opener = document.activeElement
    const dialog = ref.current
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [asking])
  async function confirm() {
    if (busy) return
    setBusy(true)
    const done = [], missed = []
    for (const booking of items) {
      const action = paymentActions(booking)[0]
      const fingerprint = `${booking.id}:${booking.updated_at}:${booking.booking_payments.updated_at}`
      if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID())
      try { await paymentReviewApi.act(action, booking, keys.current.get(fingerprint)); done.push(booking) }
      catch { missed.push(booking) }
    }
    const paid = done.reduce((sum, booking) => sum + Number(booking.total_gbp), 0)
    if (done.length) toast(`${sessionWords(done.length)} marked received · ${name} ${money(paid)}`)
    if (missed.length) toast(`Not marked: ${missed.map(booking => `${dateLabel(booking.date)} ${time(booking.start_minutes)}`).join(', ')}. ${missed.length === 1 ? 'It' : 'They'} changed, or could not be saved. Check ${missed.length === 1 ? 'it' : 'them'} and try again.`)
    setBusy(false); setAsking(false)
    try { await refresh() } catch { /* the page shows its own retry */ }
  }
  return <>
    <button className="btn--primary" onClick={() => setAsking(true)}>{label}</button>
    {asking && <dialog ref={ref} className="admin-confirm" aria-labelledby="all-received-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) setAsking(false) }}>
      <h2 id="all-received-title">Mark {items.length === 2 ? 'both' : `all ${items.length}`} received?</h2>
      <div className="admin-confirm-summary"><strong>{name}</strong><b className="figure">{money(total)}</b></div>
      <ul className="admin-all-received-list">{items.map(booking => <li key={booking.id}><span>{dateLabel(booking.date)} · {time(booking.start_minutes)} · {booking.booking_payments.method === 'cash' ? 'cash' : 'bank transfer'}</span><b>{money(booking.total_gbp)}</b></li>)}</ul>
      <p>Check that {money(total)} has reached you. Each session is recorded as paid, with its receipt, as if you pressed Received on each one.</p>
      <div className="admin-payment-buttons">
        <button className="btn--primary" disabled={busy} onClick={confirm}>{busy ? 'Saving…' : `Yes, ${money(total)} received`}</button>
        <button className="btn--quiet" disabled={busy} onClick={() => setAsking(false)}>Go back</button>
      </div>
    </dialog>}
  </>
}

// One client: a short row (name, what is owed, how long it has waited) that opens to show each booking with its buttons.
function ClientCard({ group, open, toggle, openBooking, refresh, putOff, all }) {
  const name = clientName(group.first)
  const bodyId = `review-${group.key.replace(/[^a-z0-9]/gi, '-')}`
  const counted = group.counted
  const allUnpaid = counted.every(booking => paymentOverdue(booking) && !extraOwed(booking))
  const summary = counted.length === 1
    ? `${statusText(counted[0], putOff(counted[0]))} · ${dateLabel(counted[0].date)}${counted[0].date <= today() ? `, ${howLongAgo(counted[0].date)}` : ''}`
    : `${allUnpaid ? `${sessionWords(counted.length)} not paid` : `${counted.length} to check`} · oldest ${dateLabel(group.oldest, { day: 'numeric', month: 'short' })}, ${howLongAgo(group.oldest)}`
  const owing = dueForClient(all, group.clientId)
  const first = group.first.clients?.first_name?.trim()
  const canSettleAll = group.items.length > 1 && group.items.every(plainUnpaid)
  return <li className={`admin-review-client ${group.section === 'needs' ? '' : 'wait'} ${open ? 'is-open' : ''}`} data-variant={group.section === 'needs' ? 'sand' : undefined}>
    <button type="button" className="admin-review-client-head" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      <span className="admin-review-client-name">{name}</span>
      <strong className="admin-review-client-total">{money(group.owed)}</strong>
      <span className="admin-review-client-sub">{summary}</span>
      <Icon name="down" size={22} />
    </button>
    {open && <div id={bodyId} className="admin-review-client-body">
      <ul role="list" className="admin-review-lines">{group.items.map(booking => <Line key={booking.id} booking={booking} openBooking={openBooking} refresh={refresh} reminder={putOff(booking)} />)}</ul>
      {(owing.length > 0 || canSettleAll) && <div className="admin-review-client-foot">
        {owing.length > 1
          ? <ReminderBox label={owing.length === 2 ? 'Remind about both' : `Remind about all ${owing.length}`} phone={group.first.clients?.phone} makeText={bank => combinedReminderText(owing, bank, first)} />
          : owing.length === 1 && <PaymentReminder booking={owing[0]} owing={owing} />}
        {canSettleAll && <AllReceived group={group} refresh={refresh} />}
      </div>}
    </div>}
  </li>
}

export default function PaymentReview({ openBooking, revision, changed }) {
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const readVersion = useRef(0)
  const shownOffset = useRef(null)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)
  // A reminder that has come due is noticed within half a minute.
  const reminders = useReminders()
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const clock = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(clock) }, [])
  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    loadReviewResource(`queue:${offset}:${revision}`, () => paymentReviewApi.queue(offset), 3000).then(data => {
      if (!live || version !== readVersion.current) return
      shownOffset.current = offset
      quiet.succeeded()
      setResult({ offset, ...data })
      setError('')
    }, () => {
      if (!live || version !== readVersion.current) return
      // A page already on screen that cannot be refreshed just now is tried once more, quietly, before anyone is told.
      if (shownOffset.current === offset && quiet.failed()) return
      setError('Could not load payment reviews. Please retry.')
    })
    return () => { live = false }
  }, [offset, attempt, revision, quiet])
  useReturnRefresh(reread)
  // The page on show stays while it is read again.
  const current = result?.offset === offset ? result : null
  async function refresh() {
    const version = ++readVersion.current
    try { const data = await paymentReviewApi.queue(offset); if (version === readVersion.current) { setResult({ offset, ...data }); setError('') } changed?.() }
    catch (error) { if (version === readVersion.current) setError(error.message); throw error }
  }
  const putOff = booking => (needsYou(booking) ? activeReminder(booking, reminders, now) : null)
  // One card per client, closed until tapped. Which cards are open is kept while the list is read again, so a card does not shut under the Admin.
  const [openCards, setOpenCards] = useState(() => new Set())
  const toggle = key => setOpenCards(keys => { const next = new Set(keys); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const sections = current ? groupByClient(current.bookings, { needsYou: booking => needsYou(booking) && !putOff(booking), putOff, isExtra: extraOwed }) : { needs: [], reminded: [], waiting: [] }
  const needCount = sections.needs.reduce((sum, group) => sum + group.active.length, 0)
  const owed = sections.needs.reduce((sum, group) => sum + group.owed, 0)
  const remindedCount = current ? current.bookings.filter(putOff).length : 0
  const waitingCount = current ? current.bookings.filter(booking => !needsYou(booking)).length : 0
  const section = (name, title, groups) => groups.length > 0 && <section className={`admin-review-section is-${name}`} aria-labelledby={`review-${name}`}>
    <h2 id={`review-${name}`} className="admin-review-section-title">{title}</h2>
    <ul role="list" className="admin-review-list">{groups.map(group => <ClientCard key={group.key} group={group} open={openCards.has(group.key)} toggle={() => toggle(group.key)} openBooking={openBooking} refresh={refresh} putOff={putOff} all={current.bookings} />)}</ul>
  </section>
  return <section className="admin-review" aria-labelledby="review-title">
    <header className="admin-review-heading"><div><h1 id="review-title">To check</h1><p>One card for each client. Tap a card to see each booking and confirm a payment, set a reminder or cancel. Nothing is cancelled automatically.</p></div><button className="btn--quiet btn--icon" onClick={() => { quiet.asked(); reread() }} aria-label="Refresh reviews"><Icon name="refresh" size={22} /></button></header>
    {error && <p role={result ? 'status' : 'alert'}>{error} <button onClick={() => { quiet.asked(); reread() }}>Retry reviews</button></p>}
    {!current && !error && <div className="skeleton-rows" role="status"><span className="admin-sr-only">Loading payment reviews…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {current && <>
      {!current.bookings.length && <p className="admin-agenda-empty"><strong>All caught up.</strong>No payments awaiting review on this page.</p>}
      {current.bookings.length > 0 && <p className="admin-review-summary"><strong>{needCount} {needCount === 1 ? 'needs' : 'need'} you</strong>{needCount > 0 ? ` · ${money(owed)}` : ''}{sections.needs.length > 0 ? ` · ${sections.needs.length} ${sections.needs.length === 1 ? 'client' : 'clients'}` : ''}{remindedCount > 0 ? ` · ${remindedCount} ${remindedCount === 1 ? 'reminder' : 'reminders'} set` : ''}{waitingCount > 0 ? ` · ${waitingCount} waiting for the client` : ''}</p>}
      {section('needs', 'Needs you', sections.needs)}
      {section('reminded', 'Reminder set', sections.reminded)}
      {section('waiting', 'Waiting for the client', sections.waiting)}
      {(offset > 0 || current.hasMore) && <nav className="admin-payment-buttons" aria-label="Review pages"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous page</button><button disabled={!current.hasMore || offset >= 10000} onClick={() => setOffset(value => value + 50)}>Next page</button></nav>}
    </>}
  </section>
}
