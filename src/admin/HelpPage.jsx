import FaqList from '../client/faq/FaqList.jsx'
import { ADMIN_HELP } from './helpContent.js'

// More › Help: how each part of the Admin works, in short answers.
export default function HelpPage() {
  return <section className="admin-review" aria-labelledby="help-title">
    <header className="admin-review-heading"><div><h1 id="help-title">Help</h1><p>How each part of the app works. Tap a question to open it.</p></div></header>
    <FaqList sections={ADMIN_HELP} />
  </section>
}
