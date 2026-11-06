// A short log of this visit to the booking page, for Vad's Visitors page (ADR-095): the steps reached, the days looked at, the times wanted.
// The visit is a random id kept only in this page's memory, so nothing is saved on the phone and a reload is a new visit. A browser that
// asks not to be tracked (Global Privacy Control or Do Not Track) is not logged at all. Logging never gets in the way of booking: it is
// sent in the background and any failure is ignored.

export function trackingAllowed(nav = globalThis.navigator) {
  if (!nav) return false
  if (nav.globalPrivacyControl === true) return false
  return !['1', 'yes'].includes(String(nav.doNotTrack ?? globalThis.window?.doNotTrack ?? ''))
}

export function createVisitLog(send, { id = globalThis.crypto?.randomUUID?.(), allowed = trackingAllowed() } = {}) {
  let last = ''
  return {
    id,
    record(kind, detail = {}) {
      if (!allowed || !id) return
      // The same step twice in a row (a screen drawn again) is one step.
      const key = `${kind}:${JSON.stringify(detail)}`
      if (key === last) return
      last = key
      try {
        Promise.resolve(send(id, kind, detail)).catch(() => { /* Only a log. */ })
      } catch { /* Only a log. */ }
    },
  }
}

// Which log step each screen of the booking is. Step 0 is logged as 'opened' when the page loads, whatever screen it opens on.
export const STEP_KINDS = { 1: 'area', 2: 'treatment', 3: 'length', 4: 'review', 5: 'details', 6: 'payment' }
