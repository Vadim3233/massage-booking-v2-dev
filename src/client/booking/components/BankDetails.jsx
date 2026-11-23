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
// Wise's own flag mark (wise.design/foundations/logo), drawn in Wise's forest green on its bright green.
function WiseMark() {
  return <svg className="wise-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.488 7.469 0 15.05h11.585l1.301-3.576H7.922l3.033-3.507.01-.092L8.993 4.48h8.873l-6.878 18.925h4.706L24 .595H2.543l3.945 6.874Z" /></svg>
}

// "Have Wise?": Vadim's Wise payment link, for clients who already use Wise. It is still a bank transfer into the same account:
// the link cannot carry the amount or the reference, so both are spelled out. `then` is what to do after paying, when there is a next step.
export function PayWithWise({ link, amount, reference, then }) {
  if (!link) return null
  return <div className="wise-pay">
    <p className="wise-pay-title">Have Wise?</p>
    <a className="btn btn--block wise-button" href={link} target="_blank" rel="noopener noreferrer"><WiseMark />Pay with Wise<span className="sr-only"> (opens Wise in a new tab)</span></a>
    <p className="fine">{amount ? <>In Wise, send <strong>{amount}</strong></> : 'In Wise, send the amount'}{reference ? <> with the reference <strong>{reference}</strong></> : ''}.{then ? ` ${then}` : ''}</p>
  </div>
}

export default function BankDetails({ bank, reference, amount, then }) {
  return <>
    {bank.configured ? <dl className="prices bank-list">
      <CopyValue label="Account name" value={bank.accountName} />
      {bank.bankName && <div><dt>Bank</dt><dd><span>{bank.bankName}</span></dd></div>}
      <CopyValue label="Sort code" value={bank.sortCode} />
      <CopyValue label="Account number" value={bank.accountNumber} />
    </dl> : <p role="status">Bank-transfer details are currently unavailable. Please contact Vadim before making a transfer.</p>}
    {bank.configured && bank.note && <p className="fine">{bank.note}</p>}
    {reference && <dl className="prices bank-list bank-reference"><CopyValue label="Payment reference" value={reference} /></dl>}
    {bank.configured && <PayWithWise link={bank.wiseLink} amount={amount} reference={reference} then={then} />}
  </>
}
