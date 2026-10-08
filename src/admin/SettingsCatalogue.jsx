import { useEffect, useState } from 'react'
import { catalogueApi, DURATIONS, priceText, validateArea, validateExtra, validateService } from './catalogueApi.js'
import { money } from './calendarPresentation.js'

// Shared by the three lists: load, add, edit in place, hide or show, and move up or down.
function useList(load, key) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    load().then(rows => { if (live) { setItems(rows); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [load, key, version])
  return { items, error, setError, reload: () => setVersion(value => value + 1) }
}
const nextOrder = items => (items || []).reduce((top, item) => Math.max(top, item.display_order), 0) + 10

function Frame({ title, intro, list, children, adding, onAdd, addLabel }) {
  return <section className="admin-review" aria-labelledby="settings-title">
    <header className="admin-review-heading"><div><h1 id="settings-title">{title}</h1><p>{intro}</p></div></header>
    {list.error && <p role="alert">{list.error} <button onClick={list.reload}>Try again</button></p>}
    {!list.items && !list.error && <p role="status">Loading…</p>}
    {list.items && <>
      {!adding && <div className="admin-payment-buttons"><button onClick={onAdd}>{addLabel}</button></div>}
      {children}
    </>}
  </section>
}

function Row({ item, index, items, summary, onMove, onToggle, editing, onEdit, children, busy, hiddenWord = 'Hidden' }) {
  return <li className={`admin-setting ${item.active ? '' : 'is-hidden'}`}>
    {editing ? children : <>
      <div className="admin-setting-head"><strong>{item.name}</strong><span className="admin-detail-hint">{item.active ? 'Shown to clients' : `${hiddenWord} from clients`}</span></div>
      <p>{summary}</p>
      <div className="admin-payment-buttons">
        <button disabled={busy} onClick={onEdit}>Change</button>
        <button disabled={busy} onClick={onToggle}>{item.active ? 'Hide' : 'Show'}</button>
        <button disabled={busy || index === 0} aria-label={`Move ${item.name} up`} onClick={() => onMove(items[index - 1], item)}>↑</button>
        <button disabled={busy || index === items.length - 1} aria-label={`Move ${item.name} down`} onClick={() => onMove(item, items[index + 1])}>↓</button>
      </div>
    </>}
  </li>
}

function useSaver(list) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(work, done = 'Saved.') {
    setBusy(true); list.setError(''); setMessage('')
    try { await work(); setMessage(done); list.reload(); return true } catch (failure) { list.setError(failure.message); return false } finally { setBusy(false) }
  }
  return { busy, message, run }
}

function FormButtons({ busy, problem, onCancel, label }) {
  return <>
    {problem && <p role="alert" className="admin-field-error">{problem}</p>}
    <div className="admin-payment-buttons"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : label}</button></div>
  </>
}

// ---------------------------------------------------------------------------------------------
function ServiceForm({ initial, busy, onSave, onCancel, label }) {
  const [service, setService] = useState({ name: '', short_description: '', long_description: '', active: true, ...initial })
  const [prices, setPrices] = useState(DURATIONS.map(duration => {
    const found = initial?.service_duration_prices?.find(price => price.duration_minutes === duration)
    return { duration_minutes: duration, offered: initial ? Boolean(found?.active) : true, price: found ? priceText(found.price_gbp) : '' }
  }))
  const problem = validateService(service, prices)
  const set = patch => setService({ ...service, ...patch })
  const setPrice = (duration, patch) => setPrices(prices.map(price => price.duration_minutes === duration ? { ...price, ...patch } : price))
  return <form className="admin-client-form" onSubmit={event => { event.preventDefault(); if (!problem && !busy) onSave(service, prices) }}>
    <label className="admin-field">Name<input value={service.name} maxLength={120} disabled={busy} onChange={event => set({ name: event.target.value })} /></label>
    <label className="admin-field">Short description<input value={service.short_description || ''} maxLength={200} disabled={busy} onChange={event => set({ short_description: event.target.value })} /></label>
    <label className="admin-field">Longer description<textarea rows={3} maxLength={2000} value={service.long_description || ''} disabled={busy} onChange={event => set({ long_description: event.target.value })} /></label>
    <fieldset className="admin-address-fieldset"><legend>Lengths and prices (£)</legend>
      {prices.map(price => <div key={price.duration_minutes} className="admin-price-row">
        <label className="admin-who-row"><input type="checkbox" checked={price.offered} disabled={busy} onChange={event => setPrice(price.duration_minutes, { offered: event.target.checked })} /> {price.duration_minutes} minutes</label>
        <label className="admin-field">{`Price for ${price.duration_minutes} minutes`}<input inputMode="decimal" value={price.price} disabled={busy || !price.offered} onChange={event => setPrice(price.duration_minutes, { price: event.target.value })} /></label>
      </div>)}
    </fieldset>
    <label className="admin-who-row"><input type="checkbox" checked={service.active} disabled={busy} onChange={event => set({ active: event.target.checked })} /> Show to clients</label>
    <p className="admin-detail-hint">Price changes apply to new bookings only. Bookings already made keep the price they were booked at.</p>
    <FormButtons busy={busy} problem={problem} onCancel={onCancel} label={label} />
  </form>
}

