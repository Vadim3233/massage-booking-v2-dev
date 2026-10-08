import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Calendar from './Calendar.jsx'
import { useUnreadAlerts } from './useUnreadAlerts.js'
import { today } from './calendarPresentation.js'
import './agenda.css'
const Agenda = lazy(() => import('./Agenda.jsx'))
const PaymentReview = lazy(() => import('./PaymentReview.jsx'))
const Alerts = lazy(() => import('./Alerts.jsx'))
const ScheduleSettings = lazy(() => import('./ScheduleSettings.jsx'))
const Clients = lazy(() => import('./Clients.jsx'))
const ServicesSettings = lazy(() => import('./SettingsCatalogue.jsx').then(module => ({ default: module.ServicesSettings })))
const AreasSettings = lazy(() => import('./SettingsCatalogue.jsx').then(module => ({ default: module.AreasSettings })))
const BankSettings = lazy(() => import('./SettingsBank.jsx'))
const ExtrasSettings = lazy(() => import('./SettingsCatalogue.jsx').then(module => ({ default: module.ExtrasSettings })))
const ClientProfile = lazy(() => import('./ClientProfile.jsx'))
const BookingDestination = lazy(() => import('./BookingDestination.jsx'))
const AdminNewBooking = lazy(() => import('./AdminNewBooking.jsx'))
const MORE_LINKS = [['/admin/schedule', 'Working hours and special days'], ['/admin/settings/services', 'Services and prices'], ['/admin/settings/extras', 'Extras'], ['/admin/settings/areas', 'Areas and travel fees'], ['/admin/settings/bank', 'Bank transfer details']]
const SETTINGS_PAGES = MORE_LINKS.map(([path]) => path)
const readRoute = () => ({ path: window.location.pathname.replace(/\/$/, '') || '/admin', search: window.location.search, background: window.history.state?.adminBackground, returnTo: window.history.state?.adminReturnTo })
export default function AdminWorkspace({ signOut, ownerId }) {
  const [route, setRoute] = useState(readRoute)
  const [revision, setRevision] = useState(0)
  const [opener, setOpener] = useState(null)
  const [unreadAlerts, refreshAlerts] = useUnreadAlerts()
  const guard = useRef(null)
  const currentRoute = useRef(route)
  useEffect(() => { currentRoute.current = route }, [route])
  const registerGuard = useCallback(fn => { guard.current = fn }, [])
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
  const surface = context?.split('?')[0]
  const date = new URLSearchParams(context?.split('?')[1]).get('date') || undefined
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
    const background = `/admin?date=${result.date}`
    window.history.replaceState({}, '', background)
    window.history.pushState({ adminBackground: background }, '', `/admin/bookings/${result.booking_id}`)
    setOpener(null)
    setRoute(readRoute())
    window.scrollTo(0, 0)
  }
  return <>
    {!creating && <nav inert={Boolean(match)} className="admin-primary-nav" aria-label="Admin navigation">
      <a href="/admin" aria-current={calendarSurface ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate('/admin') } }}>Calendar</a>
      <a href="/admin/review" aria-current={surface === '/admin/review' ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate('/admin/review') } }}>Review</a>
      <a href="/admin/alerts" aria-current={surface === '/admin/alerts' ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate('/admin/alerts') } }}>Alerts{unreadAlerts > 0 && <small className="admin-badge" aria-label={`${unreadAlerts} unread`}>{unreadAlerts > 99 ? '99+' : unreadAlerts}</small>}</a>
      <a href="/admin/clients" aria-current={clientsSurface ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate('/admin/clients') } }}>Clients</a>
      <a href="/admin/more" aria-current={['/admin/more', ...SETTINGS_PAGES].includes(surface) ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin/more') }}>More</a>
    </nav>}
    <Suspense fallback={<p role="status">Loading Admin…</p>}>
      <div inert={Boolean(match)}>
      {calendarSurface && <nav className="admin-calendar-views" aria-label="Calendar views">
        <a href="/admin" aria-current={surface === '/admin' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin') }}>Day</a>
        <a href="/admin/agenda" aria-current={surface === '/admin/agenda' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin/agenda') }}>Agenda</a>
      </nav>}
      {surface === '/admin' && <Calendar key={date || 'today'} initialDate={date} signOut={signOut} openBooking={openBooking} revision={revision} newBooking={newBooking} />}
      {surface === '/admin/agenda' && <Agenda openBooking={openBooking} revision={revision} newBooking={newBooking} />}
      {creating && <AdminNewBooking initialDate={date} initialClientId={clientParam} ownerId={ownerId} registerGuard={registerGuard} onCancel={() => navigate(route.returnTo || '/admin')} onCreated={created} />}
      {surface === '/admin/review' && <PaymentReview openBooking={openBooking} revision={revision} />}
      {surface === '/admin/clients' && <Clients openClient={id => navigate(`/admin/clients/${id}`)} />}
      {profile && <ClientProfile key={profile[1]} id={profile[1]} back={() => navigate('/admin/clients')} openBooking={openBooking} newBooking={clientId => newBooking(today(), clientId)} />}
      {surface === '/admin/alerts' && <Alerts openBooking={openBooking} changed={refreshAlerts} />}
      {surface === '/admin/more' && <section className="admin-review"><h1>More</h1>
        <ul className="admin-menu">{MORE_LINKS.map(([path, text]) => <li key={path}><a href={path} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(path) } }}>{text}</a></li>)}</ul>
        <button onClick={signOut}>Sign out</button></section>}
      {SETTINGS_PAGES.includes(surface) && <a className="admin-back-link" href="/admin/more" onClick={event => { event.preventDefault(); navigate('/admin/more') }}>← More</a>}
      {surface === '/admin/schedule' && <ScheduleSettings />}
      {surface === '/admin/settings/services' && <ServicesSettings />}
      {surface === '/admin/settings/extras' && <ExtrasSettings />}
      {surface === '/admin/settings/areas' && <AreasSettings />}
      {surface === '/admin/settings/bank' && <BankSettings />}
      {!creating && !match && !['/admin', '/admin/agenda', '/admin/review', '/admin/alerts', '/admin/more', '/admin/clients', ...SETTINGS_PAGES].includes(surface) && !profile && <section className="admin-review"><h1>Admin page not found</h1><a href="/admin">Back to Calendar</a></section>}
      </div>
      {match && <BookingDestination key={match[1]} id={match[1]} close={close} returnFocus={opener} changed={() => setRevision(value => value + 1)} />}
    </Suspense>
  </>
}
