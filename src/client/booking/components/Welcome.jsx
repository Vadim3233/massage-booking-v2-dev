import { changesNote, DEFAULT_WELCOME, paragraphs } from '../../welcome.js'

// The first thing a visitor sees: who they are booking with, how it works, and what to expect if plans change.
export default function Welcome({ welcome, rules }) {
  const intro = paragraphs(welcome.welcome)
  const about = paragraphs(welcome.about)
  return <section className="welcome" aria-labelledby="welcome-title">
    <h1 id="welcome-title">A massage that comes to you</h1>
    {(intro.length ? intro : paragraphs(DEFAULT_WELCOME)).map((text, index) => <p key={index}>{text}</p>)}
    <ol className="welcome-steps" aria-label="How booking works">
      <li>Choose your area, treatment and how long you would like.</li>
      <li>Pick a time that suits you.</li>
      <li>Pay by bank transfer, or ask to pay in cash. I confirm your appointment myself.</li>
    </ol>
    <p className="welcome-note">{changesNote(rules)}</p>
    {about.length > 0 && <details className="welcome-about"><summary>A little about me</summary>{about.map((text, index) => <p key={index}>{text}</p>)}</details>}
  </section>
}
