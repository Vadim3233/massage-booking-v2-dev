import { useEffect, useState } from 'react'
import { giftAdminApi, giftCsv, giftGroups, giftHistory, matchesSearch } from './giftApi.js'
import { codeShown, DESIGNS, giftLink, giftWords, londonDate, whatsappHref, whatsappText, whole } from '../client/gift/giftWords.js'
import { toast } from '../ui/toast.js'
import GiftShopLink from './GiftShopLink.jsx'
import { sendAtFor } from '../client/gift/giftApi.js'

// A London day (YYYY-MM-DD) for a date input.
const londonDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(iso ? new Date(iso) : new Date())
const addMonths = (day, months) => {
  const [y, m, d] = day.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1 + months, d))
  return next.toISOString().slice(0, 10)
}

// Give a voucher more time: it can then be used until the end of the day chosen. Shown under a ready (or ended) voucher.
function MoreTime({ voucher, busy, act, close }) {
  const today = londonDay()
  const ends = londonDay(voucher.expires_at)
  const [day, setDay] = useState(addMonths(ends < today ? today : ends, 3))
  return <form className="admin-gift-edit" onSubmit={event => { event.preventDefault(); act(() => giftAdminApi.extend(voucher.id, day), `It can be used until ${londonDate(`${day}T12:00:00Z`)}.`).then(done => { if (done) close() }) }}>
    <label className="admin-field">Can be used until<input type="date" required min={today} value={day} onChange={e => setDay(e.target.value)} /></label>
    <div className="admin-payment-buttons"><button type="submit" className="btn--primary btn--small" disabled={busy || !day}>Save</button><button type="button" className="btn--quiet btn--small" onClick={close}>Close</button></div>
  </form>
}

// Correct a voucher's words, or (until it has been emailed) the person's email and the day it goes.
function EditVoucher({ voucher, busy, act, close }) {
  const canResend = voucher.delivery === 'email' && !voucher.recipient_sent_at
  const [form, setForm] = useState({ to: voucher.recipient_name, from: voucher.from_name, message: voucher.message || '',
    email: voucher.recipient_email || '', day: voucher.send_at ? londonDay(voucher.send_at) : '' })
  const change = patch => setForm(current => ({ ...current, ...patch }))
  function save(event) {
    event.preventDefault()
    act(() => giftAdminApi.update(voucher.id, { to: form.to, from: form.from, message: form.message, email: canResend ? form.email : null, sendAt: canResend ? sendAtFor(form.day) : null }), 'Voucher changed.').then(done => { if (done) close() })
  }
  return <form className="admin-gift-edit" onSubmit={save}>
    <label className="admin-field">For<input required value={form.to} maxLength={60} onChange={e => change({ to: e.target.value })} /></label>
    <label className="admin-field">From<input required value={form.from} maxLength={60} onChange={e => change({ from: e.target.value })} /></label>
    <label className="admin-field">Message<textarea rows={3} maxLength={400} value={form.message} onChange={e => change({ message: e.target.value })} /></label>
    {canResend && <>
      <label className="admin-field">Their email<input type="email" required value={form.email} onChange={e => change({ email: e.target.value })} /></label>
      <label className="admin-field">Day it is emailed<input type="date" required value={form.day} onChange={e => change({ day: e.target.value })} /><span className="admin-detail-hint">It goes at 8 in the morning. A day already past sends it within a minute.</span></label>
    </>}
    <div className="admin-payment-buttons"><button type="submit" className="btn--primary btn--small" disabled={busy}>Save</button><button type="button" className="btn--quiet btn--small" onClick={close}>Close</button></div>
  </form>
}

const blankForm = { key: '60x1', design: 'gold_foil', to: '', from: '', message: '', buyerName: '', buyerEmail: '', method: 'cash', travel: 'none', areaId: '', price: '' }

