import { shiftDate, time } from '../calendarPresentation.js'
import { choiceChange, choiceValue, chosenDates, MAX_DAYS_AHEAD, repeatChoices } from '../repeatPattern.js'
import DatesPicker from './DatesPicker.jsx'

// Whether a booking repeats, and how: every week, every 2, 3 or 4 weeks, every month on the same weekday, or on dates chosen one by one.
export default function RepeatChoice({ draft, patch }) {
  const repeat = draft.repeat
  const set = change => patch({ repeat: { ...repeat, ...change } })
  const choices = repeatChoices(draft.date)
  const chosen = choices.find(item => item.value === choiceValue(repeat)) || choices[0]
  return <fieldset className="anb-repeat"><legend>Repeat</legend>
    <label className="anb-radio"><input type="checkbox" checked={Boolean(repeat.on)} onChange={event => set({ on: event.target.checked })} /><span>Repeat this booking</span></label>
    {repeat.on && <>
      <fieldset className="anb-choice"><legend>How often</legend>
        <div className="anb-choices">{choices.map(item => <label className="anb-chip" key={item.value}><input type="radio" name="admin-repeat-how" value={item.value} checked={chosen.value === item.value} onChange={() => set(choiceChange(item.value))} /><span>{item.short}</span></label>)}</div>
      </fieldset>
      <p className="anb-hint"><strong>{chosen.long}</strong>, at {time(draft.start ?? 0)}.</p>
      {repeat.kind === 'dates'
        ? <DatesPicker first={draft.date} dates={chosenDates(repeat, draft.date)} onChange={dates => set({ dates })} />
        : <label>Stop repeating after (optional)<input type="date" min={draft.date} max={shiftDate(draft.date, MAX_DAYS_AHEAD)} value={repeat.endDate || ''} onChange={event => set({ endDate: event.target.value })} /></label>}
      <p className="anb-hint">This slot is kept free for them {repeat.kind === 'dates' ? 'on each of these dates' : 'every time'}. Only the next appointment is asked to be paid: about a week before each one it becomes a booking and they get a reminder. Nothing is cancelled for you.</p>
    </>}
  </fieldset>
}
