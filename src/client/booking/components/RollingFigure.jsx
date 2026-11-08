// A money figure whose characters slide up one after another when it appears (owner's choice, from the motion reel). The parent keys it
// on the amount, so a new amount rolls in again. Screen readers get the whole amount once; the moving characters are hidden from them.
// 0.4 s at most for an amount like £125.00: 0.22 s per character, each 25 ms after the one before.
export default function RollingFigure({ text }) {
  return <span className="rolling">
    <span className="sr-only">{text}</span>
    {[...text].map((character, index) => <span key={index} className="roll-digit" aria-hidden="true" style={{ animationDelay: `${index * 25}ms` }}>{character}</span>)}
  </span>
}
