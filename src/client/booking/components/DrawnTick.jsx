// The "you're booked" mark (owner's choice, from the motion reel): the circle is drawn first, then the tick, 0.4 s in all.
// Under reduced motion it simply appears finished (index.css shortens every animation).
export default function DrawnTick() {
  return <div className="success-mark success-mark--drawn" aria-hidden="true">
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <circle className="tick-ring" cx="32" cy="32" r="28" />
      <path className="tick-path" d="M20 33l8 8 16-17" />
    </svg>
  </div>
}
