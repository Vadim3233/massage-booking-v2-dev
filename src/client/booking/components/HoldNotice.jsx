export default function HoldNotice({ hold, remaining, busy, pending, extend, release }) {
  const shouldWarn = Boolean(
    hold
    && remaining > 0
    && remaining <= 60
    && !hold.extension_used
    && !pending
  )

  if (!shouldWarn) return null

  return <div className="hold-modal-backdrop">
    <section
      className="hold-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hold-warning-title"
      aria-describedby="hold-warning-copy"
    >
      <h2 id="hold-warning-title">Still booking?</h2>
      <p id="hold-warning-copy">Your selected appointment time is about to be released. Would you like to keep it?</p>
      <div className="actions">
        <button className="hold-keep" autoFocus disabled={busy} onClick={extend}>Keep my time</button>
        <button disabled={busy} onClick={release}>Release time</button>
      </div>
      <small>If you do nothing, the time will be released automatically.</small>
    </section>
  </div>
}
