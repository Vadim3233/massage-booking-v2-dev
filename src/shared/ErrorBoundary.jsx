import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) {
      const admin = /^\/admin(?:\/|$)/.test(window.location.pathname)
      return <main className="booking-shell"><h1>Something went wrong</h1>
        <p role="alert">{admin ? 'This page could not be shown. Please reload it. If it keeps happening, tell your developer.' : "Please reload the page. If it keeps happening, get in touch and I'll arrange your appointment with you."}</p>
        <button onClick={() => window.location.reload()}>Reload</button></main>
    }
    return this.props.children
  }
}
