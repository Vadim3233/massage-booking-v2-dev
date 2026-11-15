import { useState } from 'react'
import { money } from '../bookingDraft.js'
import { cleanGiftCode } from '../giftCode.js'

const length = minutes => (minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`)

// At the top of the booking while a gift voucher is being used: what it gives, and what is still to choose.
export function GiftCard({ gift, remove }) {
  const travel = gift.travel === 'all' ? 'Any travel fee or congestion charge is included too.'
    : gift.travel === 'area' && gift.area ? `The travel to ${gift.area} is included too.`
      : 'If you live where there is a travel fee or congestion charge, you pay just that.'
  return <section className="gift-card" aria-labelledby="gift-card-title">
    <p className="gift-card-tag">Gift voucher from {gift.from}</p>
    <h1 id="gift-card-title" tabIndex={-1}>Your <em>gift</em>: a {length(gift.minutes)} massage{gift.people === 2 ? ' for two' : ''}</h1>
    <p>It's already paid for. {travel} Choose your area, treatment and a time that suits you.</p>
    <p className="fine">You can choose a longer massage and pay only the difference.</p>
    {remove && <button type="button" className="btn--quiet btn--small" onClick={remove}>Book without the voucher</button>}
  </section>
}

// Under the areas: a way in for someone who has a code but not the link.
export function GiftCodeBox() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const clean = cleanGiftCode(code)
  return <section className="gift-code-box">
    {!open ? <button type="button" className="btn--quiet btn--small" aria-expanded="false" onClick={() => setOpen(true)}>Have a gift voucher? Enter its code</button>
      : <form onSubmit={event => { event.preventDefault(); if (clean.length === 8) window.location.assign(`/?gift=${clean}`) }}>
        <label className="field">Gift voucher code<input autoFocus value={code} maxLength={12} autoCapitalize="characters" autoComplete="off" placeholder="7K3M-QX9P" onChange={event => setCode(event.target.value)} /></label>
        <button type="submit" className="btn--tonal" disabled={clean.length !== 8}>Use this code</button>
      </form>}
  </section>
}

// Under the price on the review screen: what the voucher pays, and what is left.
export function GiftPriceLines({ lines, from }) {
  if (!lines) return null
  return <dl className="prices gift-prices">
    <div><dt>Gift voucher from {from}</dt><dd>−{money(lines.covered)}</dd></div>
    <div className="prices-total"><dt>To pay</dt><dd className="figure">{money(lines.toPay)}</dd></div>
  </dl>
}
