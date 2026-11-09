import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useBookingRules } from '../bookingRules.js'
import { clientFaq } from './faqContent.js'
import FaqList from './FaqList.jsx'
import '../booking/booking.css'

// /faq: answers to the questions clients ask, with the numbers taken from the live booking rules and areas.
export default function FaqPage({ client = supabase }) {
  const rules = useBookingRules(client)
  const [areas, setAreas] = useState([])

  useEffect(() => { document.title = 'Questions and answers · VadMassage' }, [])
  useEffect(() => {
    let live = true
    client.from('service_areas').select('name,travel_surcharge_gbp,congestion_fee_gbp,minimum_booking_minutes').eq('active', true).order('display_order')
      .then(({ data, error }) => { if (live && !error && data) setAreas(data) }, () => {})
    return () => { live = false }
  }, [client])

  return <div className="booking-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/">Book now</a></header>
    <main className="booking-main">
      <h1 tabIndex={-1}>Questions and <em>answers</em></h1>
      <p className="lede">Everything about booking, paying, changing your appointment and receipts. Can't find your answer? Just ask me.</p>
      <FaqList sections={clientFaq({ rules, areas })} />
      <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
    </main>
  </div>
}
