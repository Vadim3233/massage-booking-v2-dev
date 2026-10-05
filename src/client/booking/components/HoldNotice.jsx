import { useEffect, useRef } from 'react'

export default function HoldNotice({ hold, remaining, busy, pending, error, extend, release }) {
  const dialog = useRef(null)
  const warning = Boolean(hold && remaining > 0 && remaining <= 60 && !hold.extension_used && !pending)
  useEffect(() => {
    if (!warning) return
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [warning])

  function keepFocus(event) {
    if (event.key !== 'Tab') return
    const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')]
    const first = buttons[0]
    const last = buttons.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  if (!warning) return null
  return <dialog ref={dialog} className="hold-dialog" role="dialog" aria-modal="true" aria-labelledby="hold-warning-title"
    aria-describedby="hold-warning-message hold-warning-help" onKeyDown={keepFocus} onCancel={(event) => event.preventDefault()}>
    <h2 id="hold-warning-title">Still booking?</h2>
    <p id="hold-warning-message">Your selected appointment time is about to be released. Would you like to keep it?</p>
    {error && <p role="alert" className="error">{error}</p>}
    {busy && <p role="status">Please wait…</p>}
    <div className="actions">
      <button className="primary" disabled={busy} onClick={extend}>Keep my time</button>
      <button disabled={busy} onClick={release}>Release time</button>
    </div>
    <small id="hold-warning-help">If you do nothing, the time will be released automatically.</small>
  </dialog>
}
