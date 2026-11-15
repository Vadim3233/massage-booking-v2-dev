import { useEffect, useState } from 'react'
import { boughtBy, giftAdminApi } from './giftApi.js'
import { whatsappNumber } from './contactLinks.js'
import { giftWords, shopLink, shopMessage, whole } from '../client/gift/giftWords.js'
import Icon from '../ui/icons.jsx'
import { toast } from '../ui/toast.js'

const STATUS = { awaiting_payment: 'waiting for payment', ready: 'ready to use', used: 'used' }

// On a client's page: send them the gift voucher link (their own WhatsApp chat, greeted by first name), and the vouchers they have bought.
export default function ClientGiftVoucher({ client, api = giftAdminApi }) {
  const [bought, setBought] = useState([])
  useEffect(() => {
    let live = true
    if (!client.email) return undefined
    api.list().then(rows => { if (live) setBought(boughtBy(rows, client.email)) }, () => { /* the list simply stays empty */ })
    return () => { live = false }
  }, [api, client.email])
  const link = shopLink(window.location.origin)
  const text = shopMessage(link, client.first_name)
  const number = whatsappNumber(client.phone)
  async function copy() {
    try { await navigator.clipboard.writeText(text); toast('Message copied') } catch { toast(link) }
  }
  return <section aria-labelledby="client-gift-title"><h2 id="client-gift-title">Gift vouchers</h2>
    <p className="admin-detail-hint">Send {client.first_name || 'them'} the link to buy a massage as a present for someone.</p>
    <div className="admin-payment-buttons">
      {number && <a className="btn btn--tonal btn--small" href={`https://wa.me/${number}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={18} />Send gift voucher link</a>}
      <button type="button" className="btn--quiet btn--small" onClick={copy}><Icon name="copy" size={18} />Copy the message</button>
    </div>
    {bought.length > 0 && <ul className="admin-detail-hint client-gift-bought">{bought.map(v => <li key={v.id}>Bought {giftWords(v.minutes, v.people).toLowerCase()} for {v.recipient_name} ({whole(v.price_gbp)}), {STATUS[v.status] || v.status}.</li>)}</ul>}
  </section>
}
