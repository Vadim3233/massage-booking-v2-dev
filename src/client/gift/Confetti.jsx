import { useEffect, useRef } from 'react'

// "Surprise!" confetti that behaves like real paper, in the style of the well-known confetti party pages: a big "pop" from just below
// the middle of the screen, then two side bursts. Each piece is a little paper square or dot that tumbles (its corners wobble and tilt,
// so it flashes as it turns), slows in the air, drifts down and fades. Drawn on one full-screen canvas, ticked 60 times a second on
// any phone, it stops by itself and is skipped for people who ask their phone for less motion.
const COLOURS = ['#e6c47a', '#fce855', '#ec1e45', '#fe7e99', '#f6fbf6', '#4fb06d', '#c9302c']
const TICKS = 220
const STEP_MS = 1000 / 60

const random = (low, high) => low + Math.random() * (high - low)

// One burst: `count` pieces thrown from (x, y) at `angle` degrees (90 = straight up), fanned over `spread` degrees.
function burst(pieces, { x, y, count, angle = 90, spread = 60, speed = 45, decay = 0.9, scalar = 1, delay = 0 }) {
  for (let i = 0; i < count; i += 1) {
    const shape = Math.random() < 0.3 ? 'circle' : 'square'
    pieces.push({
      x, y, shape, delay,
      angle: -angle * Math.PI / 180 + (0.5 * spread - Math.random() * spread) * Math.PI / 180,
      velocity: speed * 0.5 + Math.random() * speed,
      decay, scalar,
      gravity: 3,
      drift: random(-0.4, 0.4),
      wobble: Math.random() * 10,
      wobbleSpeed: Math.min(0.11, Math.random() * 0.1 + 0.05),
      tilt: random(0.25, 0.75) * Math.PI,
      colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
      tick: 0,
    })
  }
}

// One tick of one piece: move, slow, fall, wobble and tilt, then draw it. False once it has faded away.
function tickPiece(context, p) {
  if (p.delay > 0) { p.delay -= 1; return true }
  p.x += Math.cos(p.angle) * p.velocity + p.drift
  p.y += Math.sin(p.angle) * p.velocity + p.gravity
  p.velocity *= p.decay
  p.wobble += p.wobbleSpeed
  const wobbleX = p.x + 10 * p.scalar * Math.cos(p.wobble)
  const wobbleY = p.y + 10 * p.scalar * Math.sin(p.wobble)
  p.tilt += 0.1
  const sin = Math.sin(p.tilt)
  const cos = Math.cos(p.tilt)
  const jitter = Math.random() + 2
  const progress = p.tick / TICKS
  p.tick += 1
  const x1 = p.x + jitter * cos
  const y1 = p.y + jitter * sin
  const x2 = wobbleX + jitter * cos
  const y2 = wobbleY + jitter * sin
  context.globalAlpha = Math.max(0, 1 - progress)
  context.fillStyle = p.colour
  context.beginPath()
  if (p.shape === 'circle') {
    context.ellipse(p.x, p.y, Math.abs(x2 - x1) * 0.6, Math.abs(y2 - y1) * 0.6, Math.PI / 10 * p.wobble, 0, 2 * Math.PI)
  } else {
    context.moveTo(Math.floor(p.x), Math.floor(p.y))
    context.lineTo(Math.floor(wobbleX), Math.floor(y1))
    context.lineTo(Math.floor(x2), Math.floor(y2))
    context.lineTo(Math.floor(x1), Math.floor(wobbleY))
  }
  context.closePath()
  context.fill()
  return p.tick < TICKS
}

export default function Confetti() {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    const context = canvas.getContext?.('2d')
    if (!context) return undefined
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = window.innerWidth
    const height = window.innerHeight
    canvas.width = width * ratio
    canvas.height = height * ratio
    context.scale(ratio, ratio)

    // The pop: several fans together, narrow and fast in the middle, wide and slow at the edges (about 220 pieces), then a side burst
    // from each edge a moment later.
    let pieces = []
    const x = width / 2
    const y = height * 0.7
    burst(pieces, { x, y, count: 55, spread: 26, speed: 55 })
    burst(pieces, { x, y, count: 45, spread: 60 })
    burst(pieces, { x, y, count: 70, spread: 100, decay: 0.91, scalar: 0.8 })
    burst(pieces, { x, y, count: 22, spread: 120, speed: 25, decay: 0.92, scalar: 1.2 })
    burst(pieces, { x, y, count: 22, spread: 120, speed: 45 })
    burst(pieces, { x: 0, y: height * 0.65, count: 45, angle: 60, spread: 55, delay: 18 })
    burst(pieces, { x: width, y: height * 0.65, count: 45, angle: 120, spread: 55, delay: 18 })

    let frame = 0
    let last = performance.now()
    let owed = 0
    const draw = (now) => {
      owed = Math.min(owed + (now - last) / STEP_MS, 4)
      last = now
      // 60 ticks a second whatever the screen's speed: a slow phone runs a few ticks in one frame (only the last one stays on screen).
      while (owed >= 1) {
        owed -= 1
        context.clearRect(0, 0, width, height)
        pieces = pieces.filter(p => tickPiece(context, p))
        context.globalAlpha = 1
      }
      if (pieces.length) frame = requestAnimationFrame(draw)
      else context.clearRect(0, 0, width, height)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])
  return <canvas ref={canvasRef} className="gift-confetti" aria-hidden="true" />
}
