import { handleGoogleCalendar } from '../server/googleCalendarConnect.js'

export default function handler(request, response) { return handleGoogleCalendar(request, response) }
