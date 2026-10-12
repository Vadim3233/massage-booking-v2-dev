import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Calendar from './Calendar.jsx'
import { useUnreadAlerts } from './useUnreadAlerts.js'
import { useToCheck } from './useToCheck.js'
import { today } from './calendarPresentation.js'
import Icon from '../ui/icons.jsx'
import ToastHost from '../ui/ToastHost.jsx'
import './agenda.css'
const Agenda = lazy(() => import('./Agenda.jsx'))
const PaymentReview = lazy(() => import('./PaymentReview.jsx'))
const Alerts = lazy(() => import('./Alerts.jsx'))
const ScheduleSettings = lazy(() => import('./ScheduleSettings.jsx'))
const Clients = lazy(() => import('./Clients.jsx'))
const ServicesSettings = lazy(() => import('./SettingsCatalogue.jsx').then(module => ({ default: module.ServicesSettings })))
const AreasSettings = lazy(() => import('./SettingsCatalogue.jsx').then(module => ({ default: module.AreasSettings })))
const BankSettings = lazy(() => import('./SettingsBank.jsx'))
const RulesSettings = lazy(() => import('./SettingsRules.jsx'))
const WelcomeSettings = lazy(() => import('./SettingsWelcome.jsx'))
const ShareLink = lazy(() => import('./ShareLink.jsx'))
const Waitlist = lazy(() => import('./Waitlist.jsx'))
const ExtrasSettings = lazy(() => import('./SettingsCatalogue.jsx').then(module => ({ default: module.ExtrasSettings })))
const ClientProfile = lazy(() => import('./ClientProfile.jsx'))
const BookingDestination = lazy(() => import('./BookingDestination.jsx'))
const AdminNewBooking = lazy(() => import('./AdminNewBooking.jsx'))

