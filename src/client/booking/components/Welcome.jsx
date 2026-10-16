import Icon from '../../../ui/icons.jsx'
import { changesNote, DEFAULT_WELCOME, paragraphs } from '../../welcome.js'
import { usualLabel } from '../usualBooking.js'

// The first thing a visitor sees: who they are booking with and what to expect if plans change. The areas to choose from follow straight away.
export default function Welcome({ welcome, rules, usual, bookUsual }) {
  const intro = paragraphs(welcome.welcome)
  return <section className="welcome" aria-labelledby="welcome-title">
    <p className="eyebrow">Massage at your place</p>
    <h1 id="welcome-title" tabIndex={-1}>A massage that <em>comes to you</em></h1>
    {(intro.length ? intro : paragraphs(DEFAULT_WELCOME)).map((text, index) => <p className="lede" key={index}>{text}</p>)}
    {usual && <button className="usual" onClick={bookUsual}>
      <span className="usual-text"><span className="eyebrow">Book your usual</span><strong>{usualLabel(usual)}</strong></span>
      <span className="usual-go">Choose a time<Icon name="right" size={18} /></span>
    </button>}
    <p className="welcome-note"><Icon name="check" size={20} />{changesNote(rules)}</p>
  </section>
}

// What is below the areas: the three steps, and a little about the person who will visit.
export function HowItWorks({ welcome }) {
  const about = paragraphs(welcome.about)
  return <section className="welcome welcome--after">
    <ol role="list" className="welcome-steps" aria-label="How booking works">
      <li>Choose your area, treatment and how long you would like.</li>
      <li>Pick a time that suits you.</li>
      <li>Pay by bank transfer, or by cash if you prefer. I confirm your appointment myself.</li>
    </ol>
    {about.length > 0 && <details className="welcome-about"><summary>A little about me</summary>{about.map((text, index) => <p key={index}>{text}</p>)}</details>}
  </section>
}
