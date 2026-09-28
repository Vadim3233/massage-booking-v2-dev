export default function HoldNotice({ hold, remaining, busy, pending, extend, release }) {
  if (!hold) return null
  return <aside className="hold" aria-label="Appointment time hold">
    <p role="status">{remaining > 0
      ? `Your time is held for ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
      : 'Your time hold has expired. Your details are saved.'}</p>
    {remaining > 0 && remaining <= 300 && !hold.extension_used && !pending && <>
      <p role="alert">Still booking? Your appointment time is held for another 5 minutes.</p>
      <div className="actions">
        <button disabled={busy} onClick={extend}>Keep my time</button>
        <button disabled={busy} onClick={release}>Release time</button>
      </div>
    </>}
    {hold.extension_used && remaining > 0 && <small>Your one-time 10-minute extension has been applied.</small>}
  </aside>
}
