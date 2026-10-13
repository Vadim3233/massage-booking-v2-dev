// What the receipt screen may truthfully say about the email of a receipt. The database reports what became of the latest email
// (waiting for the sender, sent, or failed); these turn that into the few cases the screen has words for.
const GIVE_UP_AFTER = 5
// The sender normally runs every minute or so. An email still waiting after this long means it may not be running at all.
const STUCK_AFTER_MS = 10 * 60 * 1000

// 'queued': waiting for the sender. 'stuck': still waiting after ten minutes. 'retrying': it did not go through and the sender will try
// again by itself. 'failed': it gave up (five tries) or was stopped because the booking was cancelled. 'sent': delivered.
// 'unknown': an email was queued once, but its delivery record is gone, so nothing can be said about what became of it.
// null: nothing was ever emailed.
export function receiptEmailState(receipt, now = Date.now()) {
  const mail = receipt.email
  if (!mail) return receipt.emailed_at ? { status: 'unknown', to: receipt.emailed_to, at: receipt.emailed_at, queuedAt: receipt.emailed_at } : null
  const exhausted = Number(mail.attempts) >= GIVE_UP_AFTER
  const waiting = mail.status !== 'sent' && mail.status !== 'failed'
  const old = now - Date.parse(mail.queued_at) > STUCK_AFTER_MS
  let status = 'queued'
  if (mail.status === 'sent') status = 'sent'
  else if (mail.status === 'failed') status = exhausted ? 'failed' : 'retrying'
  // A send that was cut off during the last try is never picked up again, so it can only be treated as failed.
  else if (waiting && old) status = exhausted ? 'failed' : 'stuck'
  return { status, to: mail.to, at: mail.sent_at || mail.queued_at, queuedAt: mail.queued_at }
}

// True when the receipt was changed after its latest email was written, so that email still has the old words.
export function receiptEditedAfterEmail(receipt) {
  const state = receiptEmailState(receipt)
  return Boolean(state && receipt.edited_at && Date.parse(receipt.edited_at) > Date.parse(state.queuedAt))
}
