import { useEffect, useRef, useState } from 'react'
import { shopLink, shopMessage, whatsappHref } from '../client/gift/giftWords.js'
import Icon from '../ui/icons.jsx'

// The gift voucher buying page's link, ready to copy or send: at the top of Gift vouchers, and on Your booking link.
export default function GiftShopLink({ title = 'Your gift voucher link', headingLevel = 2 }) {
  const link = shopLink(window.location.origin)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setError('') } catch { setCopied(false); setError('Could not copy it. Press and hold the link to copy it yourself.') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2400)
  }
  const Heading = `h${headingLevel}`
  return <section className="gift-shop-link" aria-labelledby="gift-shop-link-title">
    <Heading id="gift-shop-link-title">{title}</Heading>
    <p className="admin-detail-hint">Share it anywhere: WhatsApp status, Instagram bio, your website. It opens the page where people buy a voucher.</p>
    <label className="admin-field">The link<input readOnly value={link} onFocus={event => event.target.select()} /></label>
    <div className="admin-payment-buttons">
      <button type="button" className="btn--primary" onClick={copy}><Icon name={copied ? 'tick' : 'copy'} size={18} />{copied ? 'Copied' : 'Copy link'}</button>
      <a className="btn btn--tonal" href={whatsappHref(shopMessage(link))} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={18} />Send on WhatsApp</a>
      <a className="btn btn--quiet" href={link} target="_blank" rel="noopener noreferrer">Open the page</a>
    </div>
    <p className="sr-only" role="status">{copied ? 'Link copied' : ''}</p>
    {error && <p role="alert" className="admin-field-error">{error}</p>}
  </section>
}