function VoucherRow({ voucher, busy, act, openBooking }) {
  const [open, setOpen] = useState('')
  const origin = window.location.origin
  const what = giftWords(voucher.minutes, voucher.people)
  const travelOnly = voucher.travel_choice === 'all' ? `travel and congestion for any area (${whole(voucher.travel_cover_gbp)})`
    : voucher.travel_choice === 'upto' ? `travel and congestion up to ${whole(voucher.travel_cover_gbp)}`
      : voucher.travel_choice === 'area' ? `travel to ${voucher.service_area_name} (${whole(voucher.travel_cover_gbp)})` : 'massage only'
  const travel = `${travelOnly}${voucher.enhancement_names?.length ? `, plus ${voucher.enhancement_names.join(', ').toLowerCase()}` : ''}`
  const link = giftLink(origin, voucher.code)
  async function copy() {
    try { await navigator.clipboard.writeText(link); toast('Link copied') } catch { toast(link) }
  }
  return <li className="admin-gift">
    <p className="admin-gift-title"><strong>{voucher.recipient_name}</strong> · {what} · {whole(voucher.price_gbp)}</p>
    <p className="admin-detail-hint">From {voucher.from_name}{voucher.buyer_name && voucher.buyer_name !== voucher.from_name ? ` (bought by ${voucher.buyer_name}${voucher.buyer_email ? `, ${voucher.buyer_email}` : ''})` : voucher.buyer_email ? ` (${voucher.buyer_email})` : ''}. Covers {travel}.</p>
    {voucher.status === 'awaiting_payment' && <p className="admin-detail-hint">Bank transfer reference <strong>{voucher.payment_reference}</strong>{voucher.transfer_declared_at ? '. They say the transfer is made.' : '.'}</p>}
    {voucher.status !== 'awaiting_payment' && <p className="admin-detail-hint">Code <strong>{codeShown(voucher.code)}</strong>{voucher.status === 'ready' && ` · ${voucher.expired ? 'Ended' : 'Valid until'} ${londonDate(voucher.expires_at)}`}{voucher.delivery === 'email' && voucher.status === 'ready' ? ` · ${voucher.recipient_sent_at ? 'Emailed to' : 'To be emailed to'} ${voucher.recipient_email}${voucher.recipient_sent_at ? '' : ` on ${londonDate(voucher.send_at)}`}` : ''}</p>}
    {voucher.refund_to_send && <p className="admin-detail-hint admin-gift-refund" role="status"><strong>Refund to send: {whole(voucher.price_gbp)}</strong> to {voucher.buyer_name || 'the buyer'}, reference {voucher.payment_reference}. {voucher.paid_at ? 'They asked for their money back, so the code no longer works.' : 'They cancelled after saying they had sent the money: send it back if it arrives.'}</p>}
    {voucher.booking && <p className="admin-detail-hint">Booked by {voucher.booking.client_name || 'a client'} for {londonDate(`${voucher.booking.date}T12:00:00Z`)}. <button type="button" className="btn--quiet btn--small" onClick={() => openBooking(voucher.booking.id)}>Open booking</button></p>}
    <div className="admin-payment-buttons">
      {voucher.refund_to_send && <>
        <button type="button" className="btn--primary btn--small" disabled={busy} onClick={() => { if (window.confirm(`Have you sent ${whole(voucher.price_gbp)} back to ${voucher.buyer_name || 'the buyer'}? They will be emailed that it is on its way.`)) act(() => giftAdminApi.refundSent(voucher.id, true), 'Refund recorded. The buyer has been told.') }}>Refund sent</button>
        {!voucher.paid_at && <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => { if (window.confirm('Clear this? Do this when the money never arrived, so there is nothing to send back.')) act(() => giftAdminApi.refundSent(voucher.id, false), 'Cleared.') }}>The money never came</button>}
      </>}
      {voucher.status === 'awaiting_payment' && <>
        <button type="button" className="btn--primary btn--small" disabled={busy} onClick={() => act(() => giftAdminApi.markPaid(voucher.id, 'bank_transfer'), 'Marked paid. The voucher is on its way to the buyer.')}>Mark paid, send voucher</button>
        <button type="button" className="btn--tonal btn--small" disabled={busy} onClick={() => act(() => giftAdminApi.markPaid(voucher.id, 'cash'), 'Marked paid in cash.')}>Paid in cash</button>
        <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => { if (window.confirm(`Cancel the voucher for ${voucher.recipient_name}? Do this when the money never came.`)) act(() => giftAdminApi.cancel(voucher.id), 'Cancelled.') }}>Not paid, cancel it</button>
      </>}
      {voucher.status === 'ready' && <>
        <a className="btn btn--tonal btn--small" href={link} target="_blank" rel="noopener noreferrer">Open voucher</a>
        <button type="button" className="btn--tonal btn--small" onClick={copy}>Copy link</button>
        <a className="btn btn--tonal btn--small" href={whatsappHref(whatsappText(voucher, origin))} target="_blank" rel="noopener noreferrer">WhatsApp</a>
        <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => { if (window.confirm(`Mark the voucher for ${voucher.recipient_name} as used? Do this when it was used without an online booking.`)) act(() => giftAdminApi.markUsed(voucher.id, true), 'Marked used.') }}>Mark used</button>
        <button type="button" className="btn--quiet btn--small" aria-expanded={open === 'time'} onClick={() => setOpen(open === 'time' ? '' : 'time')}>{voucher.expired ? 'Give more time' : 'More time'}</button>
        <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => { if (window.confirm(`Cancel the voucher for ${voucher.recipient_name}? Do this after you have refunded ${voucher.buyer_name || 'the buyer'}. Its code will stop working.`)) act(() => giftAdminApi.cancel(voucher.id), 'Cancelled. The code no longer works.') }}>Refunded, cancel it</button>
      </>}
      {voucher.status !== 'cancelled' && <button type="button" className="btn--quiet btn--small" aria-expanded={open === 'edit'} onClick={() => setOpen(open === 'edit' ? '' : 'edit')}>Change details</button>}
      {voucher.status === 'used' && (!voucher.booking_id || voucher.booking?.status === 'cancelled') && <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => act(() => giftAdminApi.markUsed(voucher.id, false), 'It can be used again.')}>Not used after all</button>}
    </div>
    {open === 'time' && voucher.status === 'ready' && <MoreTime voucher={voucher} busy={busy} act={act} close={() => setOpen('')} />}
    {open === 'edit' && <EditVoucher voucher={voucher} busy={busy} act={act} close={() => setOpen('')} />}
    <details className="admin-gift-history">
      <summary>History</summary>
      <ol>{giftHistory(voucher).map((step, index) => <li key={index}><span className="admin-gift-history-day">{step.day}</span> {step.text}</li>)}</ol>
    </details>
  </li>
}

