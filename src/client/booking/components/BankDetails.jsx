import { useState } from 'react'

export function CopyValue({ label, value }) {
  const [message, setMessage] = useState('')
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage('Copied') }
    catch { setMessage('Unable to copy. Please copy the displayed value manually.') }
  }
  return <div><dt>{label}</dt><dd><span>{value}</span> <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}>Copy</button><small role="status">{message}</small></dd></div>
}
export default function BankDetails({ bank, reference }) {
  return <>
    {bank.configured ? <dl className="prices">
      <CopyValue label="Account name" value={bank.accountName} />
      <CopyValue label="Sort code" value={bank.sortCode} />
      <CopyValue label="Account number" value={bank.accountNumber} />
    </dl> : <p role="status">Bank-transfer details are currently unavailable. Please contact Vad before making a transfer.</p>}
    {reference && <dl className="prices"><CopyValue label="Payment reference" value={reference} /></dl>}
  </>
}
