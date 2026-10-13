import { useEffect, useState } from 'react'
import { clientsApi } from './clientsApi.js'
import { kindsText, matchedText } from './samePerson.js'

const FEW = 3

// On the Clients page: profiles the app thinks might be one person, each a tap away from the side-by-side look. It stays quiet when
// there are none, and when the list cannot be read it simply is not shown (the alerts and the profile button still work).
export default function PossibleDuplicates({ openCombine, api = clientsApi }) {
  const [pairs, setPairs] = useState([])
  const [all, setAll] = useState(false)
  useEffect(() => {
    let live = true
    api.possibleDuplicates().then(rows => { if (live) setPairs(rows || []) }, () => { /* The list is a help, not a need. */ })
    return () => { live = false }
  }, [api])
  if (!pairs.length) return null
  const shown = all ? pairs : pairs.slice(0, FEW)
  return <section className="admin-same-person" aria-labelledby="same-person-title">
    <h2 id="same-person-title">Might be the same person</h2>
    <ul role="list">{shown.map(pair => <li key={`${pair.client_a}-${pair.client_b}`}>
      <button onClick={() => openCombine(pair.client_a, pair.client_b)}>
        <strong>{pair.a_name} and {pair.b_name}</strong>
        <span>Same {matchedText(pair.matched_on)} · {kindsText(pair.a_kind, pair.b_kind)}</span>
      </button>
    </li>)}</ul>
    {pairs.length > FEW && !all && <button className="btn--quiet btn--small" onClick={() => setAll(true)}>Show all {pairs.length}</button>}
  </section>
}
