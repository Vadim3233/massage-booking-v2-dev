import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createGiftApi } from './giftApi.js'
import { bookingLink, codeShown, giftWords, londonDate, whatsappHref, whatsappText, whole } from './giftWords.js'
import VoucherCard from './VoucherCard.jsx'
import { friendlyError } from '../booking/friendlyError.js'
import '../booking/booking.css'
import './voucher.css'
import './gift.css'

const SCRATCHES = 3
const Snow = () => <div className="gift-snow gift-snow--full" aria-hidden="true" />
const Confetti = () => <div className="gift-confetti" aria-hidden="true">{Array.from({ length: 30 }, (_, i) => <i key={i} style={{ left: `${(i * 97) % 100}%`, top: `${(i * 53) % 100}%`, '--turn': `${(i * 37) % 180}deg`, '--hue': i % 4 }} />)}</div>

// /gift/<code>: the voucher. It opens like a present (an envelope, then a gold circle to scratch), then shows the voucher to print, save or
// send on WhatsApp, with "Choose my day" to book with it.
export default function GiftOpen({ code, client = supabase }) {
  const api = useMemo(() => createGiftApi(client), [client])
  const [voucher, setVoucher] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [stage, setStage] = useState('envelope')
  const [scratches, setScratches] = useState(0)
  const [areas, setAreas] = useState([])
  useEffect(() => { document.title = 'Your gift · VadMassage' }, [])
  useEffect(() => {
    let live = true
    api.voucher(code).then(row => { if (live) { setVoucher(row?.state ? row : { state: 'missing' }); setError('') } }, failure => { if (live) setError(friendlyError(failure)) })
    return () => { live = false }
  }, [api, code, attempt])
  // The areas Vadim visits, named on the voucher page so the person knows where it can be used.
  useEffect(() => {
    let live = true
    api.options().then(data => { if (live) setAreas(data?.areas || []) }, () => { /* the list is simply left out */ })
    return () => { live = false }
  }, [api])
  useEffect(() => {
    if (scratches < SCRATCHES) return undefined
    const timer = setTimeout(() => setStage('card'), 500)
    return () => clearTimeout(timer)
  }, [scratches])
  useEffect(() => { document.querySelector('.gift-open h1')?.focus({ preventScroll: true }) }, [stage])

  const origin = window.location.origin
  const page = (children, dark = false) => <div className={`booking-shell gift-shell gift-open ${dark ? 'gift-open--dark' : ''}`}>
    {dark && <Snow />}
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/gift">Give a gift</a></header>
    <main className="booking-main gift-main">{children}</main>
  </div>
  if (error) return page(<><p role="alert" className="error">{error}</p><button className="btn--tonal" onClick={() => setAttempt(value => value + 1)}>Try again</button></>)
  if (!voucher) return page(<p role="status">Opening your gift…</p>)
  const shown = codeShown(code)
  if (voucher.state === 'missing') return page(<><h1 tabIndex={-1}>That code doesn't <em>work</em></h1><p className="lede">Please check it ({shown}), or message Vadim.</p><a className="btn btn--tonal" href="https://vadmassage.com">Contact Vadim</a></>)
  if (voucher.state === 'waiting') return page(<><h1 tabIndex={-1}>Your gift is <em>on its way</em></h1><p className="lede">This voucher is waiting for its payment to arrive. It will open here as soon as it has.</p></>)
  if (voucher.state === 'used') return page(<><h1 tabIndex={-1}>This gift has been <em>used</em></h1><p className="lede">The massage has been booked. Need to change it? Look in <a href="/account">Your bookings</a>, or message Vadim.</p></>)
  if (voucher.state === 'expired') return page(<><h1 tabIndex={-1}>This gift has <em>ended</em></h1><p className="lede">It could be used until {londonDate(voucher.expires_at)}. Please message Vadim and he'll see what he can do.</p><a className="btn btn--tonal" href="https://vadmassage.com">Contact Vadim</a></>)

  const what = `${giftWords(voucher.minutes, voucher.people)}${(voucher.extras || []).map(name => `, ${name.toLowerCase()}`).join('')}, at your home`
  if (stage === 'envelope') return page(<section className="gift-unwrap">
    <p className="gift-eyebrow">{voucher.from_name} sent you a gift</p>
    <h1 tabIndex={-1} className="sr-only">A gift for {voucher.recipient_name}</h1>
    <div className="gift-envelope" aria-hidden="true"><svg viewBox="0 0 320 210" preserveAspectRatio="none"><path d="M0 0 L160 110 L320 0" fill="#c93a35" stroke="#9e2220" strokeWidth="2" /></svg><span className="gift-envelope-band" /><span className="gift-envelope-name v-foil">{voucher.recipient_name}</span></div>
    <button className="gift-gold-button" onClick={() => setStage('scratch')}>Open your gift</button>
    <button className="gift-skip" onClick={() => setStage('card')}>Skip to the voucher</button>
  </section>, true)
  if (stage === 'scratch') return page(<section className="gift-unwrap">
    <div className="gift-note">
      <p className="gift-eyebrow gift-eyebrow--dark">{/christmas|xmas/i.test(voucher.message || '') ? 'Merry Christmas' : 'A gift for you'}</p>
      <h1 tabIndex={-1} className="gift-script v-foil">{voucher.recipient_name}</h1>
      {voucher.message && <p className="gift-note-message">“{voucher.message}”</p>}
      <div className="gift-scratch">
        <div className="gift-scratch-under"><b>{giftWords(voucher.minutes, voucher.people)}</b><span>at your home</span></div>
        <button className="gift-scratch-cover" style={{ opacity: Math.max(0, 1 - scratches * 0.32) }} disabled={scratches >= SCRATCHES}
          onClick={() => setScratches(value => value + 1)} onPointerMove={event => { if (event.buttons) setScratches(value => Math.min(SCRATCHES, value + 0.05)) }}>
          <span>{scratches === 0 ? 'Scratch to reveal' : 'Keep scratching'}</span></button>
      </div>
    </div>
  </section>, true)

  const message = whatsappText({ ...voucher, code: shown }, origin)
  return page(<section className="gift-reveal">
    {scratches >= SCRATCHES && <Confetti />}
    <p className="gift-script v-foil" aria-hidden="true">Surprise!</p>
    <h1 tabIndex={-1}>{what}</h1>
    <p className="lede">From {voucher.from_name}, already paid for. Choose any day that suits you, any time before {londonDate(voucher.expires_at)}.
      {voucher.travel_choice === 'none' && ' The voucher pays for the massage. If you live where there is a travel fee or congestion charge, you pay just that when you book.'}
      {voucher.travel_choice === 'area' && voucher.area_name && ` The travel to ${voucher.area_name} is included too.`}
      {voucher.travel_choice === 'all' && ' Any travel fee or congestion charge in my areas is included too.'}
      {voucher.travel_choice === 'upto' && ` Travel and congestion are included up to ${whole(voucher.travel_cover)}.`}</p>
    {voucher.travel_choice !== 'area' && areas.length > 0 && <p className="fine">Vadim comes to your home in {areas.map(item => item.name).join(', ')}.</p>}
    <a className="btn btn--primary btn--lg btn--block gift-book" href={bookingLink(origin, code)}>Choose my day</a>
    <div className="gift-print-area"><VoucherCard voucher={{ ...voucher, code }} qrText={bookingLink(origin, code)} /></div>
    <div className="gift-actions">
      <button className="btn--tonal" onClick={() => window.print()}>Print or save as PDF</button>
      <a className="btn btn--tonal" href={whatsappHref(message)} target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
    </div>
    <p className="fine">Your code is <strong>{shown}</strong>. To book, press Choose my day, scan the code on the voucher, or enter the code when you book.</p>
    <button className="gift-skip gift-skip--light" onClick={() => { setScratches(0); setStage('envelope') }}>Open it again</button>
  </section>, true)
}
