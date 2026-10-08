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
import { bankFromSettings, chooseBank, paymentConfig } from './paymentConfig.js'
import { useBookingRules } from '../bookingRules.js'
import { useWelcome } from '../welcome.js'
import './booking.css'

const api = createBookingApi(supabase)
const fallbackBank = paymentConfig(import.meta.env)

export default function BookingFlow() {
  const [store] = useState(() => createBookingStore({ api, storage: sessionStorage, clientKey: browserClientKey(localStorage) }))
  const { draft, step, busy, error, quote, result } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const navigate = useBookingHistory(store, step)
  const auth = useClientAuth(supabase)
  const [catalogue, setCatalogue] = useState(null)
  const [catalogueAttempt, setCatalogueAttempt] = useState(0)
  const [clock, setClock] = useState(Date.now)
  const [savedBank, setSavedBank] = useState(null)
  const rules = useBookingRules(supabase)
  const welcome = useWelcome(supabase)
  const testMode = import.meta.env.DEV || new URLSearchParams(window.location.search).get('test') === '1'
  useEffect(() => {
    let live = true
    api.catalogue().then((data) => { if (live) setCatalogue(data) }).catch((err) => { if (live) store.setError(err.message) })
    return () => { live = false }
  }, [store, catalogueAttempt])
  useEffect(() => {
    // Timers can pause in a sleeping tab. Reconcile the absolute server deadline
    // immediately on return, as well as while the page is active.
    const refresh = () => { setClock(Date.now()); store.expireHold() }
    const timer = setInterval(refresh, 1000)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [store])
  const signedInUser = auth.session?.user?.id
  useEffect(() => {
    if (!signedInUser || step < 6) return undefined
    let live = true
    api.bankDetails().then(row => { if (live) setSavedBank(bankFromSettings(row)) }, () => { /* The build-time details remain the fallback. */ })
    return () => { live = false }
  }, [signedInUser, step])
  const bank = chooseBank(savedBank, fallbackBank)
  const held = activeHold(draft, clock)
  const remaining = draft.hold ? Math.max(0, Math.ceil((Date.parse(draft.hold.expires_at) - clock) / 1000)) : 0
  useEffect(() => { store.expireHold() }, [store, clock, busy])
  async function goWithQuote(target) {
    if (await store.loadQuote()) {
      navigate(target)
      if (target === 6) await store.finalize(auth.session?.user.id)
    }
  }
  const needsAuth = step >= 5 && !auth.session
  const isGuest = Boolean(auth.session?.user?.is_anonymous)
  async function startGuest() {
    const { error: guestError } = await supabase.auth.signInAnonymously()
    if (guestError) throw guestError
  }
  async function startNewTestGuest(details) {
    if (!testMode || !auth.session?.user?.is_anonymous) {
      throw new Error('The test client helper is only available for an anonymous guest session.')
    }
    const previousUserId = auth.session.user.id
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) throw signOutError
    const { data, error: signInError } = await supabase.auth.signInAnonymously()
    if (signInError) throw signInError
    const userId = data.user?.id
    if (!userId || userId === previousUserId) throw new Error('Unable to create a fresh test client. Please retry.')
    store.edit({ details, ownerUserId: userId })
    return userId
  }
  return <main className="booking-shell">
    <header className="brand"><a href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><span>Massage at your place</span></header>
    <nav aria-label="Booking progress"><p className="progress-summary">Step {Math.min(step + 1, STEPS.length)} of {STEPS.length} · {STEPS[Math.min(step, STEPS.length - 1)]}</p><div className="progress-bar" aria-hidden="true"><span style={{ width: `${(Math.min(step + 1, STEPS.length) / STEPS.length) * 100}%` }} /></div><ol className="progress">{STEPS.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{label}</li>)}</ol></nav>
    {!draft.bookingId && <HoldNotice hold={draft.hold} remaining={remaining} busy={busy} pending={draft.pending} error={error} extend={store.extendHold} release={store.releaseHold} />}
    {error && step !== 6 && <p role="alert" className="error">{error}</p>}
    {auth.error && <p role="alert" className="error">{auth.error}</p>}
    {!catalogue ? <><p>Just getting things ready…</p><button onClick={() => setCatalogueAttempt(catalogueAttempt + 1)}>Retry</button></> : <>
      {step > 0 && step < 7 && !draft.pending && !draft.bookingId && <button disabled={busy} onClick={() => navigate(step - 1)}>Back</button>}
      {!held && step >= 4 && step < 7 && !draft.pending && !draft.bookingId && <button onClick={() => navigate(3)}>Choose a time again</button>}
      {busy && <p role="status">Please wait…</p>}
      <fieldset className="screen" disabled={busy}>
        {step === 0 && <AreaStep welcome={welcome} rules={rules} catalogue={catalogue} choose={async (areaId) => { if (areaId === draft.areaId || await store.changeSelection({ areaId })) navigate(1) }} />}
        {step === 1 && <TreatmentStep catalogue={catalogue} choose={async (serviceId) => { if (serviceId === draft.serviceId || await store.changeSelection({ serviceId, sessions: [], enhancementIds: [] })) navigate(2) }} />}
        {step === 2 && <DurationStep draft={draft} catalogue={catalogue} change={(sessions) => store.changeSelection({ sessions })} next={async () => { if (!draft.date) await store.changeSelection({ date: londonDate() }); navigate(3) }} />}
        {step === 3 && <TimeStep key={`${draft.date}:${draft.hold?.hold_token}:${held}`} rules={rules} joinWaitlist={api.joinWaitlist} draft={draft} loadAvailability={store.availability} selectDate={(date) => store.changeSelection({ date })} selectSlot={store.selectSlot} next={() => goWithQuote(4)} />}
        {step === 4 && <ReviewStep draft={draft} catalogue={catalogue} quote={quote} edit={store.edit} navigate={navigate} refresh={store.loadQuote} next={() => goWithQuote(5)} />}
        {!auth.ready && step >= 5 && <p role="status">Checking your account…</p>}
        {auth.ready && (needsAuth || auth.recovery) && <AuthPanel client={supabase} recovery={auth.recovery} onRecovered={auth.finishRecovery} onGuest={startGuest} />}
        {step === 5 && auth.session && !auth.recovery && <DetailsStep key={auth.session.user.id} draft={draft} user={auth.session.user} api={api} edit={store.edit} report={store.setError} guest={isGuest} newTestGuest={startNewTestGuest} next={() => goWithQuote(6)} />}
        {step === 6 && auth.session && !auth.recovery && <PaymentStep rules={rules} draft={draft} quote={quote} bank={bank} api={api} store={store} finalize={() => store.finalize(auth.session.user.id)} held={held} error={error} chooseTimeAgain={() => navigate(3)} />}
        {step === 7 && auth.session && !auth.recovery && <ConfirmationStep id={draft.bookingId} result={result} api={api} bank={bank} />}
      </fieldset>
    </>}
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vad</a></footer>
  </main>
}
