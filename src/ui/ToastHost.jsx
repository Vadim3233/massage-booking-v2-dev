import { useEffect, useState } from 'react'
import { subscribe } from './toast.js'

export default function ToastHost() {
  const [items, setItems] = useState([])
  useEffect(() => subscribe(item => {
    setItems(list => [...list.slice(-2), item])
    if (item.ms > 0) setTimeout(() => setItems(list => list.filter(entry => entry.id !== item.id)), item.ms)
  }), [])
  if (!items.length) return null
  const dismiss = id => setItems(list => list.filter(entry => entry.id !== id))
  return <div className="toast-host">{items.map(item => <div key={item.id} className={`toast ${item.tone === 'error' ? 'toast--error' : ''}`} role={item.tone === 'error' ? 'alert' : 'status'}>
    <span>{item.text}</span>
    {item.action && <button onClick={() => { item.action.run(); dismiss(item.id) }}>{item.action.label}</button>}
  </div>)}</div>
}
