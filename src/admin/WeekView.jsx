import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { dateLabel, dayTimeline, shiftDate, time, today } from './calendarPresentation.js'
import { calendarDays, hiddenWeekdays, hoursWords, isoWeek, placeColumns, shortName, TONE_LABEL, TONE_WORD, weekDates, weekSpan, weekStart } from './calendarGrid.js'
import { HoursOnlySwitch, LoadState, ViewOptions } from './CalendarViewParts.jsx'
import { useCalendarKeys, useCalendarRange, useNarrow, useViewOptions } from './calendarHooks.js'
import { listedBookings, useShowCancelled } from './cancelledBookings.js'
import { canOffer, isUsualPrice, londonClock, offerPrice, roomAround, withOffers } from './slotOffers.js'
import { weekdayOf } from './scheduleApi.js'
import Icon from '../ui/icons.jsx'

const BlockDialog = lazy(() => import('./BlockDialog.jsx'))
const OfferDialog = lazy(() => import('./OfferDialog.jsx'))
const PER_HOUR = 64
const minutesNow = now => { const [hour, minute] = londonClock(new Date(now)).split(':').map(Number); return hour * 60 + minute }
const longDate = date => dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })

// A week as a time grid, like a paper diary (ADR-112): Monday to Sunday on a computer, three days on a phone. Each booking is a box as long as the
// visit; travel time shows either side when ticked; a free stretch still to come can be tapped to offer it, as in the Day view.
export default function WeekView({ initialDate, openBooking, openDayView, openHours, revision, onDate }) {
  const narrow = useNarrow()
  const [anchor, setAnchor] = useState(() => initialDate || today())
  const dates = useMemo(() => weekDates(anchor, narrow), [anchor, narrow])
  const range = useCalendarRange(dates[0], shiftDate(dates.at(-1), 1), revision)
  const [options, change] = useViewOptions()
  const [showCancelled, setShowCancelled] = useShowCancelled()
  const [now, setNow] = useState(Date.now)
  const [blockDialog, setBlockDialog] = useState(null)
  const [offerDialog, setOfferDialog] = useState(null)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer) }, [])
  useEffect(() => { onDate?.(anchor); return () => onDate?.(undefined) }, [anchor, onDate])
  useEffect(() => { window.history.replaceState(window.history.state, '', `/admin/week?date=${anchor}`) }, [anchor])
  const todayDate = today()
  const nowMinutes = minutesNow(now)
  const step = narrow ? 3 : 7
  const move = direction => setAnchor(value => narrow ? shiftDate(value, direction * step) : shiftDate(weekStart(value), direction * 7))
  useCalendarKeys({ previous: () => move(-1), next: () => move(1), today: () => setAnchor(today()) })

  const data = range.data
  const days = useMemo(() => data ? calendarDays(data, dates, { showCancelled, blocked: options.blocked }, todayDate, nowMinutes, now) : new Map(), [data, dates, showCancelled, options.blocked, todayDate, nowMinutes, now])
  // Each day's rows, worked out as the Day view does (free time, travel, holds), with open offers in their place.
  const rowsByDate = useMemo(() => {
    const map = new Map()
    if (!data) return map
    for (const date of dates) {
      const bookings = listedBookings(data.bookings.filter(row => row.date === date), showCancelled)
      const timeline = dayTimeline({ dayHours: data.dayHours, blocks: data.blocks.filter(row => row.date === date), bookings, holds: data.holds.filter(row => row.date === date) }, date, now)
      map.set(date, withOffers(timeline.rows, data.offers.filter(row => row.date === date)))
    }
    return map
  }, [data, dates, showCancelled, now])
  const hidden = hiddenWeekdays(days, dates, options.daysOff)
  const shown = dates.filter(date => !hidden.has(weekdayOf(date)))
  const visibleRows = date => (rowsByDate.get(date) || []).filter(row => {
    if (options.hoursOnly) return false
    if (row.kind === 'buffer') return options.travel
    if (row.kind === 'block') return options.blocked && row.block?.kind !== 'series_hold'
    return true
  })
  const span = weekSpan(shown.map(date => days.get(date)).filter(Boolean), new Map(shown.map(date => [date, visibleRows(date)])))
  const top = minutes => (minutes - span.from) * PER_HOUR / 60
  const height = (span.to - span.from) * PER_HOUR / 60
  const hours = []
  for (let minutes = span.from; minutes < span.to; minutes += 60) hours.push(minutes)
  const title = narrow ? `${dateLabel(dates[0], { day: 'numeric', month: 'short' })} – ${dateLabel(dates.at(-1), { day: 'numeric', month: 'short', year: 'numeric' })}` : `${dateLabel(dates[0], { day: 'numeric', month: dates[0].slice(5, 7) === dates[6].slice(5, 7) ? undefined : 'short' })} – ${dateLabel(dates[6], { day: 'numeric', month: 'long', year: 'numeric' })}`
  const booked = shown.reduce((sum, date) => sum + (days.get(date)?.booked || 0), 0)

  function entry(date, row) {
    const style = { top: `${top(row.start)}px`, height: `${Math.max(18, top(row.end) - top(row.start) - 2)}px`, left: `calc(${(row.lane / row.lanes) * 100}% + 3px)`, width: `calc(${100 / row.lanes}% - 6px)` }
    const span = `${time(row.start)}–${time(row.end)}`
    if (row.kind === 'booking') {
      const day = days.get(date)
      const tone = day?.entries.find(item => item.kind === 'booking' && item.id === row.booking.id)?.tone || 'ok'
      return <button key={`b-${row.id}`} className={`calview-box tone-${tone}`} style={style} onClick={() => openBooking(row.booking.id)} aria-label={`${shortName(row.booking)}, ${span}, ${TONE_LABEL[tone]}`}>
        <strong>{time(row.start)}</strong> <span>{shortName(row.booking, { first: narrow })}</span>{row.booking.gift_voucher_id && <Icon name="gift" size={12} />}
        {TONE_WORD[tone] && <small>{TONE_WORD[tone]}</small>}
      </button>
    }
    if (row.kind === 'offer') return <button key={`o-${row.id}`} className="calview-box is-offer" style={style} onClick={() => setOfferDialog({ date, offer: row.offer })}><strong>{time(row.start)}</strong> <span>{isUsualPrice(row.offer) ? 'Offered' : 'Offer'} {offerPrice(row.offer)}</span><small>tap to share</small></button>
    if (row.kind === 'block') return <button key={`k-${row.id}`} className="calview-box is-block" style={style} onClick={() => setBlockDialog({ date, block: row.block })} aria-label={`${row.title}, ${span}, tap to change`}><strong>{time(row.start)}</strong> <span>{row.title}</span></button>
    if (row.kind === 'buffer') return <div key={`t-${row.id}`} className="calview-box is-travel" style={style}><span>Travel</span></div>
    if (row.kind === 'hold') return <div key={`h-${row.id}`} className="calview-box is-hold" style={style}><span>Someone is booking</span></div>
    if (row.kind === 'free' && canOffer(date, row, todayDate, nowMinutes) && row.end - row.start >= 30) {
      const all = rowsByDate.get(date) || []
      return <button key={`f-${row.id}`} className="calview-free" style={style} onClick={() => setOfferDialog({ date, free: roomAround(all, row) })} aria-label={`Free ${span} on ${longDate(date)}, tap to offer it to clients`}><span>Free</span></button>
    }
    return null
  }

  return <section className={`calview calview-weekview ${narrow ? 'is-narrow' : ''} ${options.hoursOnly ? 'is-hours-only' : ''}`} aria-labelledby="calview-week-title">
    <div className="calview-toolbar">
      <button className="calview-pill" onClick={() => setAnchor(today())}>Today</button>
      <button className="calview-arrow" aria-label={narrow ? 'Previous 3 days' : 'Previous week'} onClick={() => move(-1)}><Icon name="left" size={22} /></button>
      <button className="calview-arrow" aria-label={narrow ? 'Next 3 days' : 'Next week'} onClick={() => move(1)}><Icon name="right" size={22} /></button>
      <h1 id="calview-week-title">{title}</h1>
      {!narrow && range.current && days.size > 0 && <span className="calview-summary">Week {isoWeek(dates[0])} · {booked} {booked === 1 ? 'session' : 'sessions'}</span>}
      <span className="calview-spacer" />
      <HoursOnlySwitch on={options.hoursOnly} change={change} />
      <ViewOptions options={options} change={change} showCancelled={showCancelled} setShowCancelled={setShowCancelled} week />
    </div>
    <LoadState data={data} failed={range.failed} retry={range.retry} label="Loading the week" />
    {data && <div className={`calview-timegrid ${range.current ? '' : 'is-loading'}`} style={{ '--calview-cols': shown.length }} aria-busy={!range.current}>
      <div className="calview-timehead">
        <span />
        {shown.map(date => { const day = days.get(date); return <button key={date} className={`calview-colhead ${date === todayDate ? 'is-today' : ''}`} onClick={() => openDayView(date)} aria-label={`Open ${longDate(date)}`} aria-current={date === todayDate ? 'date' : undefined}>
          <span className="calview-colday">{dateLabel(date, { weekday: 'short' })} <strong>{Number(date.slice(-2))}</strong></span>
          <span className={`calview-hours ${day?.special ? 'is-special' : ''} ${day && !day.open ? 'is-off' : ''}`}>{day?.away ? day.away.title : day ? hoursWords(day) : ''}</span>
        </button> })}
      </div>
      <div className="calview-timebody" style={{ height: `${height}px` }}>
        <div className="calview-times" aria-hidden="true">{hours.map(minutes => <span key={minutes} style={{ top: `${top(minutes)}px` }}>{time(minutes)}</span>)}</div>
        {shown.map(date => {
          const day = days.get(date)
          const open = day?.open && day.hours
          const rows = placeColumns(visibleRows(date).filter(row => row.end > row.start))
          return <div key={date} className={`calview-col ${day && !day.open ? 'is-off' : ''} ${date === todayDate ? 'is-today' : ''}`} aria-label={longDate(date)} role="group">
            {hours.slice(1).map(minutes => <span key={minutes} className="calview-hourline" style={{ top: `${top(minutes)}px` }} aria-hidden="true" />)}
            {open && <span className="calview-open" style={{ top: `${top(day.hours.start_minutes)}px`, height: `${top(day.hours.end_minutes) - top(day.hours.start_minutes)}px` }}>
              {options.hoursOnly && <span className="calview-open-times"><strong>{time(day.hours.start_minutes)}</strong><span>to</span><strong>{time(day.hours.end_minutes)}</strong>{day.special && <small>special</small>}</span>}
            </span>}
            {day && !day.open && <span className="calview-offcard">{day.away ? day.away.title : 'Day off'}</span>}
            {options.hoursOnly && openHours && date >= todayDate && !day?.away && <button className="calview-edit-hours" onClick={() => openHours(date)} aria-label={`Change the hours of ${longDate(date)}: ${day ? hoursWords(day) : ''}`}><span>Change hours</span></button>}
            {date === todayDate && nowMinutes >= span.from && nowMinutes <= span.to && <span className="calview-now" style={{ top: `${top(nowMinutes)}px` }} aria-hidden="true" />}
            {rows.map(row => entry(date, row))}
          </div>
        })}
      </div>
    </div>}
    {!options.hoursOnly && data && <p className="calview-note">White is your working hours. {options.travel ? 'Travel shows as striped boxes.' : 'Tick Travel time in View options to see the drive either side.'} Tap Free to offer it to clients.</p>}
    {offerDialog && <Suspense fallback={null}><OfferDialog date={offerDialog.date} free={offerDialog.free} offer={offerDialog.offer} close={() => setOfferDialog(null)} changed={range.reread} /></Suspense>}
    {blockDialog && <Suspense fallback={null}><BlockDialog date={blockDialog.date} block={blockDialog.block} close={() => setBlockDialog(null)} saved={() => { setBlockDialog(null); range.reread() }} /></Suspense>}
  </section>
}
