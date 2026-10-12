import { useEffect, useState } from 'react'
import Icon from '../../../ui/icons.jsx'

export function CopyValue({ label, value }) {
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (message !== 'Copied') return undefined
    const timer = setTimeout(() => setMessage(''), 2200)
    return () => clearTimeout(timer)
  }, [message])
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage('Copied') }
    catch { setMessage('Unable to copy. Please copy the displayed value manually.') }
  }
  const copied = message === 'Copied'
  return <div className="copy-row"><dt>{label}</dt><dd><span className="copy-value">{value}</span> <button type="button" className="btn--small copy-button" aria-label={`${copied ? 'Copied' : 'Copy'} ${label.toLowerCase()}`} onClick={copy}><Icon name={copied ? 'tick' : 'copy'} size={16} />{copied ? 'Copied' : 'Copy'}</button><small role="status" className={message && !copied ? 'copy-failed' : 'sr-only'}>{message}</small></dd></div>
}
export default function BankDetails({ bank, reference }) {
  return <>
    {bank.configured ? <dl className="prices bank-list">
      <CopyValue label="Account name" value={bank.accountName} />
      {bank.bankName && <div><dt>Bank</dt><dd><span>{bank.bankName}</span></dd></div>}
      <CopyValue label="Sort code" value={bank.sortCode} />
      <CopyValue label="Account number" value={bank.accountNumber} />
    </dl> : <p role="status">Bank-transfer details are currently unavailable. Please contact Vad before making a transfer.</p>}
    {bank.configured && bank.note && <p className="fine">{bank.note}</p>}
    {reference && <dl className="prices bank-list bank-reference"><CopyValue label="Payment reference" value={reference} /></dl>}
  </>
}
