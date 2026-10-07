import { lazy, Suspense, useEffect, useState } from 'react'
import Calendar from './Calendar.jsx'
import './agenda.css'
const Agenda = lazy(() => import('./Agenda.jsx'))
const PaymentReview = lazy(() => import('./PaymentReview.jsx'))
const BookingDestination = lazy(() => import('./BookingDestination.jsx'))
const readRoute = () => ({ path: window.location.pathname.replace(/\/$/, '') || '/admin', background: window.history.state?.adminBackground })
export default function AdminWorkspace({ signOut }) {
  const [route, setRoute] = useState(readRoute)
  const [revision, setRevision] = useState(0)
  const [opener, setOpener] = useState(null)
  useEffect(() => { const pop = () => setRoute(readRoute()); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop) }, [])
  function navigate(path, background) {
    window.history.pushState(background ? { adminBackground: background } : {}, '', path)
    setRoute(readRoute())
    if (!background) window.scrollTo(0, 0)
  }
  const match = route.path.match(/^\/admin\/bookings\/([^/]+)$/)
  const surface = match ? route.background : route.path
  const calendarSurface = ['/admin', '/admin/agenda'].includes(surface)
  function close() {
    if (route.background) window.history.back()
    else { window.history.replaceState({}, '', '/admin'); setRoute(readRoute()) }
  }
  const openBooking = id => { setOpener(document.activeElement); navigate(`/admin/bookings/${id}`, surface) }
  return <>
    <nav inert={Boolean(match)} className="admin-primary-nav" aria-label="Admin navigation">
      <a href="/admin" aria-current={calendarSurface ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate('/admin') } }}>Calendar</a>
      <a href="/admin/review" aria-current={surface === '/admin/review' ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate('/admin/review') } }}>Review</a>
      <button disabled title="Clients is not built yet">Clients <small>Coming soon</small></button>
      <a href="/admin/more" aria-current={surface === '/admin/more' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin/more') }}>More</a>
    </nav>
    <Suspense fallback={<p role="status">Loading Admin…</p>}>
      <div inert={Boolean(match)}>
      {calendarSurface && <nav className="admin-calendar-views" aria-label="Calendar views">
        <a href="/admin" aria-current={surface === '/admin' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin') }}>Day</a>
        <a href="/admin/agenda" aria-current={surface === '/admin/agenda' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin/agenda') }}>Agenda</a>
      </nav>}
      {surface === '/admin' && <Calendar signOut={signOut} openBooking={openBooking} revision={revision} />}
      {surface === '/admin/agenda' && <Agenda openBooking={openBooking} revision={revision} />}
      {surface === '/admin/review' && <PaymentReview openBooking={openBooking} revision={revision} />}
      {surface === '/admin/more' && <section className="admin-review"><h1>More</h1><p>Settings are not built yet.</p><button onClick={signOut}>Sign out</button></section>}
      {!match && !['/admin', '/admin/agenda', '/admin/review', '/admin/more'].includes(surface) && <section className="admin-review"><h1>Admin page not found</h1><a href="/admin">Back to Calendar</a></section>}
      </div>
      {match && <BookingDestination key={match[1]} id={match[1]} close={close} returnFocus={opener} changed={() => setRevision(value => value + 1)} />}
    </Suspense>
  </>
}
