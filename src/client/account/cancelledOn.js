import { londonMoment } from '../../lib/londonMoment.js'

// The line under "Your appointment is cancelled" that says when it was cancelled ("Cancelled on Friday 16 October at 16:40."), by the clock in
// London like the rest of the page. For a client with a late fee it shows why: the cancellation can be set beside the appointment's own time.
// Nothing when the time was never recorded.
export function cancelledOn(cancelledAt, now = new Date()) {
  const moment = londonMoment(cancelledAt, { long: true, now })
  return moment ? `Cancelled on ${moment.day} at ${moment.time}.` : ''
}