export function ServicesSettings({ api = catalogueApi }) {
  const list = useList(api.services, 'services')
  const saver = useSaver(list)
  const [editing, setEditing] = useState(null)
  const done = () => setEditing(null)
  const priceSummary = item => (item.service_duration_prices || []).filter(price => price.active).sort((a, b) => a.duration_minutes - b.duration_minutes).map(price => `${price.duration_minutes} min ${money(price.price_gbp)}`).join(' · ') || 'No lengths offered'
  return <Frame title="Services and prices" intro="The treatments clients can choose, and what each length costs." list={list} adding={editing === 'new'} onAdd={() => setEditing('new')} addLabel="+ Add a treatment">
    {saver.message && <p role="status">{saver.message}</p>}
    {editing === 'new' && <section aria-label="Add a treatment"><h2>Add a treatment</h2>
      <ServiceForm busy={saver.busy} label="Add treatment" onCancel={done} onSave={async (service, prices) => { if (await saver.run(() => api.createService(service, prices, nextOrder(list.items)), 'Added.')) done() }} /></section>}
    <ul className="admin-setting-list">{(list.items || []).map((item, index, items) => <Row key={item.id} item={item} index={index} items={items} busy={saver.busy} summary={priceSummary(item)}
      editing={editing === item.id} onEdit={() => setEditing(item.id)} onMove={(a, b) => saver.run(() => api.swapServices(a, b), 'Order changed.')}
      onToggle={() => saver.run(() => api.saveService({ ...item, active: !item.active }, DURATIONS.map(duration => { const found = item.service_duration_prices.find(price => price.duration_minutes === duration); return { duration_minutes: duration, offered: Boolean(found?.active), price: found ? priceText(found.price_gbp) : '0' } })), item.active ? 'Hidden from clients.' : 'Shown to clients.')}>
      <ServiceForm initial={item} busy={saver.busy} label="Save changes" onCancel={done} onSave={async (service, prices) => { if (await saver.run(() => api.saveService({ ...service, id: item.id }, prices))) done() }} />
    </Row>)}</ul>
  </Frame>
}

// ---------------------------------------------------------------------------------------------
function AreaForm({ initial, busy, onSave, onCancel, label }) {
  const [area, setArea] = useState({ name: '', active: true, travel_surcharge_gbp: '0', congestion_fee_gbp: '0', ...initial, ...(initial ? { travel_surcharge_gbp: priceText(initial.travel_surcharge_gbp), congestion_fee_gbp: priceText(initial.congestion_fee_gbp) } : {}) })
  const problem = validateArea(area)
  const set = patch => setArea({ ...area, ...patch })
  return <form className="admin-client-form" onSubmit={event => { event.preventDefault(); if (!problem && !busy) onSave(area) }}>
    <label className="admin-field">Area name<input value={area.name} maxLength={80} disabled={busy} onChange={event => set({ name: event.target.value })} /></label>
    <div className="admin-hours-fields">
      <label className="admin-field">Travel surcharge (£)<input inputMode="decimal" value={area.travel_surcharge_gbp} disabled={busy} onChange={event => set({ travel_surcharge_gbp: event.target.value })} /></label>
      <label className="admin-field">Congestion charge (£)<input inputMode="decimal" value={area.congestion_fee_gbp} disabled={busy} onChange={event => set({ congestion_fee_gbp: event.target.value })} /></label>
    </div>
    <label className="admin-who-row"><input type="checkbox" checked={area.active} disabled={busy} onChange={event => set({ active: event.target.checked })} /> Clients can book here</label>
    <FormButtons busy={busy} problem={problem} onCancel={onCancel} label={label} />
  </form>
}

