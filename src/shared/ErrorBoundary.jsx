import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="booking-shell"><h1>Booking could not load</h1><p role="alert">Please allow browser storage and reload. If this continues, contact Vad for help arranging your appointment.</p><button onClick={() => window.location.reload()}>Reload</button></main>
    return this.props.children
  }
}
