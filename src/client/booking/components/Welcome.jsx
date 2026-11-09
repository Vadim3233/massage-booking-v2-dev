import Icon from '../../../ui/icons.jsx'
import { changesNote, DEFAULT_WELCOME, paragraphs } from '../../welcome.js'
import { usualLabel } from '../usualBooking.js'

// What a new client can open under the welcome to see who is coming: Vadim's own words about how he works, his qualifications and his reviews.
// Kept here, short, until it is editable in the Admin. Every line must stay true (the rating especially).
const TRUST_SUMMARY = '5.0 on Google · 10+ years · Level 5'
const TRUST_WORDS = "Tell me where it hurts and how you feel. I'll build the session around that, not a set routine."
const TRUST_TAGS = ['10+ years in London', 'Level 5 Soft Tissue', 'BTEC & ITEC', 'ISRM member']
const GOOGLE_REVIEWS = 'https://share.google/fZ3sjkYZd2BYrC7Eg'
const ABOUT = 'https://www.vadmassage.com/about/'

// The first thing a visitor sees: who they are booking with, in the navy band, then what to expect if plans change. The areas follow straight away.
// A returning client (one with a usual booking) is offered it in one tap instead of the introduction to Vadim.
export default function Welcome({ welcome, rules, usual, bookUsual }) {
  const intro = paragraphs(welcome.welcome)
  return <section className="welcome" aria-labelledby="welcome-title">
    <div className="welcome-band">
      <div className="welcome-hero">
        <img className="welcome-photo" src="/vadim-portrait.jpg" alt="Vadim, your massage therapist" width="88" height="88" />
        <div>
          <p className="eyebrow">Soft tissue &amp; massage therapy</p>
          <h1 id="welcome-title" tabIndex={-1}>A massage that <em>comes to you</em></h1>
        </div>
      </div>
      {(intro.length ? intro : paragraphs(DEFAULT_WELCOME)).map((text, index) => <p className="lede" key={index}>{text}</p>)}
      {!usual && <details className="trust">
        <summary><Icon name="sparkle" size={16} /><span className="trust-line">{TRUST_SUMMARY}</span></summary>
        <div className="trust-body">
          <p className="trust-words">{TRUST_WORDS}<span>— Vadim</span></p>
          <ul className="trust-tags" role="list">{TRUST_TAGS.map(tag => <li key={tag}>{tag}</li>)}</ul>
          <p className="trust-links">
            <a href={GOOGLE_REVIEWS} target="_blank" rel="noopener noreferrer">Google reviews<span className="sr-only"> (opens in a new tab)</span></a>
            <a href={ABOUT} target="_blank" rel="noopener noreferrer">More about me<span className="sr-only"> (opens in a new tab)</span></a>
          </p>
        </div>
      </details>}
    </div>
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
    <p className="welcome-faq"><a href="/faq">Questions? Read the answers</a></p>
    {about.length > 0 && <details className="welcome-about"><summary>A little about me</summary>{about.map((text, index) => <p key={index}>{text}</p>)}</details>}
  </section>
}
