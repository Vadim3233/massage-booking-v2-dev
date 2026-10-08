import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Calendar from './Calendar.jsx'
import { useUnreadAlerts } from './useUnreadAlerts.js'
import './agenda.css'
const Agenda = lazy(() => import('./Agenda.jsx'))
const PaymentReview = lazy(() => import('./PaymentReview.jsx'))
const Alerts = lazy(() => import('./Alerts.jsx'))
const BookingDestination = lazy(() => import('./BookingDestination.jsx'))
const AdminNewBooking = lazy(() => import('./AdminNewBooking.jsx'))
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
  const calendarSurface = ['/admin', '/admin/agenda'].includes(surface)
  function close() {
    if (route.background) window.history.back()
    else { window.history.replaceState({}, '', '/admin'); setRoute(readRoute()) }
  }
  const openBooking = id => { setOpener(document.activeElement); navigate(`/admin/bookings/${id}`, context) }
  const newBooking = date => {
    window.history.pushState({ adminReturnTo: surface === '/admin/agenda' ? surface : `/admin?date=${date}` }, '', `/admin/bookings/new?date=${date}`)
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
      <button disabled title="Clients is not built yet">Clients <small>Coming soon</small></button>
      <a href="/admin/more" aria-current={surface === '/admin/more' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin/more') }}>More</a>
    </nav>}
    <Suspense fallback={<p role="status">Loading Admin…</p>}>
      <div inert={Boolean(match)}>
      {calendarSurface && <nav className="admin-calendar-views" aria-label="Calendar views">
        <a href="/admin" aria-current={surface === '/admin' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin') }}>Day</a>
        <a href="/admin/agenda" aria-current={surface === '/admin/agenda' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin/agenda') }}>Agenda</a>
      </nav>}
      {surface === '/admin' && <Calendar key={date || 'today'} initialDate={date} signOut={signOut} openBooking={openBooking} revision={revision} newBooking={newBooking} />}
      {surface === '/admin/agenda' && <Agenda openBooking={openBooking} revision={revision} newBooking={newBooking} />}
      {creating && <AdminNewBooking initialDate={date} ownerId={ownerId} registerGuard={registerGuard} onCancel={() => navigate(route.returnTo || '/admin')} onCreated={created} />}
      {surface === '/admin/review' && <PaymentReview openBooking={openBooking} revision={revision} />}
      {surface === '/admin/alerts' && <Alerts openBooking={openBooking} changed={refreshAlerts} />}
      {surface === '/admin/more' && <section className="admin-review"><h1>More</h1><p>Settings are not built yet.</p><button onClick={signOut}>Sign out</button></section>}
      {!creating && !match && !['/admin', '/admin/agenda', '/admin/review', '/admin/alerts', '/admin/more'].includes(surface) && <section className="admin-review"><h1>Admin page not found</h1><a href="/admin">Back to Calendar</a></section>}
      </div>
      {match && <BookingDestination key={match[1]} id={match[1]} close={close} returnFocus={opener} changed={() => setRevision(value => value + 1)} />}
    </Suspense>
  </>
}