export function AreasSettings({ api = catalogueApi }) {
  const list = useList(api.areas, 'areas')
  const saver = useSaver(list)
  const [editing, setEditing] = useState(null)
  const done = () => setEditing(null)
  const summary = item => `Travel ${Number(item.travel_surcharge_gbp) > 0 ? money(item.travel_surcharge_gbp) : 'none'} · Congestion ${Number(item.congestion_fee_gbp) > 0 ? money(item.congestion_fee_gbp) : 'none'}`
  return <Frame title="Areas and travel fees" intro="Where you travel to, and any extra charge for each area." list={list} adding={editing === 'new'} onAdd={() => setEditing('new')} addLabel="+ Add an area">
    {saver.message && <p role="status">{saver.message}</p>}
    {editing === 'new' && <section aria-label="Add an area"><h2>Add an area</h2>
      <AreaForm busy={saver.busy} label="Add area" onCancel={done} onSave={async area => { if (await saver.run(() => api.createArea(area, nextOrder(list.items)), 'Added.')) done() }} /></section>}
    <ul className="admin-setting-list">{(list.items || []).map((item, index, items) => <Row key={item.id} item={item} index={index} items={items} busy={saver.busy} summary={summary(item)} hiddenWord="Not bookable"
      editing={editing === item.id} onEdit={() => setEditing(item.id)} onMove={(a, b) => saver.run(() => api.swapAreas(a, b), 'Order changed.')}
      onToggle={() => saver.run(() => api.saveArea({ ...item, active: !item.active, travel_surcharge_gbp: priceText(item.travel_surcharge_gbp), congestion_fee_gbp: priceText(item.congestion_fee_gbp) }), item.active ? 'Clients can no longer book this area.' : 'Clients can book this area.')}>
      <AreaForm initial={item} busy={saver.busy} label="Save changes" onCancel={done} onSave={async area => { if (await saver.run(() => api.saveArea({ ...area, id: item.id }))) done() }} />
    </Row>)}</ul>
  </Frame>
}

// ---------------------------------------------------------------------------------------------
function ExtraForm({ initial, busy, onSave, onCancel, label }) {
  const [extra, setExtra] = useState({ name: '', description: '', price_gbp: '0', duration_minutes: '0', active: true, ...initial, ...(initial ? { price_gbp: priceText(initial.price_gbp) } : {}) })
  const problem = validateExtra(extra)
  const set = patch => setExtra({ ...extra, ...patch })
  return <form className="admin-client-form" onSubmit={event => { event.preventDefault(); if (!problem && !busy) onSave(extra) }}>
    <label className="admin-field">Name<input value={extra.name} maxLength={80} disabled={busy} onChange={event => set({ name: event.target.value })} /></label>
    <label className="admin-field">Description (optional)<input value={extra.description || ''} maxLength={200} disabled={busy} onChange={event => set({ description: event.target.value })} /></label>
    <div className="admin-hours-fields">
      <label className="admin-field">Price (£)<input inputMode="decimal" value={extra.price_gbp} disabled={busy} onChange={event => set({ price_gbp: event.target.value })} /></label>
      <label className="admin-field">Extra minutes<input inputMode="numeric" value={extra.duration_minutes} disabled={busy} onChange={event => set({ duration_minutes: event.target.value })} /></label>
    </div>
    <label className="admin-who-row"><input type="checkbox" checked={extra.active} disabled={busy} onChange={event => set({ active: event.target.checked })} /> Show to clients</label>
    <FormButtons busy={busy} problem={problem} onCancel={onCancel} label={label} />
  </form>
}

export function ExtrasSettings({ api = catalogueApi }) {
  const list = useList(api.extras, 'extras')
  const saver = useSaver(list)
  const [editing, setEditing] = useState(null)
  const done = () => setEditing(null)
  const summary = item => `${Number(item.price_gbp) > 0 ? money(item.price_gbp) : 'No charge'}${item.duration_minutes > 0 ? ` · adds ${item.duration_minutes} min` : ''}`
  return <Frame title="Extras" intro="Optional additions a client can tick, such as extra strong pressure." list={list} adding={editing === 'new'} onAdd={() => setEditing('new')} addLabel="+ Add an extra">
    {saver.message && <p role="status">{saver.message}</p>}
    {editing === 'new' && <section aria-label="Add an extra"><h2>Add an extra</h2>
      <ExtraForm busy={saver.busy} label="Add extra" onCancel={done} onSave={async extra => { if (await saver.run(() => api.createExtra(extra, nextOrder(list.items)), 'Added.')) done() }} /></section>}
    <ul className="admin-setting-list">{(list.items || []).map((item, index, items) => <Row key={item.id} item={item} index={index} items={items} busy={saver.busy} summary={summary(item)}
      editing={editing === item.id} onEdit={() => setEditing(item.id)} onMove={(a, b) => saver.run(() => api.swapExtras(a, b), 'Order changed.')}
      onToggle={() => saver.run(() => api.saveExtra({ ...item, active: !item.active, price_gbp: priceText(item.price_gbp) }), item.active ? 'Hidden from clients.' : 'Shown to clients.')}>
      <ExtraForm initial={item} busy={saver.busy} label="Save changes" onCancel={done} onSave={async extra => { if (await saver.run(() => api.saveExtra({ ...extra, id: item.id }))) done() }} />
    </Row>)}</ul>
  </Frame>
}
