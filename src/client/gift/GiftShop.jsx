import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createGiftApi, sendAtFor } from './giftApi.js'
import { designsInOrder, giftChoices, isChristmasTime, MESSAGE_LIMIT, occasionsInOrder, REFUND_DAYS, renameSignOff, travelTiers, whole, withLove } from './giftWords.js'
import VoucherCard from './VoucherCard.jsx'
import BankDetails from '../booking/components/BankDetails.jsx'
import { bankFromSettings, chooseBank, paymentConfig } from '../booking/paymentConfig.js'
import { friendlyError } from '../booking/friendlyError.js'
import { downloadReceiptPdf } from '../../lib/receiptPdf.js'
import '../booking/booking.css'
import './voucher.css'
import './gift.css'

const fallbackBank = paymentConfig(import.meta.env)
const emailOk = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())

function Choice({ pressed, onClick, title, note, children, className = '' }) {
  return <button type="button" className={`gift-choice ${className}`} aria-pressed={pressed} onClick={onClick}>
    <span className="gift-radio" aria-hidden="true" /><span className="gift-choice-text"><span className="gift-choice-title">{title}</span>{note && <span className="gift-choice-note">{note}</span>}</span>{children}
  </button>
}

// /gift: buy a massage as a present. Anyone can, with no account: they pay by bank transfer and Vadim sends the voucher once it arrives.
export default function GiftShop({ client = supabase }) {
  const api = useMemo(() => createGiftApi(client), [client])
  const [options, setOptions] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const longDay = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(iso))
  const designs = useMemo(() => designsInOrder(), [])
  const occasions = useMemo(() => occasionsInOrder(), [])
  const [pick, setPick] = useState(null)
  const [design, setDesign] = useState(designs[0].id)
  const [to, setTo] = useState('')
  const [from, setFrom] = useState('')
  const [occasion, setOccasion] = useState(0)
  const [line, setLine] = useState(0)
  const [custom, setCustom] = useState(null)
  const [tierKey, setTierKey] = useState('all')
  const [extras, setExtras] = useState([])
  const [terms, setTerms] = useState(false)
  const [delivery, setDelivery] = useState('self')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [sendDay, setSendDay] = useState('')
  const [buyer, setBuyer] = useState({ name: '', email: '', phone: '' })
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get('t'))
  const [purchase, setPurchase] = useState(null)

  useEffect(() => { document.title = 'Give a massage as a gift · VadMassage' }, [])
  useEffect(() => {
    let live = true
    api.options().then(data => { if (live) { setOptions(data); setLoadError('') } }, failure => { if (live) setLoadError(friendlyError(failure)) })
    return () => { live = false }
  }, [api, attempt])
  useEffect(() => {
    if (!token) return undefined
    let live = true
    api.purchase(token).then(data => { if (live) setPurchase(data || { missing: true }) }, failure => { if (live) setError(friendlyError(failure)) })
    return () => { live = false }
  }, [api, token])

  const choices = useMemo(() => (options ? giftChoices(options.lengths) : []), [options])
  const chosen = choices.find(item => item.key === pick) || choices.find(item => item.loved) || choices[0]
  const message = custom ?? withLove(occasions[occasion].messages[line], from || '…')
  const tiers = useMemo(() => (options ? travelTiers(options) : []), [options])
  const tier = tiers.find(item => item.key === tierKey) || tiers[tiers.length - 1] || { choice: 'none', cover: 0 }
  const travel = tier.cover
  const enhancements = options?.enhancements || []
  const extrasChosen = enhancements.filter(item => extras.includes(item.id))
  const extrasPrice = extrasChosen.reduce((sum, item) => sum + Number(item.price) * (chosen?.people || 1), 0)
  const total = chosen ? chosen.price + travel + extrasPrice : 0
  const problems = {
    to: !to.trim() && 'Who is the voucher for?',
    from: !from.trim() && 'Who is it from?',
    message: message.length > MESSAGE_LIMIT && `Please keep the message to ${MESSAGE_LIMIT} letters.`,
    recipientEmail: delivery === 'email' && !emailOk(recipientEmail) && 'Please add their email.',
    sendDay: delivery === 'email' && !sendDay && 'Choose the day it should arrive.',
    buyerName: !buyer.name.trim() && 'Please add your name.',
    buyerEmail: !emailOk(buyer.email) && 'Please add your email, so I can send you the voucher.',
    terms: !terms && 'Please tick the box to say you understand the voucher terms.',
  }
  const firstProblem = Object.entries(problems).find(([, text]) => text)
  const show = key => tried && problems[key] ? <p className="gift-problem" id={`gift-${key}-problem`}>{problems[key]}</p> : null

  async function buy(event) {
    event.preventDefault()
    setTried(true)
    if (firstProblem) { document.getElementById(`gift-${firstProblem[0]}`)?.focus(); return }
    setBusy(true); setError('')
    try {
      const result = await api.buy({ minutes: chosen.minutes, people: chosen.people, travelChoice: tier.choice, travelCover: tier.choice === 'upto' ? tier.cover : null, enhancementIds: extras, terms,
        design, to, from, message, delivery, recipientEmail, sendAt: sendAtFor(sendDay), buyerName: buyer.name, buyerEmail: buyer.email, buyerPhone: buyer.phone })
      const url = new URL(window.location.href)
      url.searchParams.set('t', result.token)
      window.history.replaceState(null, '', url)
      setPurchase({ status: 'awaiting_payment', reference: result.reference, amount: result.amount, recipient_name: to.trim(), minutes: chosen.minutes, people: chosen.people,
        bank: result.bank, delivery, recipient_email: recipientEmail.trim(), transfer_declared: false })
      setToken(result.token)
      window.scrollTo(0, 0)
    } catch (failure) { setError(friendlyError(failure)) } finally { setBusy(false) }
  }
  async function cancelGift(question) {
    if (!window.confirm(question)) return
    setBusy(true); setError('')
    try { setPurchase(await api.cancel(token)) } catch (failure) { setError(friendlyError(failure)) } finally { setBusy(false) }
  }
  // The receipt for what they paid (GV-…), made as a PDF on their phone (20261221100000).
  async function receipt() {
    setBusy(true); setError('')
    try { await downloadReceiptPdf(await api.receipt(token)) } catch (failure) { setError(failure?.message === 'font' ? 'Could not make the PDF. Please try again.' : friendlyError(failure)) } finally { setBusy(false) }
  }
  const receiptButton = purchase?.receipt ? <button type="button" className="btn--tonal btn--block" disabled={busy} onClick={receipt}>{busy ? 'Making your receipt…' : 'Download your receipt'}</button> : null
  async function transferMade() {
    setBusy(true); setError('')
    try { setPurchase(await api.transferMade(token)) } catch (failure) { setError(friendlyError(failure)) } finally { setBusy(false) }
  }

  const shell = children => <div className="booking-shell gift-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/">Book for yourself</a></header>
    <main className="booking-main gift-main">{children}</main>
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vadim</a> · <a href="/faq">Questions and answers</a></footer>
  </div>

  // After buying (or coming back with the private link): how to pay, then the voucher once it is paid.
  if (token) {
    if (!purchase) return shell(<>{error ? <p role="alert" className="error">{error}</p> : <p role="status">Loading your gift…</p>}</>)
    if (purchase.missing) return shell(<><h1 tabIndex={-1}>That link doesn't <em>work</em></h1><p className="lede">Please check it, or message Vadim.</p><a className="btn btn--primary" href="/gift">Buy a gift voucher</a></>)
    const bank = chooseBank(bankFromSettings(purchase.bank), fallbackBank)
    if (purchase.status === 'ready' || purchase.status === 'used') return shell(<>
      <h1 tabIndex={-1}>Your gift is <em>ready</em></h1>
      <p className="lede">Thank you, the payment has arrived. {purchase.delivery === 'email' && purchase.status === 'ready' ? `It will be emailed to ${purchase.recipient_email} on the day you chose. You can also open it yourself:` : 'Open it to print it, save it or send it on WhatsApp.'}</p>
      <a className="btn btn--primary btn--lg btn--block" href={`/gift/${purchase.code}`}>Open the voucher</a>
      <p className="fine">Code: <strong>{purchase.code}</strong></p>
      {receiptButton}
      {error && <p role="alert" className="error">{error}</p>}
      {purchase.status === 'ready' && (purchase.can_refund
        ? <section className="gift-cancel"><h2>Changed your mind?</h2><p>Until {longDay(purchase.refund_until)}, while it hasn't been used, you can cancel the voucher and get your {whole(purchase.amount)} back. The code stops working straight away.</p>
          <button className="btn--quiet" disabled={busy} onClick={() => cancelGift(`Cancel the voucher for ${purchase.recipient_name} and get your ${whole(purchase.amount)} back? The code will stop working straight away.`)}>Cancel and get a refund</button></section>
        : purchase.made_by_vadim ? <p className="fine">To change or cancel this voucher, please <a href="https://vadmassage.com">message Vadim</a>.</p>
          : <p className="fine">Refunds were possible until {longDay(purchase.refund_until)}. If something has gone wrong, please <a href="https://vadmassage.com">message Vadim</a>.</p>)}
    </>)
    if (purchase.status === 'cancelled') return shell(<><h1 tabIndex={-1}>This gift is <em>cancelled</em></h1>
      <p className="lede">{purchase.refunded && Number(purchase.refund_gbp ?? purchase.amount) > 0 ? `Your ${whole(purchase.refund_gbp ?? purchase.amount)} has been sent back to the account it came from.`
        : purchase.refunded ? 'There is nothing more to do.'
        : purchase.refund_requested ? `Your ${whole(purchase.amount)} will be sent back to the account it came from within 3 working days. I'll email you when it's on its way.`
          : 'Nothing was paid, so there is nothing more to do.'}</p>
      {receiptButton}
      {error && <p role="alert" className="error">{error}</p>}
      <p className="fine">Please <a href="https://vadmassage.com">message Vadim</a> if you have any questions. <a href="/gift">Buy a new gift voucher</a></p></>)
    return shell(<>
      <h1 tabIndex={-1}>One last <em>step</em></h1>
      <p className="lede">To finish your gift for {purchase.recipient_name}, please make a bank transfer. As soon as it arrives I'll email you the voucher.</p>
      <section className="amount-card" aria-label="Amount to transfer"><p className="eyebrow">Amount to transfer</p><p className="amount figure">{whole(purchase.amount)}</p></section>
      <section className="panel bank-card"><h2>Bank transfer</h2><BankDetails bank={bank} reference={purchase.reference} /></section>
      {error && <p role="alert" className="error">{error}</p>}
      {purchase.transfer_declared
        ? <p role="status" className="reserved"><span className="reserved-dot" aria-hidden="true" />Thank you! I'll check my bank and send you the voucher.</p>
        : <div className="action-bar"><button className="btn--primary btn--lg btn--block" disabled={busy || !bank.configured} onClick={transferMade}>I've made the bank transfer</button></div>}
      <button className="btn--quiet gift-cancel-link" disabled={busy} onClick={() => cancelGift(purchase.transfer_declared
        ? `Cancel this gift? As you've sent the transfer, I'll send your ${whole(purchase.amount)} back as soon as it arrives.`
        : 'Cancel this gift? Nothing has been paid, so nothing more is needed.')}>{purchase.transfer_declared ? 'Cancel and get a refund' : 'Changed your mind? Cancel this gift'}</button>
      <p className="fine">The link to this page is also in your email, so you can come back to your gift from any phone. The voucher is valid for {options?.months || 12} months from payment.</p>
    </>)
  }

  if (loadError) return shell(<><p role="alert" className="error">{loadError}</p><button className="btn--tonal" onClick={() => setAttempt(value => value + 1)}>Try again</button></>)
  if (!options) return shell(<div className="skeleton-rows" role="status"><span className="sr-only">Loading…</span><span className="skeleton" /><span className="skeleton" /></div>)
  if (!options.on || !chosen) return shell(<><h1 tabIndex={-1}>Gift vouchers are <em>resting</em></h1><p className="lede">They aren't on sale right now. Please message Vadim and he'll help.</p></>)

  const preview = { code: null, minutes: chosen.minutes, people: chosen.people, extras: extrasChosen.map(item => item.name), recipient_name: to.trim() || 'Mum', from_name: from.trim(), message, design, expires_at: null }
  return shell(<form onSubmit={buy} noValidate>
    <section className="gift-hero">
      <div className="gift-snow" aria-hidden="true" />
      <p className="gift-eyebrow">{isChristmasTime() ? 'Christmas gift vouchers' : 'Gift vouchers'}</p>
      <h1 tabIndex={-1}>Give the gift of <em>calm</em></h1>
      <p>A massage at home, on a day that suits them. Ready in minutes, valid for {options.months} months.</p>
      <div className="gift-preview"><VoucherCard voucher={preview} qrText={`${window.location.origin}/gift`} /></div>
    </section>

    <section className="gift-step" aria-labelledby="gift-s1"><h2 id="gift-s1"><span>1</span>Choose the gift</h2>
      <div className="gift-tiles">{choices.map(item => <button type="button" key={item.key} className="gift-tile" aria-pressed={item.key === chosen.key} onClick={() => setPick(item.key)}>
        {item.loved && <span className="gift-badge">Most loved</span>}<span className="gift-tile-title">{item.title}</span><span className="gift-tile-note">{item.note}</span><b>{whole(item.price)}</b></button>)}</div>
    </section>

    <section className="gift-step" aria-labelledby="gift-s2"><h2 id="gift-s2"><span>2</span>Choose the design</h2>
      <div className="gift-designs">{designs.map(item => <button type="button" key={item.id} className="gift-design" aria-pressed={item.id === design} onClick={() => setDesign(item.id)}>
        <span className={`gift-swatch gift-swatch--${item.id}`} aria-hidden="true" />{item.name}</button>)}</div>
    </section>

    <section className="gift-step" aria-labelledby="gift-s3"><h2 id="gift-s3"><span>3</span>Add a personal message</h2>
      <div className="gift-names">
        <label className="field">For<input id="gift-to" value={to} maxLength={60} autoComplete="off" placeholder="Mum" aria-invalid={Boolean(tried && problems.to) || undefined} onChange={e => setTo(e.target.value)} />{show('to')}</label>
        <label className="field">From<input id="gift-from" value={from} maxLength={60} autoComplete="given-name" placeholder="Anna" aria-invalid={Boolean(tried && problems.from) || undefined} onChange={e => { const next = e.target.value; setCustom(text => (text === null ? null : renameSignOff(text, from, next))); setFrom(next) }} />{show('from')}</label>
      </div>
      <p className="gift-label" id="gift-occasion-label">Pick a ready message, or write your own</p>
      <div className="gift-chips" role="group" aria-labelledby="gift-occasion-label">{occasions.map((item, index) => <button type="button" key={item.name} className="gift-chip" aria-pressed={index === occasion} onClick={() => { setOccasion(index); setLine(0); setCustom(null) }}>{item.name}</button>)}</div>
      <div className="gift-lines">{occasions[occasion].messages.map((text, index) => <button type="button" key={text} className="gift-line" aria-pressed={custom === null && index === line} onClick={() => { setLine(index); setCustom(null) }}>“{text}”</button>)}</div>
      <label className="field">Your message (you can change it)<textarea id="gift-message" rows={3} value={message} maxLength={MESSAGE_LIMIT + 20} onChange={e => setCustom(e.target.value)} />{show('message')}</label>
    </section>

    <section className="gift-step" aria-labelledby="gift-s4"><h2 id="gift-s4"><span>4</span>Where do they live?</h2>
      <p className="gift-hint">I only visit the areas below. Please don't buy a voucher for someone who lives elsewhere.</p>
      <div className="gift-stack" role="group" aria-labelledby="gift-s4">
        {tiers.map((item, index) => <Choice key={item.key} className="gift-tier" pressed={tier.key === item.key} onClick={() => setTierKey(item.key)}
          title={<>{item.key === 'all' && tiers.length > 1 && <span className="gift-tier-tag">Not sure? Choose this</span>}<span className="gift-tier-top"><span>{item.title}</span><span className="gift-tier-price">+{whole(item.cover)}</span></span></>}
          note={item.key === 'none'
            ? <>Nothing more to pay in <b>{item.names.join(', ')}</b>.{tiers.length > 1 && ' Anywhere else in my areas they pay just that area\'s charge when they book.'}</>
            : item.key === 'all'
              ? <>Any of my areas, including {item.charged.map((group, i) => <span key={group.label}>{i > 0 && '; '}<b>{group.names.join(', ')}</b> ({group.label.toLowerCase()})</span>)}. They never pay extra. One flat amount, not refunded if their area has no charge.</>
              : <>For <b>{item.or}</b>, and every area {index === 1 ? 'in the first card' : 'in the cards above'}.</>} />)}
      </div>
      <p className="gift-hint">Not in these areas? <a href="https://vadmassage.com">Message Vadim</a> before buying.</p>
    </section>

    {enhancements.length > 0 && <section className="gift-step" aria-labelledby="gift-sx"><h2 id="gift-sx"><span>5</span>Add something extra?</h2>
      <p className="gift-hint">Optional. Paid now, so it is part of the gift{chosen?.people === 2 ? ', for both of them' : ''}.</p>
      <div className="gift-stack">{enhancements.map(item => { const on = extras.includes(item.id); const price = Number(item.price) * (chosen?.people || 1)
        return <button type="button" key={item.id} className="gift-choice gift-extra" aria-pressed={on} onClick={() => setExtras(on ? extras.filter(id => id !== item.id) : [...extras, item.id])}>
          <span className="gift-check" aria-hidden="true" /><span className="gift-choice-text"><span className="gift-choice-title"><span className="gift-tier-top"><span>{item.name}</span><span className="gift-tier-price">{price > 0 ? `+${whole(price)}` : 'Free'}</span></span></span>
            {item.description && <span className="gift-choice-note">{item.description}</span>}</span></button> })}</div>
    </section>}

    <section className="gift-step" aria-labelledby="gift-s5"><h2 id="gift-s5"><span>{enhancements.length ? 6 : 5}</span>How should it arrive?</h2>
      <div className="gift-stack">
        <Choice pressed={delivery === 'self'} onClick={() => setDelivery('self')} title="I'll give it myself" note="A voucher to print or save as a PDF, plus a button to send it on WhatsApp." />
        <Choice pressed={delivery === 'email'} onClick={() => setDelivery('email')} title="Surprise them by email" note="It arrives on the day you choose, in a red envelope they open and scratch to reveal." />
      </div>
      {delivery === 'email' && <div className="gift-names">
        <label className="field">Their email<input id="gift-recipientEmail" type="email" inputMode="email" autoComplete="off" value={recipientEmail} aria-invalid={Boolean(tried && problems.recipientEmail) || undefined} onChange={e => setRecipientEmail(e.target.value)} />{show('recipientEmail')}</label>
        <label className="field">On which day?<input id="gift-sendDay" type="date" min={londonToday()} value={sendDay} aria-invalid={Boolean(tried && problems.sendDay) || undefined} onChange={e => setSendDay(e.target.value)} /><span className="field-hint">It arrives at 8 in the morning, once the payment has arrived.</span>{show('sendDay')}</label>
      </div>}
    </section>

    <section className="gift-step" aria-labelledby="gift-s6"><h2 id="gift-s6"><span>{enhancements.length ? 7 : 6}</span>Your details</h2>
      <p className="gift-hint">So I can send you the payment details and the voucher.</p>
      <label className="field">Your name<input id="gift-buyerName" autoComplete="name" value={buyer.name} aria-invalid={Boolean(tried && problems.buyerName) || undefined} onChange={e => setBuyer({ ...buyer, name: e.target.value })} />{show('buyerName')}</label>
      <label className="field">Your email<input id="gift-buyerEmail" type="email" inputMode="email" autoComplete="email" value={buyer.email} aria-invalid={Boolean(tried && problems.buyerEmail) || undefined} onChange={e => setBuyer({ ...buyer, email: e.target.value })} />{show('buyerEmail')}</label>
      <label className="field">Your phone (optional)<input id="gift-buyerPhone" type="tel" inputMode="tel" autoComplete="tel" value={buyer.phone} onChange={e => setBuyer({ ...buyer, phone: e.target.value })} /></label>
      <label className="check gift-terms"><input id="gift-terms" type="checkbox" checked={terms} aria-invalid={Boolean(tried && problems.terms) || undefined} onChange={e => setTerms(e.target.checked)} />
        <span>I understand the voucher is for a massage at home in Vadim's areas listed above, lasts {options.months || 12} months from payment, and can be refunded within {REFUND_DAYS} days of buying if it hasn't been used. After that it can't be refunded or exchanged for cash.</span></label>
    </section>

    <section className="gift-total" aria-live="polite">
      <div><p className="gift-total-label">Total</p><p className="gift-total-sum figure">{whole(total)}</p>
        <p className="gift-hint">{chosen.title}{travel > 0 ? ` + ${whole(travel)} ${tier.key === 'all' ? 'travel and congestion, any of my areas' : 'travel and congestion'}` : ''}{extrasChosen.map(item => ` + ${item.name.toLowerCase()}`).join('')}. Paid by bank transfer.</p></div>
      {error && <p role="alert" className="error">{error}</p>}
      {tried && firstProblem && <p role="alert" className="gift-problem">{firstProblem[1]}</p>}
      <button type="submit" className="btn--primary btn--lg btn--block" disabled={busy}>{busy ? 'Please wait…' : 'Continue to payment'}</button>
    </section>
  </form>)
}
