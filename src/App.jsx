import { lazy, Suspense } from 'react'
import BookingFlow from './client/booking/BookingFlow.jsx'
import { supabase } from './lib/supabase.js'
import ErrorBoundary from './shared/ErrorBoundary.jsx'
import { recoveryLinkError } from './admin/recoverySession.js'
// Listens for a client's password reset link as soon as the page opens, before the page itself has loaded.
import './client/reset/recoverySession.js'

const ResetPassword = lazy(() => import('./admin/ResetPassword.jsx'))
const ClientResetPassword = lazy(() => import('./client/reset/ResetPassword.jsx'))

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'))
const AccountApp = lazy(() => import('./client/account/AccountApp.jsx'))
const ConsentPage = lazy(() => import('./client/ai/ConsentPage.jsx'))
const BookWithAi = lazy(() => import('./client/ai/BookWithAi.jsx'))

export default function App() {
  const path = window.location.pathname.replace(/\/$/, '')
  // Booking through a client's own AI assistant: where it sends them to allow it, and how to connect one.
  if (supabase && path === '/oauth/consent') return <ErrorBoundary><Suspense fallback={<p role="status">Loading…</p>}><ConsentPage /></Suspense></ErrorBoundary>
  if (supabase && path === '/book-with-ai') return <ErrorBoundary><Suspense fallback={<p role="status">Loading…</p>}><BookWithAi /></Suspense></ErrorBoundary>
  if (supabase && /^\/account(?:\/|$)/.test(window.location.pathname)) return <ErrorBoundary><Suspense fallback={<p role="status">Loading your bookings…</p>}><AccountApp /></Suspense></ErrorBoundary>
  if (supabase && window.location.pathname.replace(/\/$/, '') === '/reset-password') return <ErrorBoundary><Suspense fallback={<p role="status">Loading…</p>}><ClientResetPassword /></Suspense></ErrorBoundary>
  if (supabase && window.location.pathname.replace(/\/$/, '') === '/admin/reset-password') return <ErrorBoundary><Suspense fallback={<p role="status">Loading Admin…</p>}><ResetPassword linkError={recoveryLinkError} /></Suspense></ErrorBoundary>
  return <ErrorBoundary>{supabase ? (/^\/admin(?:\/|$)/.test(window.location.pathname) ? <Suspense fallback={<p role="status">Loading Admin…</p>}><AdminApp /></Suspense> : <BookingFlow />) : <main className="booking-shell"><h1>Online booking is unavailable</h1><p role="alert">Online booking isn't available right now. Please get in touch and I'll arrange your appointment.</p></main>}</ErrorBoundary>
}
