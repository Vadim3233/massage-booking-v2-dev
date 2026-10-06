import { lazy, Suspense } from 'react'
import BookingFlow from './client/booking/BookingFlow.jsx'
import { supabase } from './lib/supabase.js'
import ErrorBoundary from './shared/ErrorBoundary.jsx'
import { recoveryLinkError } from './admin/recoverySession.js'

const ResetPassword = lazy(() => import('./admin/ResetPassword.jsx'))

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'))

export default function App() {
  if (supabase && window.location.pathname.replace(/\/$/, '') === '/admin/reset-password') return <ErrorBoundary><Suspense fallback={<p role="status">Loading Admin…</p>}><ResetPassword linkError={recoveryLinkError} /></Suspense></ErrorBoundary>
  return <ErrorBoundary>{supabase ? (window.location.pathname.replace(/\/$/, '') === '/admin' ? <Suspense fallback={<p role="status">Loading Admin…</p>}><AdminApp /></Suspense> : <BookingFlow />) : <main className="booking-shell"><h1>Online booking is unavailable</h1><p role="alert">Booking configuration is missing. Please contact Vad.</p></main>}</ErrorBoundary>
}
