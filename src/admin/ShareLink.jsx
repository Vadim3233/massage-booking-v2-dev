import { useEffect, useRef, useState } from 'react'
import { adminNewBookingApi } from './newBookingApi.js'
import { bookingLink } from '../client/booking/deepLink.js'
import Icon from '../ui/icons.jsx'

// The address of the booking page, ready to paste into a message or a profile, with an optional way to start part-way through.
export default function ShareLink({ api = adminNewBookingApi }) {
  const [catalogue, setCatalogue] = useState(null)
  const [error, setError] = useState('')
  const [area, setArea] = useState('')
  const [service, setService] = useState('')
  const [minutes, setMinutes] = useState('')
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => {
    let live = true
    api.catalogue().then(data => { if (live) setCatalogue(data) }, () => { if (live) setError('Could not load your areas and treatments. The plain link below still works.') })
    return () => { live = false; clearTimeout(timer.current) }
  }, [api])
  const areaName = catalogue?.areas.find(item => item.id === area)?.name
  const serviceName = catalogue?.services.find(item => item.id === service)?.name
  const lengths = catalogue && service ? catalogue.prices.filter(price => price.service_id === service).map(price => price.duration_minutes) : []
  const link = bookingLink(window.location.origin, { area: areaName, treatment: serviceName, minutes: Number(minutes) || undefined })
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setCopied(false); setError('Could not copy it. Press and hold the link to copy it yourself.') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2400)
  }
  return <section className="admin-review" aria-labelledby="link-title">
    <header className="admin-review-heading"><div><h1 id="link-title">Your booking link</h1><p>Send it to a client, or put it in your Instagram bio or WhatsApp status. It opens your booking page.</p></div></header>
    <div className="share-link">
      <label className="admin-field">The link<input readOnly value={link} onFocus={event => event.target.select()} /></label>
      <div className="admin-payment-buttons">
        <button className="btn--primary" onClick={copy}><Icon name={copied ? 'tick' : 'copy'} size={18} />{copied ? 'Copied' : 'Copy link'}</button>
        <a className="btn btn--tonal" href={`https://wa.me/?text=${encodeURIComponent(`Book a massage with me here: ${link}`)}`} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={18} />Send on WhatsApp</a>
      </div>
      <p className="sr-only" role="status">{copied ? 'Link copied' : ''}</p>
    </div>
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    {catalogue && <details className="more share-more">
      <summary><span className="more-title">A link that starts part-way through</span><span className="more-hint">Optional</span></summary>
      <div className="more-body">
        <p className="admin-detail-hint">Choose an area and a treatment and the client lands on the choice of time, with those already chosen.</p>
        <label className="admin-field">Area<select value={area} onChange={event => setArea(event.target.value)}><option value="">Any area</option>{catalogue.areas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="admin-field">Treatment<select value={service} onChange={event => { setService(event.target.value); setMinutes('') }}><option value="">Any treatment</option>{catalogue.services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {lengths.length > 0 && <label className="admin-field">Length<select value={minutes} onChange={event => setMinutes(event.target.value)}><option value="">Let them choose</option>{lengths.map(length => <option key={length} value={length}>{length} minutes</option>)}</select></label>}
        {area && !service && <p className="admin-detail-hint">Add a treatment as well, or the client will choose it themselves.</p>}
      </div>
    </details>}
  </section>
}
