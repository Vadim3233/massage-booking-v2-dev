import { useEffect, useRef, useState } from 'react'
import { adminNewBookingApi as api, bookingRequest } from './newBookingApi.js'
import { useAdminBookingDraft } from './useAdminBookingDraft.js'
import ClientStep from './newBooking/ClientStep.jsx'
import { emptyAddress } from './newBooking/presentation.js'
import TreatmentStep from './newBooking/TreatmentStep.jsx'
import { DateTimeStep, PaymentStep, Quote, ReviewStep } from './newBooking/BookingSteps.jsx'
import './newBooking/newBooking.css'

const STEPS = ['Client', 'Treatment', 'Date & time', 'Payment & notes', 'Review & create']
const message = error => error?.message || 'Something went wrong. Please retry.'
const EMPTY_CATALOGUE = { areas: [], services: [], prices: [], preferences: [], conflicts: [], enhancements: [] }

export default function AdminNewBooking({ initialDate, initialClientId, ownerId, onCancel, onCreated, registerGuard }) {
  const { draft, patch, step, goStep, clear, meaningful } = useAdminBookingDraft(initialDate, ownerId)
  const [catalogue, setCatalogue] = useState(null)
  const [catalogueError, setCatalogueError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState({ clients: [], loading: true, error: '' })
  const [addressState, setAddressState] = useState({ clientId: '', addresses: [], loading: false, error: '' })
  const [clientBusy, setClientBusy] = useState(false)
  const [clientError, setClientError] = useState('')
  const [quoteState, setQuoteState] = useState(null)
  const [availabilityState, setAvailabilityState] = useState(null)
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const completed = useRef(false)
  const heading = useRef(null)
  const errorRef = useRef(null)
  const current = useRef({ draft, meaningful })
  useEffect(() => { current.current = { draft, meaningful } }, [draft, meaningful])
  const duration = draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
  const quoteKey = JSON.stringify([draft.areaId, draft.serviceId, draft.sessions, draft.enhancementIds])
  const availabilityKey = `${draft.date}:${duration}:${availabilityAttempt}`
  const quote = quoteState?.key === quoteKey ? quoteState.data : null
  const quoteError = quoteState?.key === quoteKey ? quoteState.error : ''
  const availability = availabilityState?.key === availabilityKey ? availabilityState : null
  const locked = busy || Boolean(draft.submission)

  useEffect(() => {
    let live = true
    api.catalogue().then(data => { if (live) { setCatalogue(data); setCatalogueError('') } }, failure => { if (live) setCatalogueError(message(failure)) })
    return () => { live = false }
  }, [attempt])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      setSearch(previous => ({ ...previous, loading: true, error: '' }))
      api.search(query).then(clients => { if (live) setSearch({ clients, loading: false, error: '' }) }, failure => { if (live) setSearch({ clients: [], loading: false, error: message(failure) }) })
    }, query ? 250 : 0)
    return () => { live = false; clearTimeout(timer) }
  }, [query, attempt])
  useEffect(() => {
    if (!draft.client) return
    let live = true
    const id = draft.client.id
    api.addresses(id).then(addresses => {
      if (!live) return
      setAddressState({ clientId: id, addresses, loading: false, error: '' })
    }, failure => { if (live) setAddressState({ clientId: id, addresses: [], loading: false, error: message(failure) }) })
    return () => { live = false }
  }, [draft.client, attempt])
  useEffect(() => {
    if (!draft.areaId || !draft.serviceId || !duration) return
    let live = true
    api.quote(current.current.draft).then(data => { if (live) setQuoteState({ key: quoteKey, data, error: '' }) }, failure => { if (live) setQuoteState({ key: quoteKey, data: null, error: message(failure) }) })
    return () => { live = false }
  }, [quoteKey, draft.areaId, draft.serviceId, duration, attempt])
  useEffect(() => {
    if (!draft.date || !duration || step < 2) return
    let live = true
    api.availability(draft.date, duration).then(slots => { if (live) setAvailabilityState({ key: availabilityKey, slots, error: '' }) }, failure => { if (live) setAvailabilityState({ key: availabilityKey, slots: [], error: message(failure) }) })
    return () => { live = false }
  }, [availabilityKey, draft.date, duration, step])
  useEffect(() => {
    function guard() {
      if (completed.current || !current.current.meaningful) return true
      if (busyRef.current) return false
      if (current.current.draft.submission) return window.confirm('Creation has not been confirmed. Your draft and retry request will be kept. Leave this screen?')
      if (!window.confirm('Discard this unsaved booking?')) return false
      clear()
      return true
    }
    registerGuard?.(guard)
    const unload = event => { if (!completed.current && current.current.meaningful) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => { registerGuard?.(null); window.removeEventListener('beforeunload', unload) }
  }, [registerGuard, clear])
  useEffect(() => { heading.current?.focus() }, [step])
  const startingClient = useRef(false)
  const choose = useRef(null)
  useEffect(() => { choose.current = selectClient })
  useEffect(() => {
    if (!initialClientId || startingClient.current) return
    startingClient.current = true
    api.client(initialClientId).then(found => { if (found && !current.current.draft.client) choose.current(found) }, () => { /* The Admin can still search for the client. */ })
  }, [initialClientId])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  function edit(change) { if (!locked) { patch(change); setError('') } }
  function selectClient(client) {
    patch({ client, details: { ...emptyAddress }, sessions: draft.sessions.map((session, index) => index === 0 && !session.recipient_name ? { ...session, recipient_name: [client.first_name, client.last_name].filter(Boolean).join(' ') } : session) })
    setAddressState({ clientId: client.id, addresses: [], loading: true, error: '' })
    setClientError('')
    api.addresses(client.id).then(addresses => {
      if (current.current.draft.client?.id !== client.id) return
      const saved = addresses.find(address => address.is_default) || addresses[0]
      if (saved) patch({ details: { ...emptyAddress, ...saved, savedAddressId: saved.id } })
    }).catch(() => { /* Address effect supplies the visible error. */ })
  }
  async function createClient(details) {
    if (clientBusy) return false
    setClientBusy(true); setClientError('')
    try {
      // savedAddressId is a form-only field; the server accepts only real client and address fields.
      const payload = { ...details }
      delete payload.savedAddressId
      const result = await api.createClient(payload, crypto.randomUUID())
      const client = result.client || result
      selectClient(client)
      setQuery(client.email || client.phone || client.first_name)
      setAttempt(value => value + 1)
      return true
    } catch (failure) { setClientError(message(failure)); setQuery(details.email || details.phone || details.first_name); return false }
    finally { setClientBusy(false) }
  }
  function validation(target) {
    if (target >= 0 && (!draft.client || !draft.areaId || !draft.details.address_line_1?.trim() || !draft.details.city?.trim() || !draft.details.postcode?.trim())) return [0, 'Choose a client, appointment address and service area.']
    if (target >= 1 && (!draft.serviceId || !draft.sessions.length || draft.sessions.length > 4 || duration > 240 || draft.sessions.some(session => !session.recipient_name.trim() || !catalogue.prices.some(price => price.service_id === draft.serviceId && price.duration_minutes === session.duration_minutes)))) return [1, 'Choose an available treatment and duration, and name each recipient.']
    if (target >= 2 && (!draft.date || draft.start === null || !availability || availability.error || !availability.slots.some(slot => slot.start_minutes === draft.start))) return [2, 'Choose an available appointment time.']
    return null
  }
  function next() {
    const issue = validation(step)
    if (issue) { setError(issue[1]); if (step !== issue[0]) goStep(issue[0]); return }
    setError(''); goStep(step + 1)
  }
  async function create() {
    if (busyRef.current) return
    if (!draft.submission) {
      const issue = validation(3)
      if (issue) { setError(issue[1]); goStep(issue[0]); return }
      if (!quote) { setError('Wait for the current price, or retry loading it.'); return }
    }
    busyRef.current = true; setBusy(true); setError('')
    const submission = draft.submission || { id: crypto.randomUUID(), payload: bookingRequest(draft), repeat: draft.repeat?.on ? { endDate: draft.repeat.endDate || null } : null }
    patch({ submission })
    try {
      const result = submission.repeat ? await api.createSeries(submission.payload, submission.repeat.endDate, submission.id) : await api.create(submission.payload, submission.id)
      completed.current = true; clear()
      onCreated({ ...result, date: submission.payload.date })
    } catch (failure) {
      const definitive = /^[0-9A-Z]{5}$/.test(failure.code || '') && !['57014', '08000', '08006'].includes(failure.code)
      if (definitive) {
        patch({ submission: null })
        if (/slot|available|occupied|past|hold|schedule|blocked/i.test(message(failure))) { patch({ start: null, submission: null }); setAvailabilityAttempt(value => value + 1); goStep(2) }
        setError(message(failure))
      } else setError('The result could not be confirmed. Retry creation to safely check the same request. Your draft is kept and editing is paused.')
    } finally { busyRef.current = false; setBusy(false) }
  }
  const data = catalogue || EMPTY_CATALOGUE
  const addressCurrent = addressState.clientId === draft.client?.id
  return <section className="admin-new-booking" aria-labelledby="new-booking-title">
    <header className="anb-header"><h1 id="new-booking-title">New booking</h1><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></header>
    <ol className="anb-progress" aria-label="Booking progress">{STEPS.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    <p className="anb-mobile-progress">Step {step + 1} of 5</p><h2 ref={heading} tabIndex={-1}>{STEPS[step]}</h2>
    {error && <p className="anb-error" role="alert" ref={errorRef} tabIndex={-1}>{error}</p>}
    {!catalogue && !catalogueError && <p role="status">Loading booking options…</p>}
    {catalogueError && <><p role="alert">{catalogueError}</p><button onClick={() => setAttempt(value => value + 1)}>Retry booking options</button></>}
    {catalogue && <><fieldset className="anb-content" disabled={locked}>
      {step === 0 && <ClientStep draft={draft} patch={edit} catalogue={data} query={query} setQuery={setQuery} clients={search.clients} searchLoading={search.loading} searchError={search.error} selectClient={selectClient} addresses={addressCurrent ? addressState.addresses : []} addressLoading={Boolean(draft.client) && (!addressCurrent || addressState.loading)} addressError={addressCurrent ? addressState.error : ''} createClient={createClient} clientBusy={clientBusy} clientError={clientError} />}
      {step === 1 && <TreatmentStep draft={draft} patch={edit} catalogue={data} />}
      {step === 2 && <DateTimeStep draft={draft} patch={edit} availability={availability?.slots || []} loading={!availability} error={availability?.error} retry={() => setAvailabilityAttempt(value => value + 1)} />}
      {step === 3 && <PaymentStep draft={draft} patch={edit} />}
      {step === 4 && <ReviewStep draft={draft} catalogue={data} quote={quote} />}
    </fieldset>
    {step > 0 && step < 4 && <Quote quote={quote} />}
    {step > 0 && !quote && !quoteError && draft.serviceId && <p role="status">Updating price…</p>}
    {quoteError && <><p role="alert">{quoteError}</p><button type="button" disabled={locked} onClick={() => setAttempt(value => value + 1)}>Retry price</button></>}
    <footer className="anb-footer"><button type="button" disabled={step === 0 || locked} onClick={() => { setError(''); goStep(step - 1) }}>Back</button>{draft.submission || step === 4 ? <button type="button" className="anb-primary" disabled={busy || (!draft.submission && !quote)} onClick={create}>{busy ? 'Creating booking…' : draft.submission ? 'Retry creation' : 'Create booking'}</button> : <button type="button" className="anb-primary" disabled={clientBusy} onClick={next}>Continue</button>}</footer></>}
  </section>
}
