import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createGiftApi } from './giftApi.js'
import { bookingLink, codeShown, giftWords, londonDate, whatsappHref, whatsappText, whole } from './giftWords.js'
import VoucherCard from './VoucherCard.jsx'
import Confetti from './Confetti.jsx'
import { friendlyError } from '../booking/friendlyError.js'
import '../booking/booking.css'
import './voucher.css'
import './gift.css'

const Snow = () => <div className="gift-snow gift-snow--full" aria-hidden="true" />

// /gift/<code>: the voucher. It opens like a present (an envelope to open, then "Surprise!"), then shows the voucher to print, save or
// send on WhatsApp, with "Book my massage" (above and under it, and the voucher itself is tappable) to book with it, and Copy code.
export default function GiftOpen({ code, client = supabase }) {
  const api = useMemo(() => createGiftApi(client), [client])
  const [voucher, setVoucher] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [stage, setStage] = useState('envelope')
  const [opened, setOpened] = useState(false)
  const [areas, setAreas] = useState([])
  const [copied, setCopied] = useState('')
  const codeRef = useRef(null)
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
    <button className="gift-gold-button" onClick={() => { setOpened(true); setStage('card') }}>Open your gift</button>
    <button className="gift-skip" onClick={() => setStage('card')}>Skip to the voucher</button>
  </section>, true)

  const message = whatsappText({ ...voucher, code: shown }, origin)
  const book = bookingLink(origin, code)
  // Copy the code; where the phone won't allow it, select it on screen so it can be copied by hand.
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(shown)
      setCopied('yes')
      setTimeout(() => setCopied(''), 2500)
    } catch {
      const range = document.createRange()
      if (codeRef.current) { range.selectNodeContents(codeRef.current); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range) }
      setCopied('select')
    }
  }
  return page(<section className="gift-reveal">
    {opened && <Confetti />}
    <p className="gift-script v-foil" aria-hidden="true">Surprise!</p>
    <h1 tabIndex={-1}>{what}</h1>
    <p className="lede">From {voucher.from_name}, already paid for. Choose any day that suits you, any time before {londonDate(voucher.expires_at)}.
      {voucher.travel_choice === 'none' && ' The voucher pays for the massage. If you live where there is a travel fee or congestion charge, you pay just that when you book.'}
      {voucher.travel_choice === 'area' && voucher.area_name && ` The travel to ${voucher.area_name} is included too.`}
      {voucher.travel_choice === 'all' && ' Any travel fee or congestion charge in my areas is included too.'}
      {voucher.travel_choice === 'upto' && ` Travel and congestion are included up to ${whole(voucher.travel_cover)}.`}</p>
    {voucher.travel_choice !== 'area' && areas.length > 0 && <p className="fine">Vadim comes to your home in {areas.map(item => item.name).join(', ')}.</p>}
    <a className="btn btn--primary btn--lg btn--block gift-book" href={book}>Book my massage</a>
    {/* The voucher itself (and its QR code) is a tap-to-book link too: on the phone that holds it, the QR can't be scanned. */}
    <a className="gift-print-area gift-card-link" href={book} aria-label="Book my massage with this voucher"><VoucherCard voucher={{ ...voucher, code }} qrText={book} /></a>
    <a className="btn btn--primary btn--lg btn--block gift-book gift-book--under" href={book}>Book my massage</a>
    <div className="gift-code-row">
      <span>Your code</span>
      <strong ref={codeRef} className="gift-code">{shown}</strong>
      <button className="btn--tonal gift-copy" onClick={copyCode} aria-live="polite">{copied === 'yes' ? 'Copied ✓' : 'Copy code'}</button>
    </div>
    {copied === 'select' && <p className="fine">Your phone didn't let me copy it, so the code is selected: hold it to copy.</p>}
    <div className="gift-actions">
      <button className="btn--tonal" onClick={() => window.print()}>Print or save as PDF</button>
      <a className="btn btn--tonal" href={whatsappHref(message)} target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
    </div>
    <p className="fine">To book, tap Book my massage or the voucher, and the code is filled in for you. On a printed voucher, scan the QR code, or enter the code when you book.</p>
    <button className="gift-skip gift-skip--light" onClick={() => { setOpened(false); setStage('envelope') }}>Open it again</button>
  </section>, true)
}
