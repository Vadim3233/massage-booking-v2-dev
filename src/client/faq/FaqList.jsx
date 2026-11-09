import './faq.css'

// Questions grouped under headings; each question opens on its own. Used by the client FAQ and the Admin's Help page.
export default function FaqList({ sections }) {
  return sections.map(section => <section className="faq-section" key={section.title} aria-labelledby={`faq-${slug(section.title)}`}>
    <h2 id={`faq-${slug(section.title)}`}>{section.title}</h2>
    {section.items.map(item => <details className="faq-item" key={item.q}>
      <summary>{item.q}</summary>
      <div className="faq-answer">
        {item.a.map(text => <p key={text}>{text}</p>)}
        {item.list?.length > 0 && <ul>{item.list.map(line => <li key={line}>{line}</li>)}</ul>}
        {item.after?.map(text => <p key={text}>{text}</p>)}
        {item.link && <p><a href={item.link.href}>{item.link.text}</a></p>}
      </div>
    </details>)}
  </section>)
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
