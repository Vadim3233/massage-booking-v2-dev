import { useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createBookingApi } from './bookingApi.js'
import { createBookingStore } from './bookingStore.js'
import { activeHold, browserClientKey, londonDate, STEPS } from './bookingDraft.js'
import { useBookingHistory } from './useBookingHistory.js'
import { useClientAuth } from '../auth/useClientAuth.js'
import AuthPanel from '../auth/AuthPanel.jsx'
import { AreaStep, DurationStep, TimeStep, TreatmentStep } from './components/SelectionSteps.jsx'
import ReviewStep from './components/ReviewStep.jsx'
import DetailsStep from './components/DetailsStep.jsx'
import PaymentStep from './components/PaymentStep.jsx'
import ConfirmationStep from './components/ConfirmationStep.jsx'
import HoldNotice from './components/HoldNotice.jsx'
import { paymentConfig } from './paymentConfig.js'
import './booking.css'

const api = createBookingApi(supabase)
const bank = paymentConfig(import.meta.env)

export default function BookingFlow() {
  const [store] = useState(() => createBookingStore({ api, storage: sessionStorage, clientKey: browserClientKey(localStorage) }))
  const { draft, step, busy, error, quote, result } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const navigate = useBookingHistory(store, step)
  const auth = useClientAuth(supabase)
  const [catalogue, setCatalogue] = useState(null)
  const [catalogueAttempt, setCatalogueAttempt] = useState(0)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => {
    let live = true
    api.catalogue().then((data) => { if (live) setCatalogue(data) }).catch((err) => { if (live) store.setError(err.message) })
    return () => { live = false }
  }, [store, catalogueAttempt])
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const held = activeHold(draft, clock)
  const remaining = draft.hold ? Math.max(0, Math.ceil((Date.parse(draft.hold.expires_at) - clock) / 1000)) : 0
  useEffect(() => { store.expireHold() }, [store, clock, busy])
  async function goWithQuote(target) { if (await store.loadQuote()) navigate(target) }
  const needsAuth = step >= 5 && !auth.session
  const isGuest = Boolean(auth.session?.user?.is_anonymous)
  async function startGuest() {
    const { error: guestError } = await supabase.auth.signInAnonymously()
    if (guestError) throw guestError
  }
  return <main className="booking-shell">
    <header className="brand"><a href="/">VM <span>VadMassage</span></a><span>Massage at your place</span></header>
    <nav aria-label="Booking progress"><ol className="progress">{STEPS.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{label}</li>)}</ol></nav>
    {!draft.bookingId && <HoldNotice hold={draft.hold} remaining={remaining} busy={busy} pending={draft.pending} extend={store.extendHold} release={store.releaseHold} />}
    {error && step !== 6 && <p role="alert" className="error">{error}</p>}
    {auth.error && <p role="alert" className="error">{auth.error}</p>}
    {!catalogue ? <><p>Loading booking options…</p><button onClick={() => setCatalogueAttempt(catalogueAttempt + 1)}>Retry</button></> : <>
      {step > 0 && step < 7 && !draft.pending && <button disabled={busy} onClick={() => navigate(step - 1)}>Back</button>}
      {!held && step >= 4 && step < 7 && !draft.pending && <button onClick={() => navigate(3)}>Choose a time again</button>}
      {busy && <p role="status">Please wait…</p>}
      <fieldset className="screen" disabled={busy}>
        {step === 0 && <AreaStep catalogue={catalogue} choose={async (areaId) => { if (areaId === draft.areaId || await store.changeSelection({ areaId })) navigate(1) }} />}
        {step === 1 && <TreatmentStep catalogue={catalogue} choose={async (serviceId) => { if (serviceId === draft.serviceId || await store.changeSelection({ serviceId, sessions: [], enhancementIds: [] })) navigate(2) }} />}
        {step === 2 && <DurationStep draft={draft} catalogue={catalogue} change={(sessions) => store.changeSelection({ sessions })} next={async () => { if (!draft.date) await store.changeSelection({ date: londonDate() }); navigate(3) }} />}
        {step === 3 && <TimeStep key={`${draft.date}:${draft.hold?.hold_token}:${held}`} draft={draft} loadAvailability={store.availability} selectDate={(date) => store.changeSelection({ date })} selectSlot={store.selectSlot} next={() => goWithQuote(4)} />}
        {step === 4 && <ReviewStep draft={draft} catalogue={catalogue} quote={quote} edit={store.edit} navigate={navigate} refresh={store.loadQuote} next={() => goWithQuote(5)} />}
        {!auth.ready && step >= 5 && <p role="status">Checking your account…</p>}
        {auth.ready && (needsAuth || auth.recovery) && <AuthPanel client={supabase} recovery={auth.recovery} onRecovered={auth.finishRecovery} onGuest={startGuest} />}
        {step === 5 && auth.session && !auth.recovery && <DetailsStep key={auth.session.user.id} draft={draft} user={auth.session.user} api={api} edit={store.edit} report={store.setError} guest={isGuest} next={() => goWithQuote(6)} />}
        {step === 6 && auth.session && !auth.recovery && <PaymentStep draft={draft} quote={quote} bank={bank} edit={store.edit} refresh={store.loadQuote} finalize={() => store.finalize(auth.session.user.id)} held={held} error={error} chooseTimeAgain={() => navigate(3)} />}
        {step === 7 && auth.session && !auth.recovery && <ConfirmationStep id={draft.bookingId} result={result} api={api} bank={bank} />}
      </fieldset>
    </>}
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vad</a></footer>
  </main>
}
