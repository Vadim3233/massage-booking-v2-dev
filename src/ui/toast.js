// Tiny message bus: any screen can say what just happened, one host on the page shows it.
const listeners = new Set()
let next = 1

export function toast(text, options = {}) {
  const item = { id: next++, text, tone: options.tone || 'ok', action: options.action || null, ms: options.ms ?? (options.tone === 'error' ? 8000 : 4000) }
  listeners.forEach(listener => listener(item))
  return item.id
}
export const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
