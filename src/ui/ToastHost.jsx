import { useEffect, useRef, useState } from 'react'
import { subscribe } from './toast.js'

// The live region is always on the page, so a screen reader announces a message that appears in it. A message that offers
// something to press stays a little longer, and any message can be dismissed.
export default function ToastHost() {
  const [items, setItems] = useState([])
  const timers = useRef(new Set())
  useEffect(() => {
    const unsubscribe = subscribe(item => {
      setItems(list => [...list.slice(-2), item])
      if (item.ms > 0) {
        const timer = setTimeout(() => { timers.current.delete(timer); setItems(list => list.filter(entry => entry.id !== item.id)) }, item.ms)
        timers.current.add(timer)
      }
    })
    const pending = timers.current
    return () => { unsubscribe(); pending.forEach(clearTimeout); pending.clear() }
  }, [])
  const dismiss = id => setItems(list => list.filter(entry => entry.id !== id))
  return <div className="toast-host" aria-live="polite">{items.map(item => <div key={item.id} className={`toast ${item.tone === 'error' ? 'toast--error' : ''}`} role={item.tone === 'error' ? 'alert' : undefined}>
    <span>{item.text}</span>
    {item.action && <button onClick={() => { item.action.run(); dismiss(item.id) }}>{item.action.label}</button>}
    <button className="toast-close" aria-label="Dismiss message" onClick={() => dismiss(item.id)}>×</button>
  </div>)}</div>
}
