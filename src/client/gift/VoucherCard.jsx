import { useMemo } from 'react'
import { qrMatrix } from '../../lib/qr.js'
import { ART, messageScale, nameSize } from './giftArt.js'
import { codeShown, fromLine, giftWords, londonDate } from './giftWords.js'

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

const pct = (value, total) => `${(value / total) * 100}%`
const cq = (px, art) => `${(px / art.w) * 100}cqw`

// A line or block of words placed on the picture: centred on x (or starting at x when align is 'left'), from y down (or centred on cy).
function place(art, { x, y, cy, w = 0, align }) {
  const style = { top: pct(cy ?? y, art.h), width: w ? pct(w, art.w) : undefined, textAlign: align || 'center' }
  style.left = align === 'left' ? pct(x, art.w) : pct(x - w / 2, art.w)
  if (!w) { style.left = pct(x, art.w); style.transform = 'translateX(-50%)' }
  if (cy != null) style.transform = `${style.transform || ''} translateY(-50%)`.trim()
  return style
}

// The voucher in one of its six designs: Vadim's picture with the buyer's words on top (see giftArt.js). Scales to whatever width it is
// given, so it looks the same on a phone, on the page and printed.
// `voucher`: code, minutes, people, extras (names of the extras paid for), recipient_name, from_name, message, design, expires_at. `qrText`: where the QR code leads.
export default function VoucherCard({ voucher, qrText }) {
  const design = ART[voucher.design] ? voucher.design : 'christmas_night'
  const art = ART[design]
  const extras = (voucher.extras || []).map(name => `, ${name.toLowerCase()}`).join('')
  const what = art.what.short ? `${giftWords(voucher.minutes, voucher.people).slice(2)}${extras}` : `${giftWords(voucher.minutes, voucher.people)}${extras}, at your home`
  const message = voucher.message ? `“${voucher.message}”` : ''
  const from = fromLine(voucher.from_name, voucher.message)
  const until = voucher.expires_at ? `Valid until ${londonDate(voucher.expires_at)}` : 'Valid for 12 months'
  const code = voucher.code ? codeShown(voucher.code) : 'XXXX-XXXX'
  const lineHeight = 1.22
  const scale = messageScale(`${message} ${from || ''}`)
  const book = 'Book at booking.vadmassage.com'
  let top
  if (art.occasion) {
    const nameLine = `For ${voucher.recipient_name || ''}${from ? `, ${from.replace(/^From/, 'from')}` : ''}`
    top = <div className="v-words" style={{ ...place(art, { x: art.words.x, y: art.words.y, w: art.words.w }), maxHeight: pct(art.words.maxH, art.h), gap: cq(10, art) }}>
      <p className="v-nameline" style={{ fontSize: cq(art.nameLine.size, art), color: art.nameLine.color }}>{nameLine}</p>
      <p className="v-what" style={{ fontSize: cq(art.what.size, art), fontWeight: art.what.weight || 400, lineHeight }}>{what}</p>
      {message && <p className="v-msg" style={{ fontSize: cq(art.msg.size * scale, art) }}>{message}</p>}
    </div>
  } else {
    const name = `${art.name.prefix || ''}${voucher.recipient_name || ''}`
    const gap = art.msg.y - art.what.y - art.what.size * lineHeight
    top = <>
      <p className={`v-name${art.name.gold ? ' v-foil' : ''}${art.name.script ? ' v-script' : ''}`}
        style={{ ...place(art, { x: art.name.x, cy: art.name.cy, w: art.name.maxW + 80 }), fontSize: cq(nameSize(name, art.name), art), fontFamily: art.name.font }}>{name}</p>
      <div className="v-words" style={{ ...place(art, { x: art.what.x, y: art.what.y, w: Math.max(art.what.w, art.msg.w), align: art.what.align }),
        maxHeight: pct(art.msg.y + art.msg.maxH - art.what.y, art.h), gap: cq(Math.max(gap, 4), art) }}>
        <p className="v-what" style={{ fontSize: cq(art.what.size, art), fontWeight: art.what.weight || 400, lineHeight }}>{what}</p>
        {(message || from) && <div className="v-note" style={{ gap: cq(6, art) }}>
          {message && <p className="v-msg" style={{ fontSize: cq(art.msg.size * scale, art) }}>{message}</p>}
          {from && <p className="v-from" style={{ fontSize: cq(art.msg.size * 0.9, art) }}>{from}</p>}
        </div>}
      </div>
    </>
  }
  return <div className={`voucher voucher--art voucher--${design}`} style={{ aspectRatio: `${art.w} / ${art.h}`, color: art.ink }}
    aria-label={`Gift voucher for ${voucher.recipient_name}: ${what}. Code ${code}.`} role="img">
    <div className="v-canvas" aria-hidden="true">
      <img className="v-art" src={art.src} alt="" width={art.w} height={art.h} />
      {top}
      <p className={`v-small${art.small.oneLine ? ' v-small--one' : ''}`} style={{ ...place(art, art.small), fontSize: cq(art.small.size, art) }}>
        {art.small.oneLine ? `${until} · ${book} · Vadim Susarin · ISRM 9555` : <>{until} · {book}<br />Vadim Susarin · Level 5 Soft Tissue Therapist · ISRM 9555</>}</p>
      <div className="v-qr" style={{ left: pct(art.qr.x, art.w), top: pct(art.qr.y, art.h), width: pct(art.qr.s, art.w),
        ...(art.qr.bg && { background: art.qr.bg, padding: cq(art.qr.pad, art), borderRadius: cq(24, art) }) }}><QrCode text={qrText} /></div>
      {art.scan && <span className="v-scanline" style={{ ...place(art, { x: art.scan.x, cy: art.scan.cy }), fontSize: cq(art.scan.size, art) }}>Scan to book</span>}
      <b className="v-code" style={{ ...place(art, { x: art.code.x, cy: art.code.cy }), fontSize: cq(art.code.size, art), color: art.code.color, letterSpacing: art.code.spacing || '.04em' }}>{code}</b>
    </div>
  </div>
}
