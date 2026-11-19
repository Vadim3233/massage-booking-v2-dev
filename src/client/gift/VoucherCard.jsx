import { useMemo } from 'react'
import { qrMatrix } from '../../lib/qr.js'
import { codeShown, fromLine, giftWords, kicker, londonDate } from './giftWords.js'

// A QR code, drawn as one SVG path so it prints sharp at any size.
export function QrCode({ text, label = 'QR code to book', color = '#1b1b1b' }) {
  const { size, path } = useMemo(() => {
    const dark = qrMatrix(text)
    let d = ''
    dark.forEach((row, r) => row.forEach((on, c) => { if (on) d += `M${c} ${r}h1v1h-1z` }))
    return { size: dark.length, path: d }
  }, [text])
  return <svg className="qr" role="img" aria-label={label} viewBox={`-1 -1 ${size + 2} ${size + 2}`} shapeRendering="crispEdges"><path d={path} fill={color} /></svg>
}

const Bow = ({ fill, stroke, tail }) => <svg aria-hidden="true" viewBox="0 0 110 80" className="v-bow">
  <path d="M55 36 C30 6, 4 10, 10 30 C14 46, 40 44, 55 36 Z" fill={fill} stroke={stroke} strokeWidth="2" />
  <path d="M55 36 C80 6, 106 10, 100 30 C96 46, 70 44, 55 36 Z" fill={fill} stroke={stroke} strokeWidth="2" />
  <path d="M50 38 L38 76 L48 70 L52 78 Z" fill={tail} />
  <path d="M60 38 L72 76 L62 70 L58 78 Z" fill={tail} />
  <circle cx="55" cy="36" r="9" fill={fill} stroke={stroke} strokeWidth="2" />
</svg>

const Snow = ({ count = 40 }) => Array.from({ length: count }, (_, i) => <i key={i} className="v-flake" style={{ left: `${(i * 113) % 600 / 6}%`, top: `${((i * 71 + (i % 5) * 43) % 424) / 4.24}%`, '--r': 2 + (i % 3), opacity: 0.2 + (i % 4) * 0.12 }} />)

const Sprig = ({ className, gold = false }) => <svg aria-hidden="true" className={className} viewBox="0 0 190 190">
  {gold && <defs><linearGradient id="v-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a8782a" /><stop offset=".45" stopColor="#f0d68c" /><stop offset="1" stopColor="#9c6c22" /></linearGradient></defs>}
  <path d="M20 180 C60 130, 90 90, 150 30" fill="none" stroke={gold ? 'url(#v-gold)' : '#5f7d5a'} strokeWidth={gold ? 1.6 : 3} />
  {[[40, 150, -40], [62, 124, 30], [80, 110, -50], [100, 86, 20], [118, 70, -45], [138, 46, 15]].map(([x, y, a]) => <ellipse key={`${x}`} cx={x} cy={y} rx="16" ry="7"
    fill={gold ? 'none' : (x % 3 ? '#7f9e78' : '#9bb68f')} stroke={gold ? 'url(#v-gold)' : 'none'} strokeWidth="1.4" transform={`rotate(${a} ${x} ${y})`} />)}
</svg>

