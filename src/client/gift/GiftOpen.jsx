import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createGiftApi } from './giftApi.js'
import { bookingLink, codeShown, giftEmail, giftLink, giftWords, londonDate, mailtoHref, whatsappHref, whatsappText, whole } from './giftWords.js'
import VoucherCard from './VoucherCard.jsx'
import Confetti from './Confetti.jsx'
import { envelopeFor } from './giftEnvelopes.js'
import { friendlyError } from '../booking/friendlyError.js'
import '../booking/booking.css'
import './voucher.css'
import './gift.css'

// /gift/<code>: the voucher. It opens like a present (Vadim's envelope picture for the voucher's design, then "Surprise!"), then shows the voucher to print, save or
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
  const linkRef = useRef(null)
  const copiedTimer = useRef(0)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  // A link the phone wouldn't copy is shown, selected, to copy by hand (once it is on screen).
  useEffect(() => { if (copied === 'link-select') selectText(linkRef.current) }, [copied])
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
  // Each step starts at the top (the envelope page can be scrolled to its button on a small phone).
  useEffect(() => { window.scrollTo?.(0, 0); document.querySelector('.gift-open h1')?.focus({ preventScroll: true }) }, [stage])

  const origin = window.location.origin
  // The envelope and the voucher pages take the envelope's paper colour; the other messages (not found, used...) stay plain.
  const page = (children, envelope = null) => <div className={`booking-shell gift-shell gift-open${envelope ? ` gift-open--paper gift-open--${envelope.name}` : ''}`}>
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
  const envelope = envelopeFor(voucher.design)
  const open = () => { setOpened(true); setStage('card') }
  if (stage === 'envelope') return page(<section className="gift-unwrap">
    <p className="gift-eyebrow">{voucher.from_name} sent you a gift</p>
    <h1 tabIndex={-1} className={`gift-for${String(voucher.recipient_name || '').length > 14 ? ' gift-for--long' : ''}`}><span>For</span> {voucher.recipient_name}</h1>
    {/* The picture opens the gift too, as people tap the envelope itself. Screen readers and the keyboard use the gold button, so it isn't there twice. */}
    <button className="gift-envelope-picture" onClick={open} tabIndex={-1} aria-hidden="true">
      <img src={envelope.src} width={envelope.w} height={envelope.h} alt="" decoding="async" fetchPriority="high" />
    </button>
    <button className="gift-gold-button" onClick={open}>Open your gift</button>
    <button className="gift-skip" onClick={() => setStage('card')}>Skip to the voucher</button>
  </section>, envelope)

  const message = whatsappText({ ...voucher, code: shown }, origin)
  const book = bookingLink(origin, code)
  const link = giftLink(origin, code)
  const email = giftEmail({ ...voucher, code }, origin)
  // Copy the code (or the gift link); where the phone won't allow it, select it on screen so it can be copied by hand.
  // An earlier "Copied" timer is stopped first, so it can't clear the message for this one.
  const copy = async (text, ref, what) => {
    clearTimeout(copiedTimer.current)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      copiedTimer.current = setTimeout(() => setCopied(''), 2500)
    } catch {
      selectText(ref.current)
      setCopied(`${what}-select`)
    }
  }
  const copyCode = () => copy(shown, codeRef, 'code')
  const copyLink = () => copy(link, linkRef, 'link')
  // The phone's own share menu (Messages, Instagram, Mail...), where the browser has one.
  const shared = { title: email.subject, text: message.split('\n\n')[0], url: link }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (navigator.canShare?.(shared) ?? true)
  // Closing the menu is fine; if the browser refuses to share, copy the link instead so the tap still does something.
  const share = () => navigator.share(shared).catch(failure => { if (failure?.name !== 'AbortError') copyLink() })
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
      <button className="btn--tonal gift-copy" onClick={copyCode}>{copied === 'code' ? 'Copied ✓' : 'Copy code'}</button>
    </div>
    <p className="fine gift-copy-status" role="status">{copied === 'code' ? <span className="sr-only">Code copied</span> : copied === 'link' ? 'Gift link copied. Paste it into a message or an email.'
      : copied.endsWith('-select') ? `Your phone didn't let me copy it, so the ${copied === 'code-select' ? 'code' : 'link'} is selected: hold it to copy.` : ''}</p>
    {/* Sending it on: from the buyer's own email app, WhatsApp, the phone's share menu, or the link to paste anywhere.
        The person it is for sees this page too, so the buttons say who they are for. */}
    <p className="gift-send-title">{voucher.recipient_name ? `Sending it to ${voucher.recipient_name} yourself?` : 'Sending it on yourself?'}</p>
    <div className="gift-actions">
      <a className="btn btn--tonal" href={mailtoHref(email)}>Send by email</a>
      <a className="btn btn--tonal" href={whatsappHref(message)} target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
      {canShare && <button className="btn--tonal" onClick={share}>Share…</button>}
      <button className="btn--tonal" onClick={copyLink}>{copied === 'link' ? 'Copied ✓' : 'Copy gift link'}</button>
      <button className="btn--tonal" onClick={() => window.print()}>Print or save as PDF</button>
    </div>
    {copied === 'link-select' && <p className="fine gift-link"><span ref={linkRef}>{link}</span></p>}
    <p className="fine">To book, tap Book my massage or the voucher, and the code is filled in for you. On a printed voucher, scan the QR code, or enter the code when you book.</p>
    <button className="gift-skip" onClick={() => { setOpened(false); setStage('envelope') }}>Open it again</button>
  </section>, envelope)
}

// Selects a piece of text on screen, ready to copy by hand.
function selectText(node) {
  if (!node) return
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
}
