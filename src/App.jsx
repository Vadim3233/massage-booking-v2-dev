import BookingFlow from './client/booking/BookingFlow.jsx'
import { supabase } from './lib/supabase.js'
import ErrorBoundary from './shared/ErrorBoundary.jsx'

export default function App() {
  return <ErrorBoundary>{supabase ? <BookingFlow /> : <main className="booking-shell"><h1>Online booking is unavailable</h1><p role="alert">Booking configuration is missing. Please contact Vad.</p></main>}</ErrorBoundary>
}