// The voucher in one of its six designs. Drawn at 600 × 424 and scaled to fit its box, so it looks the same on a phone, on the page and printed.
// `voucher`: code, minutes, people, extras (names of the extras paid for), recipient_name, from_name, message, design, expires_at. `qrText`: where the QR code leads.
export default function VoucherCard({ voucher, qrText }) {
  const design = voucher.design || 'christmas_night'
  const extras = (voucher.extras || []).map(name => `, ${name.toLowerCase()}`).join('')
  const what = `${giftWords(voucher.minutes, voucher.people)}${extras}, at your home`
  const message = voucher.message ? `“${voucher.message}”` : ''
  const from = fromLine(voucher.from_name, voucher.message)
  const until = voucher.expires_at ? `Valid until ${londonDate(voucher.expires_at)}` : 'Valid for 12 months'
  const code = voucher.code ? codeShown(voucher.code) : 'XXXX-XXXX'
  const scan = <div className="v-scan"><div className="v-qr"><QrCode text={qrText} /></div><span>Scan to book</span><b className="v-code">{code}</b></div>
  const small = <p className="v-small">{until} · vadmassage.com<br />Vadim Susarin · Level 5 Soft Tissue Therapist · ISRM 9555</p>
  return <div className={`voucher voucher--${design}`} aria-label={`Gift voucher for ${voucher.recipient_name}: ${what}. Code ${code}.`} role="img">
    <div className="v-canvas" aria-hidden="true">
      {design === 'christmas_night' && <>
        <Snow />
        <span className="v-frame" /><span className="v-frame v-frame--inner" />
        <span className="v-ribbon" />
        <Bow fill="#c9302c" stroke="#9e2220" tail="#b32826" />
        <div className="v-text"><p className="v-kicker">{kicker(design, voucher.message)}</p><p className="v-name">{voucher.recipient_name}</p><span className="v-rule" /><p className="v-what">{what}</p>{message && <p className="v-msg">{message}</p>}{from && <p className="v-from">{from}</p>}</div>
        {small}{scan}
      </>}
      {design === 'wrapped_present' && <>
        {Array.from({ length: 60 }, (_, i) => <i key={i} className="v-dot" style={{ left: `${((i * 89) % 600) / 6}%`, top: `${((i * 53 + (i % 7) * 19) % 424) / 4.24}%` }} />)}
        <span className="v-band v-band--h" /><span className="v-band v-band--v" />
        <Bow fill="#f3d9a4" stroke="#c9a463" tail="#e9c98a" />
        <div className="v-tag"><span className="v-hole" /><p className="v-kicker">{kicker(design, voucher.message)}</p><p className="v-name">{voucher.recipient_name}</p><p className="v-what">{what}</p>{message && <p className="v-msg">{message}</p>}{from && <p className="v-from">{from}</p>}</div>
        {scan}{small}
      </>}
      {design === 'gold_foil' && <div className="v-ticket">
        <span className="v-frame" /><span className="v-frame v-frame--inner" /><span className="v-perf" /><span className="v-notch v-notch--top" /><span className="v-notch v-notch--bottom" />
        <svg aria-hidden="true" className="v-tree" viewBox="0 0 92 150">
          <defs><linearGradient id="v-tree-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a8782a" /><stop offset=".4" stopColor="#ecd185" /><stop offset=".7" stopColor="#b8883a" /><stop offset="1" stopColor="#f0d68c" /></linearGradient></defs>
          <path d="M46 14 L49.5 22 L58 22.5 L51.5 28 L53.5 36.5 L46 32 L38.5 36.5 L40.5 28 L34 22.5 L42.5 22 Z" fill="url(#v-tree-gold)" />
          <path d="M46 40 C30 50, 62 54, 40 62 C20 70, 70 74, 34 84 C10 92, 82 96, 28 106 C4 112, 92 118, 20 128 C40 128, 70 130, 86 132" fill="none" stroke="url(#v-tree-gold)" strokeWidth="3.2" strokeLinecap="round" />
          <rect x="42" y="134" width="8" height="10" fill="url(#v-tree-gold)" />
        </svg>
        <div className="v-text"><p className="v-kicker">{kicker(design, voucher.message)}</p><p className="v-name v-foil">{voucher.recipient_name}</p><p className="v-what">{giftWords(voucher.minutes, voucher.people).slice(2)}{extras}</p><p className="v-sub">at your home, on a day that suits you</p>{message && <p className="v-msg">{message}</p>}</div>
        <p className="v-small">{until} · Vadim Susarin · Level 5 Soft Tissue Therapist · ISRM 9555</p>
        <div className="v-stub"><p className="v-foil v-greeting">{/christmas|xmas/i.test(voucher.message || '') ? 'Merry Christmas' : 'With love'}</p>{from && <p className="v-from">{from.replace(/^From/, 'from')}</p>}<div className="v-qr"><QrCode text={qrText} /></div><span>Scan to book</span><small>Code</small><b className="v-code">{code}</b></div>
      </div>}
      {design === 'black_gold' && <>
        <span className="v-frame" />
        <Sprig className="v-sprig" gold />
        <span className="v-band" />
        <Bow fill="#e2cc96" stroke="#b8913f" tail="#d1b77c" />
        <div className="v-text"><p className="v-kicker">{kicker(design, voucher.message)}</p><p className="v-name v-foil">{voucher.recipient_name}</p><p className="v-what">{what}</p>{message && <p className="v-msg">{message}</p>}{from && <p className="v-from">{from}</p>}</div>
        <p className="v-small">{until} · Vadim Susarin · Level 5 Soft Tissue Therapist · ISRM 9555</p>
        <div className="v-scan"><div className="v-qr"><QrCode text={qrText} /></div><span>Scan to book</span><b className="v-code v-foil">{code}</b></div>
      </>}
      {design === 'navy_gold' && <>
        <img className="v-art" src="/gift-voucher-navy.webp" alt="" width="1366" height="864" />
        <p className="v-name v-foil">{voucher.recipient_name}</p>
        <div className="v-text"><p className="v-what">{what}</p>{message && <p className={`v-msg${message.length > 200 ? ' v-msg--longer' : message.length > 90 ? ' v-msg--long' : ''}`}>{message}</p>}{from && <p className="v-from">{from}</p>}</div>
        <p className="v-small">{until} · vadmassage.com<br />Vadim Susarin · Level 5 Soft Tissue Therapist · ISRM 9555</p>
        <div className="v-scan"><div className="v-qr"><QrCode text={qrText} /></div><span>Scan to book</span><b className="v-code">{code}</b></div>
      </>}
      {design === 'any_occasion' && <>
        <span className="v-blob v-blob--a" /><span className="v-blob v-blob--b" />
        <Sprig className="v-sprig v-sprig--a" /><Sprig className="v-sprig v-sprig--b" />
        <div className="v-panel">
          <div className="v-text"><p className="v-kicker">A little gift of calm</p><p className="v-name">for {voucher.recipient_name}</p><p className="v-what">{what}</p>{message && <p className="v-msg">{message}</p>}{from && <p className="v-from">{from}</p>}{small}</div>
          {scan}
        </div>
      </>}
    </div>
  </div>
}