// The More menu, grouped by what she is doing. Each pair is a route and the words on the link.
const MORE_GROUPS = [
  ['Every day', [['/admin/waitlist', 'Waitlist'], ['/admin/schedule', 'Working hours and special days'], ['/admin/settings/link', 'Your booking link']]],
  ['What you offer', [['/admin/settings/services', 'Services and prices'], ['/admin/settings/extras', 'Extras'], ['/admin/settings/areas', 'Areas and travel fees']]],
  ['Payments and rules', [['/admin/settings/bank', 'Bank transfer details'], ['/admin/settings/rules', 'Booking rules']]],
  ['What clients read', [['/admin/settings/welcome', 'Welcome message']]],
]
const SETTINGS_PAGES = MORE_GROUPS.flatMap(([, links]) => links.map(([path]) => path))
// Each settings page is named in the tab and read out first by its own name, not as "Settings".
const SETTINGS_TITLES = Object.fromEntries(MORE_GROUPS.flatMap(([, links]) => links))
const plainClick = event => !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0
function AdminLink({ href, navigate, children, ...rest }) {
  return <a href={href} onClick={event => { if (plainClick(event)) { event.preventDefault(); navigate(href) } }} {...rest}>{children}</a>
}
const readRoute = () => ({ path: window.location.pathname.replace(/\/$/, '') || '/admin', search: window.location.search, background: window.history.state?.adminBackground, returnTo: window.history.state?.adminReturnTo })
export default function AdminWorkspace({ signOut, ownerId }) {
  const [route, setRoute] = useState(readRoute)
  const [revision, setRevision] = useState(0)
  const [opener, setOpener] = useState(null)
  const [unreadAlerts, refreshAlerts] = useUnreadAlerts()
  const [toCheck, refreshToCheck] = useToCheck(revision)
  const [fabCompact, setFabCompact] = useState(false)
  const guard = useRef(null)
  const viewedDay = useRef(undefined)
  const rememberDay = useCallback(day => { viewedDay.current = day }, [])
  const currentRoute = useRef(route)
  useEffect(() => { currentRoute.current = route }, [route])
  const registerGuard = useCallback(fn => { guard.current = fn }, [])
  // The New booking button shrinks to a plus while she scrolls, and opens out again at the top.
  useEffect(() => {
    const scroll = () => setFabCompact(window.scrollY > 120)
    window.addEventListener('scroll', scroll, { passive: true })
    return () => window.removeEventListener('scroll', scroll)
  }, [])
  useEffect(() => {
    const pop = () => {
      const next = readRoute()
      const previous = currentRoute.current
      if (previous.path === '/admin/bookings/new' && next.path !== previous.path && guard.current && !guard.current()) {
        window.history.pushState({ adminWizard: true, adminReturnTo: previous.returnTo }, '', previous.path + previous.search)
        return
      }
      setRoute(next)
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  function navigate(path, background) {
    if (route.path === '/admin/bookings/new' && !path.startsWith('/admin/bookings/new') && guard.current && !guard.current()) return
    window.history.pushState(background ? { adminBackground: background } : {}, '', path)
    setRoute(readRoute())
    if (!background) window.scrollTo(0, 0)
  }
  const creating = route.path === '/admin/bookings/new'
  const match = !creating && route.path.match(/^\/admin\/bookings\/([^/]+)$/)
  const context = match ? route.background : route.path + route.search
  const rawSurface = context?.split('?')[0]
  const date = new URLSearchParams(context?.split('?')[1]).get('date') || undefined
  // Opening the Admin, or pressing Calendar, shows the Agenda. The day view lives at /admin/day (or /admin?date=...).
  const surface = rawSurface === '/admin/day' ? '/admin' : rawSurface === '/admin' && !date ? '/admin/agenda' : rawSurface
  const clientParam = new URLSearchParams(context?.split('?')[1]).get('client') || undefined
  const profile = context?.split('?')[0].match(/^\/admin\/clients\/([0-9a-f-]{36})$/i)
  const calendarSurface = ['/admin', '/admin/agenda'].includes(surface)
  const clientsSurface = surface === '/admin/clients' || Boolean(profile)
  function close() {
    if (route.background) window.history.back()
    else { window.history.replaceState({}, '', '/admin'); setRoute(readRoute()) }
  }
  const openBooking = id => { setOpener(document.activeElement); navigate(`/admin/bookings/${id}`, context) }
  const newBooking = (date, clientId) => {
    const returnTo = clientId ? `/admin/clients/${clientId}` : surface === '/admin/agenda' ? surface : `/admin?date=${date}`
    window.history.pushState({ adminReturnTo: returnTo }, '', `/admin/bookings/new?date=${date}${clientId ? `&client=${clientId}` : ''}`)
    setRoute(readRoute())
    window.scrollTo(0, 0)
  }
  function created(result) {
    guard.current = null
    setRevision(value => value + 1)
    // The booking opens over the page she started from: the Agenda or the client's page, or else the day it is on.
    const startedFrom = route.returnTo
    const background = startedFrom === '/admin/agenda' || startedFrom?.startsWith('/admin/clients/') ? startedFrom : `/admin?date=${result.date}`
    window.history.replaceState({}, '', background)
    window.history.pushState({ adminBackground: background }, '', `/admin/bookings/${result.booking_id}`)
    setOpener(null)
    setRoute(readRoute())
    window.scrollTo(0, 0)
  }
  const moreSurface = ['/admin/more', ...SETTINGS_PAGES].includes(surface)
  const screen = creating ? 'New booking' : match ? 'Booking' : profile ? 'Client' : ({ '/admin': 'Day', '/admin/agenda': 'Agenda', '/admin/review': 'To check', '/admin/alerts': 'Alerts', '/admin/clients': 'Clients', '/admin/more': 'More', '/admin/waitlist': 'Waitlist', '/admin/schedule': 'Working hours' }[surface] || (SETTINGS_PAGES.includes(surface) ? SETTINGS_TITLES[surface] : 'Admin'))
  const previousScreen = useRef(null)
  useEffect(() => {
    document.title = `${screen} \u00b7 Admin \u00b7 VadMassage`
    const before = previousScreen.current
    previousScreen.current = screen
    if (before === null || before === screen || before === 'Booking' || screen === 'Booking') return
    const focusHeading = (tries = 0) => {
      const heading = document.querySelector('#admin-main h1')
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }) }
      else if (tries < 30) requestAnimationFrame(() => focusHeading(tries + 1))
    }
    focusHeading()
  }, [screen])
  const needsYou = toCheck.needs.length
  return <>
    <a className="skip-link" href="#admin-main">Skip to the page</a>
    {!creating && <nav inert={Boolean(match)} className="admin-primary-nav" aria-label="Admin navigation">
      <AdminLink href="/admin" navigate={navigate} aria-current={calendarSurface ? 'page' : undefined}><Icon name="calendar" /><span>Calendar</span></AdminLink>
      <AdminLink href="/admin/review" navigate={navigate} aria-current={surface === '/admin/review' ? 'page' : undefined}><Icon name="check" /><span>To check</span>{needsYou > 0 && <small className="admin-badge admin-badge--needs" aria-label={`${needsYou} to check`}>{needsYou > 99 ? '99+' : needsYou}</small>}</AdminLink>
      <AdminLink href="/admin/alerts" navigate={navigate} aria-current={surface === '/admin/alerts' ? 'page' : undefined}><Icon name="bell" /><span>Alerts</span>{unreadAlerts > 0 && <small className="admin-badge" aria-label={`${unreadAlerts} unread`}>{unreadAlerts > 99 ? '99+' : unreadAlerts}</small>}</AdminLink>
      <AdminLink href="/admin/clients" navigate={navigate} aria-current={clientsSurface ? 'page' : undefined}><Icon name="users" /><span>Clients</span></AdminLink>
      <AdminLink href="/admin/more" navigate={navigate} aria-current={moreSurface ? 'page' : undefined}><Icon name="more" filled /><span>More</span></AdminLink>
    </nav>}
    <Suspense fallback={<div className="skeleton-rows" role="status" aria-label="Loading Admin"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}>
      <main id="admin-main" className="admin-content" inert={Boolean(match)}>
      {calendarSurface && <nav className="admin-calendar-views" aria-label="Calendar views">
        <AdminLink href="/admin/day" navigate={navigate} aria-current={surface === '/admin' ? 'page' : undefined}>Day</AdminLink>
        <AdminLink href="/admin/agenda" navigate={navigate} aria-current={surface === '/admin/agenda' ? 'page' : undefined}>Agenda</AdminLink>
      </nav>}
      {surface === '/admin' && <Calendar key={date || 'today'} initialDate={date} signOut={signOut} openBooking={openBooking} revision={revision} onDate={rememberDay} />}
      {surface === '/admin/agenda' && <Agenda openBooking={openBooking} revision={revision} toCheck={toCheck} checked={() => { setRevision(value => value + 1); refreshToCheck() }} seeAll={() => navigate('/admin/review')} />}
      {creating && <AdminNewBooking initialDate={date} initialClientId={clientParam} ownerId={ownerId} registerGuard={registerGuard} onCancel={() => navigate(route.returnTo || '/admin')} onCreated={created} />}
      {surface === '/admin/review' && <PaymentReview openBooking={openBooking} revision={revision} changed={refreshToCheck} />}
      {surface === '/admin/clients' && <Clients openClient={id => navigate(`/admin/clients/${id}`)} />}
      {profile && <ClientProfile key={profile[1]} id={profile[1]} back={() => navigate('/admin/clients')} openBooking={openBooking} newBooking={clientId => newBooking(today(), clientId)} />}
      {surface === '/admin/alerts' && <Alerts openBooking={openBooking} openPage={path => navigate(path)} changed={refreshAlerts} />}
      {surface === '/admin/more' && <section className="admin-review"><h1>More</h1>
        {MORE_GROUPS.map(([title, links]) => <section key={title} aria-label={title}><h2 className="admin-group-title">{title}</h2>
          <ul role="list" className="admin-menu">{links.map(([path, text]) => <li key={path}><AdminLink href={path} navigate={navigate}>{text}</AdminLink></li>)}</ul></section>)}
        <button className="btn--quiet" onClick={signOut}>Sign out</button></section>}
      {SETTINGS_PAGES.includes(surface) && <AdminLink className="admin-back-link" href="/admin/more" navigate={navigate}>← More</AdminLink>}
      {surface === '/admin/schedule' && <ScheduleSettings />}
      {surface === '/admin/settings/services' && <ServicesSettings />}
      {surface === '/admin/settings/extras' && <ExtrasSettings />}
      {surface === '/admin/settings/areas' && <AreasSettings />}
      {surface === '/admin/settings/bank' && <BankSettings />}
      {surface === '/admin/settings/rules' && <RulesSettings />}
      {surface === '/admin/settings/welcome' && <WelcomeSettings />}
      {surface === '/admin/settings/link' && <ShareLink />}
      {surface === '/admin/waitlist' && <Waitlist bookFor={request => newBooking(request.requested_date, request.client_id)} />}
      {!creating && !match && !['/admin', '/admin/agenda', '/admin/review', '/admin/alerts', '/admin/more', '/admin/clients', ...SETTINGS_PAGES].includes(surface) && !profile && <section className="admin-review"><h1>Admin page not found</h1><a href="/admin">Back to Calendar</a></section>}
      </main>
      {match && <BookingDestination key={match[1]} id={match[1]} close={close} returnFocus={opener} changed={() => setRevision(value => value + 1)} />}
    </Suspense>
    {calendarSurface && !match && <button className={`btn btn--primary btn--lg admin-fab ${fabCompact ? 'is-compact' : ''}`} onClick={() => newBooking((surface === '/admin' && viewedDay.current) || date || today())}><span className="fab-plus">+</span><span className="fab-label"> New booking</span></button>}
    <ToastHost />
  </>
}
