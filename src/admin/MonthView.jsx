import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { dateLabel, time, today } from './calendarPresentation.js'
import { calendarDays, clampRow, hiddenWeekdays, hoursWords, monthGrid, monthSummary, readRowHeight, shiftMonth, shortName, TONE_LABEL, TONE_WORD, writeRowHeight } from './calendarGrid.js'
import { HoursOnlySwitch, LoadState, ViewOptions } from './CalendarViewParts.jsx'
import { useCalendarKeys, useCalendarRange, useNarrow, useViewOptions } from './calendarHooks.js'
import { useShowCancelled } from './cancelledBookings.js'
import { londonClock, offerPrice } from './slotOffers.js'
import { weekdayOf } from './scheduleApi.js'
import BookingCard from './BookingCard.jsx'
import Icon from '../ui/icons.jsx'

const BlockDialog = lazy(() => import('./BlockDialog.jsx'))
const OfferDialog = lazy(() => import('./OfferDialog.jsx'))
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const longDate = date => dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })
const minutesNow = now => { const [hour, minute] = londonClock(new Date(now)).split(':').map(Number); return hour * 60 + minute }

// One line of a day square: "14:30 Sarah K.", a blocked time, or an open special-price offer.
function entryText(entry, narrow) {
  if (entry.kind === 'booking') return `${time(entry.start)} ${shortName(entry.booking, { first: narrow })}`
  if (entry.kind === 'offer') return `${time(entry.start)} Offer ${offerPrice(entry.offer)}`
  return `${time(entry.start)} ${entry.title}`
}
function entryLabel(entry, date) {
  if (entry.kind === 'booking') return `${shortName(entry.booking)}, ${dateLabel(date)} at ${time(entry.start)}, ${TONE_LABEL[entry.tone]}${entry.booking.gift_voucher_id ? ', gift voucher' : ''}`
  if (entry.kind === 'offer') return `Special offer ${offerPrice(entry.offer)}, ${dateLabel(date)} at ${time(entry.start)}`
  return `${entry.title}, ${dateLabel(date)} ${time(entry.start)} to ${time(entry.end)}`
}

