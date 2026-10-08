import { supabase } from '../lib/supabase.js'
import { today } from './calendarPresentation.js'

const PENDING = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval']
const CONFLICT_CODES = ['PT409', '40001']
// Messages written for the Admin on the server. Anything else is replaced with a generic line.
const SAFE_MESSAGES = new Set([
  'This time is not available. Choose another time.',
  'The appointment has not started yet',
  'The fee must be between zero and the appointment price',
  'A cancellation reason can be up to 500 characters',
  'Choose a date within the next 365 days and a 30-minute start',
])

export const lifecycleActions = booking => {
  const status = booking.booking_status
  const payment = booking.booking_payments
  const actions = []
  if (status === 'confirmed' && booking.date <= today()) actions.push('complete', 'noShow')
  if (PENDING.includes(status) || status === 'confirmed') actions.push('reschedule', 'cancel')
  if (status === 'cancelled' && payment?.status === 'paid' && Number(booking.refund_due_gbp) > 0) actions.push('refund')
  if (booking.late_fee_status === 'due') actions.push('feeReceived', 'feeWaive')
  return actions
}
export const lifecycleLabels = {
  complete: 'Mark completed', noShow: 'Mark no-show', reschedule: 'Reschedule', cancel: 'Cancel booking',
  refund: 'Record refund sent', feeReceived: 'Mark fee received', feeWaive: 'Waive fee',
}

function failure(error) {
  const known = SAFE_MESSAGES.has(error.message)
  const conflict = CONFLICT_CODES.includes(error.code) && !known
  const result = new Error(known ? error.message
    : conflict ? 'This booking changed before the action was completed. Refreshing its current status.'
      : 'Could not complete the action. Refresh the booking before trying again.')
  result.conflict = conflict
  return result
}

export function createLifecycleApi(client) {
  const versions = booking => ({ p_booking_id: booking.id, p_booking_updated_at: booking.updated_at })
  const withPayment = booking => ({ ...versions(booking), p_payment_updated_at: booking.booking_payments.updated_at })
  const commands = {
    complete: (booking, id) => ['admin_complete_booking', { ...versions(booking), p_request_id: id }],
    noShow: (booking, id, input) => ['admin_mark_no_show', { ...versions(booking), p_request_id: id, p_fee_gbp: input.fee }],
    cancel: (booking, id, input) => ['admin_cancel_booking', { ...withPayment(booking), p_request_id: id, p_reason: input.reason, p_initiated_by: input.initiatedBy, p_fee_gbp: input.fee }],
    reschedule: (booking, id, input) => ['admin_reschedule_booking', { ...versions(booking), p_request_id: id, p_new_date: input.date, p_new_start_minutes: input.start, p_initiated_by: input.initiatedBy }],
    feeReceived: (booking, id) => ['admin_settle_late_fee', { ...versions(booking), p_request_id: id, p_action: 'received' }],
    feeWaive: (booking, id) => ['admin_settle_late_fee', { ...versions(booking), p_request_id: id, p_action: 'waive' }],
    refund: (booking, id) => ['admin_record_refund', { ...withPayment(booking), p_request_id: id }],
  }
  return {
    async act(kind, booking, requestId, input = {}) {
      if (!commands[kind]) throw new Error('Action unavailable.')
      const [name, args] = commands[kind](booking, requestId, input)
      const { error } = await client.rpc(name, args)
      if (error) throw failure(error)
    },
    async preview(bookingId, initiatedBy) {
      const { data, error } = await client.rpc('admin_late_fee_preview', { p_booking_id: bookingId, p_initiated_by: initiatedBy })
      if (error) throw failure(error)
      return Number(data)
    },
    async availability(date, minutes, bookingId) {
      const { data, error } = await client.rpc('admin_booking_availability', { p_date: date, p_treatment_duration_minutes: minutes, p_exclude_booking_id: bookingId })
      if (error) throw failure(error)
      return data.map(row => row.start_minutes)
    },
    async history(bookingId) {
      const [status, schedule] = await Promise.all([
        client.from('booking_status_events').select('entity,from_status,to_status,actor_type,occurred_at').eq('booking_id', bookingId).order('occurred_at'),
        client.from('booking_schedule_changes').select('from_date,from_start_minutes,to_date,to_start_minutes,actor_type,occurred_at').eq('booking_id', bookingId).order('occurred_at'),
      ])
      if (status.error || schedule.error) throw new Error('Could not load the history.')
      return [...status.data.map(row => ({ ...row, kind: row.entity })), ...schedule.data.map(row => ({ ...row, kind: 'schedule' }))]
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    },
  }
}
export const lifecycleApi = createLifecycleApi(supabase)
