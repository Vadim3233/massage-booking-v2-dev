import Icon from '../../../ui/icons.jsx'
import { changesNote, DEFAULT_WELCOME, paragraphs } from '../../welcome.js'
import { usualLabel } from '../usualBooking.js'

// The first thing a visitor sees: who they are booking with, how it works, and what to expect if plans change.
export default function Welcome({ welcome, rules, usual, bookUsual }) {
  const intro = paragraphs(welcome.welcome)
  const about = paragraphs(welcome.about)
  return <section className="welcome" aria-labelledby="welcome-title">
    <p className="eyebrow">Massage at your place</p>
    <h1 id="welcome-title" tabIndex={-1}>A massage that <em>comes to you</em></h1>
    {(intro.length ? intro : paragraphs(DEFAULT_WELCOME)).map((text, index) => <p className="lede" key={index}>{text}</p>)}
    {usual && <button className="usual" onClick={bookUsual}>
      <span className="usual-text"><span className="eyebrow">Book your usual</span><strong>{usualLabel(usual)}</strong></span>
      <span className="usual-go">Choose a time<Icon name="right" size={18} /></span>
    </button>}
    <ol className="welcome-steps" aria-label="How booking works">
      <li>Choose your area, treatment and how long you would like.</li>
      <li>Pick a time that suits you.</li>
      <li>Pay by bank transfer, or ask to pay in cash. I confirm your appointment myself.</li>
    </ol>
    <p className="welcome-note"><Icon name="check" size={20} />{changesNote(rules)}</p>
    {about.length > 0 && <details className="welcome-about"><summary>A little about me</summary>{about.map((text, index) => <p key={index}>{text}</p>)}</details>}
  </section>
}
