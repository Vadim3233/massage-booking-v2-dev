import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createBookingApi } from './bookingApi.js'
import { createBookingStore } from './bookingStore.js'
import Icon from '../../ui/icons.jsx'
import { activeHold, browserClientKey, draftKey, newSession, STEPS } from './bookingDraft.js'
import { presetFromSearch, stepForPreset } from './deepLink.js'
import { readUsual, rememberUsual } from './usualBooking.js'
import { friendlyError } from './friendlyError.js'
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
  const { draft, step, busy, error, quote, quoteError, result } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const navigate = useBookingHistory(store, step)
  const auth = useClientAuth(supabase)
  const [catalogue, setCatalogue] = useState(null)
  const [catalogueAttempt, setCatalogueAttempt] = useState(0)
  const [catalogueFailed, setCatalogueFailed] = useState(false)
  // A second tap that lands just after a screen has changed is the first tap arriving twice: for a moment the new screen takes no taps.
  const [settledStep, setSettledStep] = useState(step)
  useEffect(() => {
    const timer = setTimeout(() => setSettledStep(step), 400)
    return () => clearTimeout(timer)
  }, [step])
  const settling = settledStep !== step
  const [clock, setClock] = useState(Date.now)
  const [savedBank, setSavedBank] = useState(null)
  const rules = useBookingRules(supabase)
  const welcome = useWelcome(supabase)
  // The test-client helper exists only in development builds: the live page and its previews never offer it.
  const testMode = import.meta.env.DEV
  useEffect(() => {
    let live = true
    api.catalogue().then((data) => { if (live) { setCatalogue(data); setCatalogueFailed(false) } }).catch((err) => { if (live) { setCatalogueFailed(true); store.setError(friendlyError(err)) } })
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
  // A new screen starts at its heading: named in the tab, read out first by a screen reader, and the page back at the top.
  // Signing in or carrying on as a guest swaps the content inside a step, so that counts as a new screen too.
  const needsAuth = step >= 5 && !auth.session
  const screen = `${step}:${needsAuth ? 'sign-in' : auth.recovery ? 'recovery' : 'main'}`
  const lastScreen = useRef(null)
  useEffect(() => {
    document.title = `${STEPS[Math.min(step, STEPS.length - 1)]} · Book a massage · VadMassage`
    if (lastScreen.current === null) { lastScreen.current = screen; return }
    if (lastScreen.current === screen) return
    lastScreen.current = screen
    window.scrollTo(0, 0)
    document.querySelector('.booking-main h1')?.focus({ preventScroll: true })
  }, [screen, step])
  // A message about what just went wrong is brought into view: the button that caused it may be far below.
  const alertBox = useRef(null)
  useEffect(() => { if (error && step !== 6) alertBox.current?.scrollIntoView({ block: 'center' }) }, [error, step])
  // A link with the area, treatment and length in it (see deepLink.js) opens the booking part-way through, unless a booking is already under way.
  const presetChecked = useRef(false)
  useEffect(() => {
    if (!catalogue || presetChecked.current) return
    presetChecked.current = true
    if (step !== 0 || draft.areaId || draft.serviceId || draft.sessions.length || draft.bookingId) return
    const preset = presetFromSearch(window.location.search, catalogue)
    if (!preset?.areaId) return
    store.changeSelection({ areaId: preset.areaId, ...(preset.serviceId ? { serviceId: preset.serviceId, sessions: preset.minutes ? [newSession(preset.minutes)] : [], enhancementIds: [] } : {}) })
      .then((saved) => { if (saved) navigate(stepForPreset(preset)) })
  }, [catalogue, step, draft, store, navigate])
  // The last booking made on this phone is offered again, so a regular client is two taps from choosing a time.
  useEffect(() => { if (draft.bookingId) rememberUsual(localStorage, draft) }, [draft])
  const usual = useMemo(() => (catalogue && !draft.bookingId ? readUsual(localStorage, catalogue) : null), [catalogue, draft.bookingId])
  async function bookUsual() {
    if (await store.changeSelection({ areaId: usual.areaId, serviceId: usual.serviceId, sessions: usual.durations.map(newSession), enhancementIds: [] })) navigate(3)
  }
  function startAgain() {
    sessionStorage.removeItem(draftKey)
    window.location.assign('/')
  }
  async function goWithQuote(target) {
    if (await store.loadQuote()) {
      navigate(target)
      if (target === 6) await store.finalize(auth.session?.user.id)
    }
  }
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
  const canGoBack = step > 0 && step < 7 && !draft.pending && !draft.bookingId
  const shown = Math.min(step, STEPS.length - 1)
  return <div className="booking-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/account">Your bookings</a></header>
    <main className={`booking-main ${settling ? 'is-settling' : ''}`}>
      <nav className="stepper" aria-label="Booking progress">
        <div className="stepper-row">
          {catalogue && canGoBack ? <button className="btn--quiet btn--small back" disabled={busy} onClick={() => navigate(step - 1)}><Icon name="left" size={20} />Back</button> : <span />}
          <p className="progress-summary">Step {shown + 1} of {STEPS.length} · {STEPS[shown]}</p>
        </div>
        <div className="progress-bar" aria-hidden="true">{STEPS.map((label, index) => <span key={label} className={index < shown ? 'done' : index === shown ? 'current' : ''} />)}</div>
        <ol role="list" className="progress">{STEPS.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{label}</li>)}</ol>
      </nav>
      <p className="sr-only" role="status">{busy ? 'Please wait…' : ''}</p>
      <div className={`busy-bar ${busy ? 'is-on' : ''}`} aria-hidden="true" />
      {!draft.bookingId && <HoldNotice hold={draft.hold} remaining={remaining} busy={busy} pending={draft.pending} error={error} extend={store.extendHold} release={store.releaseHold} />}
      {error && step !== 6 && <p role="alert" className="error" ref={alertBox}>{error}</p>}
      {auth.error && <p role="alert" className="error">{auth.error}</p>}
      {!catalogue ? (catalogueFailed
        ? <>{step === 6 && error && <p role="alert" className="error">{error}</p>}<button className="btn--tonal" onClick={() => { setCatalogueFailed(false); store.setError(''); setCatalogueAttempt(catalogueAttempt + 1) }}>Try again</button></>
        : <div className="skeleton-rows" role="status"><span className="sr-only">Just getting things ready…</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>) : <>
        {!held && step >= 4 && step < 7 && !draft.pending && !draft.bookingId && <button className="btn--tonal" onClick={() => navigate(3)}>Choose a time again</button>}
        <fieldset className={`screen enter ${busy ? 'is-busy' : ''}`} key={step}>
          {step === 0 && <AreaStep welcome={welcome} rules={rules} catalogue={catalogue} usual={usual} bookUsual={bookUsual} choose={async (areaId) => { if (areaId === draft.areaId || await store.changeSelection({ areaId })) navigate(1) }} />}
          {step === 1 && <TreatmentStep catalogue={catalogue} choose={async (serviceId) => { if (serviceId === draft.serviceId || await store.changeSelection({ serviceId, sessions: [], enhancementIds: [] })) navigate(2) }} />}
          {step === 2 && <DurationStep draft={draft} catalogue={catalogue} change={(sessions) => store.changeSelection({ sessions })}
            choose={async (minutes) => { if ((draft.sessions.length === 1 && draft.sessions[0].duration_minutes === minutes) || await store.changeSelection({ sessions: [newSession(minutes)] })) navigate(3) }} next={() => navigate(3)} />}
          {step === 3 && <TimeStep rules={rules} joinWaitlist={api.joinWaitlist} draft={draft} loadAvailability={store.availability} selectSlot={store.selectSlot} next={() => goWithQuote(4)} />}
          {step === 4 && <ReviewStep draft={draft} catalogue={catalogue} quote={quote} quoteError={quoteError} edit={store.edit} navigate={navigate} refreshQuote={store.refreshQuote} retryQuote={store.retryQuote} next={() => goWithQuote(5)} />}
          {!auth.ready && step >= 5 && <p role="status">Checking your account…</p>}
          {auth.ready && (needsAuth || auth.recovery) && <AuthPanel client={supabase} recovery={auth.recovery} onRecovered={auth.finishRecovery} onGuest={startGuest} />}
          {step === 5 && auth.session && !auth.recovery && <DetailsStep key={auth.session.user.id} draft={draft} user={auth.session.user} api={api} edit={store.edit} report={store.setError} guest={isGuest} newTestGuest={startNewTestGuest} next={() => goWithQuote(6)} />}
          {step === 6 && auth.session && !auth.recovery && <PaymentStep rules={rules} draft={draft} quote={quote} quoteError={quoteError} bank={bank} api={api} store={store} finalize={() => store.finalize(auth.session.user.id)} held={held} error={error} chooseTimeAgain={() => navigate(3)} />}
          {step === 7 && auth.session && !auth.recovery && <ConfirmationStep id={draft.bookingId} result={result} api={api} bank={bank} quote={quote} again={startAgain} />}
        </fieldset>
      </>}
    </main>
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vad</a></footer>
  </div>
}
