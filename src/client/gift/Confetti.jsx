import { useEffect, useRef } from 'react'

// "Surprise!" confetti that behaves like real paper: two bursts shoot up from the bottom corners, each piece slows in the air, then
// flutters down under gravity, flipping and swaying as it goes, over the whole screen. Drawn on one canvas (smooth on phones), it stops by
// itself after a few seconds and is skipped for people who ask their phone for less motion.
const COLOURS = ['#e6c47a', '#d4a24c', '#f3dfa6', '#c9302c', '#e0524d', '#fbf3e4', '#7fb38a', '#4f8a64']
const PIECES = 160
const RUN_MS = 7500

const random = (low, high) => low + Math.random() * (high - low)

function makePiece(width, height, fromLeft) {
  // Thrown hard enough to reach between half-way and near the top of the screen before they slow and float down.
  const rise = random(0.5, 0.95) * height
  const shape = Math.random()
  return {
    x: fromLeft ? random(-10, width * 0.12) : random(width * 0.88, width + 10),
    y: height + random(0, 20),
    vx: (fromLeft ? 1 : -1) * random(1.5, 9) * Math.min(1.4, width / 400),
    vy: -(rise + 120) / 30,
    w: random(6, 11),
    h: shape < 0.15 ? random(14, 20) : random(8, 14),
    round: shape > 0.85,
    colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
    spin: random(0, Math.PI * 2),
    spinSpeed: random(-0.25, 0.25),
    flip: random(0, Math.PI * 2),
    flipSpeed: random(0.08, 0.2),
    sway: random(0, Math.PI * 2),
    swaySpeed: random(0.03, 0.07),
    delay: Math.floor(random(0, 24)),
  }
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
    const pieces = Array.from({ length: PIECES }, (_, i) => makePiece(width, height, i % 2 === 0))
    const started = performance.now()
    let frame = 0
    let last = started
    const draw = (now) => {
      const step = Math.min(2, (now - last) / 16.7)
      last = now
      const age = now - started
      context.clearRect(0, 0, width, height)
      const fade = age > RUN_MS - 1200 ? Math.max(0, (RUN_MS - age) / 1200) : 1
      for (const p of pieces) {
        if (p.delay > 0) { p.delay -= step; continue }
        p.vx *= Math.pow(0.985, step)
        p.vy = p.vy * Math.pow(0.985, step) + 0.22 * step
        if (p.vy > 2.2) p.vy = 2.2 + (p.vy - 2.2) * 0.9
        p.sway += p.swaySpeed * step
        p.x += (p.vx + Math.sin(p.sway) * (p.vy > 0 ? 1.4 : 0)) * step
        p.y += p.vy * step
        p.spin += p.spinSpeed * step
        p.flip += p.flipSpeed * step
        if (p.y > height + 30) continue
        context.save()
        context.globalAlpha = fade
        context.translate(p.x, p.y)
        context.rotate(p.spin)
        context.scale(1, Math.cos(p.flip))
        context.fillStyle = p.colour
        if (p.round) { context.beginPath(); context.arc(0, 0, p.w / 2, 0, Math.PI * 2); context.fill() }
        else context.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        context.restore()
      }
      if (age < RUN_MS) frame = requestAnimationFrame(draw)
      else context.clearRect(0, 0, width, height)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])
  return <canvas ref={canvasRef} className="gift-confetti" aria-hidden="true" />
}