// The month as a grid of six weeks, like a wall calendar (ADR-112). On a computer each day lists its first entries and a tap on a line opens it;
// the date opens the Day view. On a phone the whole day is one button that opens its list in a card from the bottom, and two fingers make the weeks taller.
export default function MonthView({ initialDate, openBooking, openDayView, revision, onDate }) {
  const narrow = useNarrow()
  const [anchor, setAnchor] = useState(() => initialDate || today())
  const grid = useMemo(() => monthGrid(anchor), [anchor])
  const range = useCalendarRange(grid.start, grid.end, revision)
  const [options, change] = useViewOptions()
  const [showCancelled, setShowCancelled] = useShowCancelled()
  const [now, setNow] = useState(Date.now)
  const [picked, setPicked] = useState(null)
  const [blockDialog, setBlockDialog] = useState(null)
  const [offerDialog, setOfferDialog] = useState(null)
  const [rowHeight, setRowHeight] = useState(readRowHeight)
  const gridRef = useRef(null)
  const rowHeightRef = useRef(rowHeight)
  useEffect(() => { rowHeightRef.current = rowHeight }, [rowHeight])
  const opener = useRef(null)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer) }, [])
  const todayDate = today()
  const nowMinutes = minutesNow(now)
  const dates = useMemo(() => grid.weeks.flatMap(week => week.days), [grid])
  const days = useMemo(() => range.data ? calendarDays(range.data, dates, { showCancelled, blocked: options.blocked }, todayDate, nowMinutes, now) : new Map(), [range.data, dates, showCancelled, options.blocked, todayDate, nowMinutes, now])
  const hidden = hiddenWeekdays(days, dates, options.daysOff)
  const shownWeekdays = [1, 2, 3, 4, 5, 6, 7].filter(weekday => !hidden.has(weekday))
  // The day a New booking starts on: the day opened on a phone, else today when it is in this month, else the 1st.
  const focusDay = picked || (anchor.slice(0, 7) === grid.month ? anchor : grid.first)
  useEffect(() => { onDate?.(focusDay); return () => onDate?.(undefined) }, [focusDay, onDate])
  // The month on show is kept in the address, so coming back to the page (or a refresh) shows the same month.
  useEffect(() => { window.history.replaceState(window.history.state, '', `/admin/month?date=${anchor}`) }, [anchor])
  const move = months => { setPicked(null); setAnchor(value => shiftMonth(value, months)) }
  const goToday = () => { setPicked(null); setAnchor(today()) }
  useCalendarKeys({ previous: () => move(-1), next: () => move(1), today: goToday })

  // Two fingers on the month make the weeks taller or shorter, like a phone's own calendar. One finger still scrolls.
  useEffect(() => {
    const element = gridRef.current
    if (!element || !narrow) return
    let start = null
    const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const down = event => { if (event.touches.length === 2) start = { distance: distance(event.touches), height: rowHeightRef.current } }
    const moveTouch = event => {
      if (!start || event.touches.length !== 2) return
      event.preventDefault()
      setRowHeight(clampRow(start.height * distance(event.touches) / Math.max(20, start.distance)))
    }
    const up = event => { if (start && event.touches.length < 2) { start = null; writeRowHeight(rowHeightRef.current) } }
    element.addEventListener('touchstart', down, { passive: true })
    element.addEventListener('touchmove', moveTouch, { passive: false })
    element.addEventListener('touchend', up)
    element.addEventListener('touchcancel', up)
    return () => { element.removeEventListener('touchstart', down); element.removeEventListener('touchmove', moveTouch); element.removeEventListener('touchend', up); element.removeEventListener('touchcancel', up) }
  }, [narrow, range.data])
  const resize = step => setRowHeight(value => { const next = clampRow(value + step); writeRowHeight(next); return next })

  // How many lines fit in a day square: three on a computer; on a phone, as many as the week's height allows.
  const lines = narrow ? Math.max(1, Math.floor((rowHeight - 30) / 29)) : 3
  const monthName = dateLabel(grid.first, { month: 'long', year: 'numeric' })
  const pickedDay = picked && days.get(picked)
  const closeSheet = () => { setPicked(null); requestAnimationFrame(() => opener.current?.focus?.()) }
  const sheetRef = useRef(null)
  useEffect(() => { if (picked) sheetRef.current?.querySelector('.calview-sheet-close')?.focus() }, [picked])

  function cell(date) {
    const day = days.get(date)
    const inMonth = date.startsWith(grid.month)
    const isToday = date === todayDate
    const classes = ['calview-day', inMonth ? '' : 'is-other', isToday ? 'is-today' : '', day && !day.open ? 'is-off' : '', day?.away ? 'is-away' : '', day?.special ? 'is-special' : '', picked === date ? 'is-picked' : '', date < todayDate ? 'is-past' : ''].filter(Boolean).join(' ')
    const number = Number(date.slice(-2)) === 1 ? dateLabel(date, { day: 'numeric', month: 'short' }) : String(Number(date.slice(-2)))
    const entries = day && !options.hoursOnly ? day.entries : []
    const fits = entries.length > lines ? Math.max(0, lines - 1) : entries.length
    const shown = entries.slice(0, fits)
    const more = entries.length - shown.length
    const hoursText = day ? hoursWords(day) : ''
    const bar = day && day.open && !options.hoursOnly && day.full > 0 && <span className="calview-full" aria-hidden="true"><span style={{ width: `${Math.round(day.full * 100)}%` }} /></span>
    const away = day?.away && !options.hoursOnly && <span className="calview-away">{day.away.number === 1 || date === grid.start ? day.away.title : 'Away'}{day.away.total > 1 ? ` · ${day.away.number}/${day.away.total}` : ''}</span>
    const big = options.hoursOnly && day && <span className={`calview-hours-big ${day.special ? 'is-special' : ''}`}>{day.away ? day.away.title : !day.hours?.available ? 'Day off' : <>{time(day.hours.start_minutes)}<br />{time(day.hours.end_minutes)}</>}{day.special && day.hours?.available && <small>special</small>}</span>
    const line = (entry, interactive) => {
      const content = <><span className="calview-mark" aria-hidden="true" />{entryText(entry, narrow)}{entry.kind === 'booking' && entry.booking.gift_voucher_id && <Icon name="gift" size={12} />}{entry.kind === 'booking' && TONE_WORD[entry.tone] && !narrow && <span className="calview-tag">{TONE_WORD[entry.tone]}</span>}</>
      const kind = `calview-entry is-${entry.kind}${entry.kind === 'booking' ? ` tone-${entry.tone}` : ''}`
      if (!interactive) return <span key={`${entry.kind}-${entry.id}`} className={kind}>{content}</span>
      const open = entry.kind === 'booking' ? () => openBooking(entry.booking.id) : entry.kind === 'offer' ? () => setOfferDialog({ date, offer: entry.offer }) : () => setBlockDialog({ date, block: entry.block })
      return <li key={`${entry.kind}-${entry.id}`}><button className={kind} aria-label={entryLabel(entry, date)} onClick={open}>{content}</button></li>
    }
    if (narrow) {
      const label = [longDate(date), hoursText, day?.booked ? `${day.booked} booked` : '', more > 0 ? `${entries.length} entries` : ''].filter(Boolean).join(', ')
      return <button key={date} className={classes} aria-label={label} aria-current={isToday ? 'date' : undefined} onClick={event => { opener.current = event.currentTarget; setPicked(date) }}>
        <span className="calview-num">{number}</span>
        {big}{away}
        {shown.map(entry => line(entry, false))}
        {more > 0 && <span className="calview-more">+{more}</span>}
        {!options.hoursOnly && day && !day.open && !day.away && !entries.length && inMonth && <span className="calview-offword">Day off</span>}
        {bar}
      </button>
    }
    return <div key={date} className={classes} aria-current={isToday ? 'date' : undefined}>
      <div className="calview-day-head">
        <button className="calview-num" aria-label={`Open ${longDate(date)}`} onClick={() => openDayView(date)}>{number}</button>
        {!options.hoursOnly && hoursText && <span className="calview-hours">{hoursText}</span>}
      </div>
      {big}{away}
      {shown.length > 0 && <ul role="list" className="calview-entries">{shown.map(entry => line(entry, true))}</ul>}
      {more > 0 && <button className="calview-more" onClick={() => openDayView(date)} aria-label={`${more} more on ${longDate(date)}, open the day`}>+{more} more</button>}
      {bar}
    </div>
  }

  return <section className={`calview calview-month ${narrow ? 'is-narrow' : ''} ${options.hoursOnly ? 'is-hours-only' : ''}`} aria-labelledby="calview-month-title">
    <div className="calview-toolbar">
      <button className="calview-pill" onClick={goToday}>Today</button>
      <button className="calview-arrow" aria-label="Previous month" onClick={() => move(-1)}><Icon name="left" size={22} /></button>
      <button className="calview-arrow" aria-label="Next month" onClick={() => move(1)}><Icon name="right" size={22} /></button>
      <h1 id="calview-month-title">{monthName}</h1>
      {days.size > 0 && range.current && !narrow && <span className="calview-summary">{monthSummary(days, grid.month, todayDate)}</span>}
      <span className="calview-spacer" />
      <HoursOnlySwitch on={options.hoursOnly} change={change} />
      <ViewOptions options={options} change={change} showCancelled={showCancelled} setShowCancelled={setShowCancelled} rowSize={narrow ? resize : null} />
    </div>
    {days.size > 0 && range.current && narrow && <p className="calview-summary is-line">{monthSummary(days, grid.month, todayDate)}</p>}
    <LoadState data={range.data} failed={range.failed} retry={range.retry} label="Loading the month" />
    {range.data && <div ref={gridRef} className={`calview-grid ${range.current ? '' : 'is-loading'}`} style={{ '--calview-cols': shownWeekdays.length, '--calview-row': `${rowHeight}px` }} aria-busy={!range.current}>
      <div className="calview-week calview-weekdays" aria-hidden="true">
        {!narrow && <span className="calview-wk">Wk</span>}
        {shownWeekdays.map(weekday => <span key={weekday}>{narrow ? WEEKDAY_NAMES[weekday - 1][0] : WEEKDAY_NAMES[weekday - 1]}</span>)}
      </div>
      {grid.weeks.map(week => <div key={week.days[0]} className="calview-week">
        {!narrow && <span className="calview-wk" aria-label={`Week ${week.number}`}>W{week.number}</span>}
        {week.days.filter(date => !hidden.has(weekdayOf(date))).map(cell)}
      </div>)}
    </div>}
    {!narrow && range.data && !options.hoursOnly && <ul role="list" className="calview-legend" aria-label="What the colours mean">
      {[['ok', 'Paid'], ['wait', 'Payment awaited'], ['needs', 'To check'], ['owed', 'Session done, not paid']].map(([tone, text]) => <li key={tone}><span className={`calview-mark tone-${tone}`} />{text}</li>)}
      <li><span className="calview-mark is-block" />Blocked time</li>
      <li><span className="calview-mark is-offer" />Special offer</li>
      <li><span className="calview-full is-sample"><span /></span>How full the day is</li>
    </ul>}

    {pickedDay && <div className="calview-sheet-backdrop" onClick={closeSheet}>
      <section ref={sheetRef} className="calview-sheet" role="dialog" aria-modal="true" aria-labelledby="calview-sheet-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') closeSheet() }}>
        <span className="calview-sheet-grip" aria-hidden="true" />
        <div className="calview-sheet-head">
          <h2 id="calview-sheet-title">{picked === todayDate ? 'Today · ' : ''}{dateLabel(picked, { weekday: 'short', day: 'numeric', month: 'short' })}</h2>
          <button className="btn--quiet calview-open-day" onClick={() => openDayView(picked)}>Open day ›</button>
          <button className="calview-sheet-close" aria-label="Close" onClick={closeSheet}><Icon name="cross" size={18} /></button>
        </div>
        <p className={`calview-sheet-hours ${pickedDay.special ? 'is-special' : ''} ${!pickedDay.open ? 'is-off' : ''}`}>{pickedDay.away ? `${pickedDay.away.title} · day ${pickedDay.away.number} of ${pickedDay.away.total}` : pickedDay.hours?.available ? `${pickedDay.special ? 'Special hours' : 'Hours'} ${time(pickedDay.hours.start_minutes)}–${time(pickedDay.hours.end_minutes)}${pickedDay.hours.note ? ` · ${pickedDay.hours.note}` : ''}` : `Day off${pickedDay.hours?.note ? ` · ${pickedDay.hours.note}` : ''}`}</p>
        {!pickedDay.entries.length && <p className="calview-sheet-empty">{pickedDay.open ? 'Nothing booked yet. Open the day to offer a free time.' : 'Enjoy your day off.'}</p>}
        <ul role="list" className="calview-sheet-list">
          {pickedDay.entries.map(entry => <li key={`${entry.kind}-${entry.id}`}>
            {entry.kind === 'booking' ? <BookingCard booking={entry.booking} open={() => openBooking(entry.booking.id)} changed={range.reread} now={new Date(now)} />
              : entry.kind === 'offer' ? <button className="admin-timeline-entry offer admin-offer-button" onClick={() => setOfferDialog({ date: picked, offer: entry.offer })}><span>Special offer · {offerPrice(entry.offer)}</span><small>{time(entry.start)} – {time(entry.end)} · tap to share</small></button>
              : <button className="admin-timeline-entry block admin-block-button" onClick={() => setBlockDialog({ date: picked, block: entry.block })}><span>{entry.title}</span><small>{time(entry.start)} – {time(entry.end)} · tap to change</small></button>}
          </li>)}
        </ul>
      </section>
    </div>}
    {offerDialog && <Suspense fallback={null}><OfferDialog date={offerDialog.date} offer={offerDialog.offer} close={() => setOfferDialog(null)} changed={range.reread} /></Suspense>}
    {blockDialog && <Suspense fallback={null}><BlockDialog date={blockDialog.date} block={blockDialog.block} close={() => setBlockDialog(null)} saved={() => { setBlockDialog(null); range.reread() }} /></Suspense>}
  </section>
}