function MakeVoucher({ options, done }) {
  const [form, setForm] = useState(blankForm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lengths = options.lengths
  const choices = [...lengths.map(l => ({ key: `${l.minutes}x1`, minutes: l.minutes, people: 1, price: Number(l.price) })),
    ...(lengths[0] ? [{ key: `${lengths[0].minutes}x2`, minutes: lengths[0].minutes, people: 2, price: Number(lengths[0].price) * 2 }] : [])]
  const chosen = choices.find(c => c.key === form.key) || choices[0]
  const area = options.areas.find(a => a.id === form.areaId)
  const cover = form.travel === 'all' ? Number(options.all_areas_cover) : form.travel === 'area' && area ? Number(area.travel) + Number(area.congestion) : 0
  const change = patch => { setError(''); setForm(current => ({ ...current, ...patch })) }
  async function save(event) {
    event.preventDefault()
    if (!form.to.trim()) { setError('Who is the voucher for?'); return }
    if (form.travel === 'area' && !form.areaId) { setError('Choose their area.'); return }
    setBusy(true)
    try { await giftAdminApi.make({ ...form, minutes: chosen.minutes, people: chosen.people }); toast('Voucher made.'); setForm(blankForm); done() }
    catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <form className="admin-client-form" onSubmit={save} aria-labelledby="gift-make-title">
    <h2 id="gift-make-title">Make a voucher</h2>
    <p className="admin-detail-hint">For one paid in cash or in person. It is ready straight away; add the buyer's email to send them the link.</p>
    <label className="admin-field">Gift<select value={chosen?.key} onChange={e => change({ key: e.target.value })}>{choices.map(c => <option key={c.key} value={c.key}>{giftWords(c.minutes, c.people)} · {whole(c.price)}</option>)}</select></label>
    <label className="admin-field">Travel and congestion<select value={form.travel} onChange={e => change({ travel: e.target.value })}>
      <option value="none">Not included (they pay it when they book)</option><option value="all">Included for any area (+{whole(options.all_areas_cover)})</option><option value="area">Included for one area</option></select></label>
    {form.travel === 'area' && <label className="admin-field">Their area<select value={form.areaId} onChange={e => change({ areaId: e.target.value })}><option value="">Choose…</option>{options.areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    <label className="admin-field">Design<select value={form.design} onChange={e => change({ design: e.target.value })}>{DESIGNS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <label className="admin-field">For<input value={form.to} maxLength={60} onChange={e => change({ to: e.target.value })} /></label>
    <label className="admin-field">From<input value={form.from} maxLength={60} onChange={e => change({ from: e.target.value })} /></label>
    <label className="admin-field">Message (optional)<textarea rows={3} maxLength={400} value={form.message} onChange={e => change({ message: e.target.value })} /></label>
    <label className="admin-field">Buyer's name (optional)<input value={form.buyerName} onChange={e => change({ buyerName: e.target.value })} /></label>
    <label className="admin-field">Buyer's email (optional)<input type="email" value={form.buyerEmail} onChange={e => change({ buyerEmail: e.target.value })} /></label>
    <label className="admin-field">Paid by<select value={form.method} onChange={e => change({ method: e.target.value })}><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option></select></label>
    <label className="admin-field">Price paid<input inputMode="decimal" value={form.price} placeholder={String(chosen ? chosen.price + cover : '')} onChange={e => change({ price: e.target.value })} />
      <span className="admin-detail-hint">Leave empty for the usual {whole(chosen ? chosen.price + cover : 0)}.</span></label>
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons"><button type="submit" className="btn--primary" disabled={busy}>Make the voucher</button></div>
  </form>
}

// More › Gift vouchers: the ones waiting for a transfer (mark them paid), the ones ready to use, the used ones, and making one by hand.
export default function GiftVouchers({ openBooking }) {
  const [list, setList] = useState(null)
  const [options, setOptions] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  useEffect(() => {
    let live = true
    Promise.all([giftAdminApi.list(), giftAdminApi.options()]).then(([rows, opts]) => { if (live) { setList(rows || []); setOptions(opts); setError('') } },
      failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [attempt])
  // Says whether it worked, so the small forms close once the change is made (and stay open when it is not).
  async function act(action, message) {
    setBusy(true)
    try { await action(); toast(message); setAttempt(value => value + 1); return true } catch (failure) { toast(failure.message); return false } finally { setBusy(false) }
  }
  if (error && !list) return <section className="admin-review"><h1>Gift vouchers</h1><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!list || !options) return <section className="admin-review"><p role="status">Loading…</p></section>
  const groups = giftGroups(list)
  const found = search.trim() ? list.filter(v => matchesSearch(v, search)) : null
  const typedCode = search.toUpperCase().replace(/[^A-Z0-9]/g, '')
  function download() {
    const blob = new Blob([giftCsv(list)], { type: 'text/csv;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `vadmassage-gift-vouchers-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  const group = (title, items, empty) => <section aria-label={title}><h2 className="admin-group-title">{title} {items.length > 0 && <span className="chip chip--info">{items.length}</span>}</h2>
    {items.length ? <ul role="list" className="admin-gift-list">{items.map(v => <VoucherRow key={v.id} voucher={v} busy={busy} act={act} openBooking={openBooking} />)}</ul> : <p className="admin-detail-hint">{empty}</p>}</section>
  return <section className="admin-review" aria-labelledby="gifts-title">
    <header className="admin-review-heading"><div><h1 id="gifts-title" tabIndex={-1}>Gift vouchers</h1>
      <p>Sold in the last 12 months: {groups.soldCount} {groups.soldCount === 1 ? 'voucher' : 'vouchers'}, {whole(groups.soldTotal)}. Clients buy them at the link below.</p></div></header>
    <GiftShopLink />
    <div className="admin-gift-find">
      <label className="admin-field">Find a voucher<input type="search" value={search} autoComplete="off" placeholder="Code, name, email or GIFT- reference" onChange={e => setSearch(e.target.value)} /></label>
      <button type="button" className="btn--quiet btn--small" disabled={!list.length} onClick={download}>Download the list</button>
    </div>
    {found ? <section aria-label="Found">
      <h2 className="admin-group-title">{found.length === 1 ? '1 voucher found' : `${found.length} vouchers found`}</h2>
      {found.length ? <ul role="list" className="admin-gift-list">{found.map(v => <VoucherRow key={v.id} voucher={v} busy={busy} act={act} openBooking={openBooking} />)}</ul>
        : <p className="admin-detail-hint">{typedCode.length === 8 ? 'No voucher has this code. Check it was typed right: if it still isn\'t found, the voucher is not one of yours.' : 'Nothing matches. Try the code, or part of a name or email.'}</p>}
    </section> : <>
      {group('Waiting for payment', groups.waiting, 'Nothing waiting. When someone buys a voucher, it shows here until you mark it paid.')}
      {group('Ready to use', groups.ready, 'None at the moment.')}
      {groups.ended.length > 0 && group('Ended unused', groups.ended, '')}
      {group('Used', groups.used, 'None yet.')}
    </>}
    <MakeVoucher options={options} done={() => setAttempt(value => value + 1)} />
  </section>
}
