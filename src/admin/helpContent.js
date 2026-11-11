// The Admin's Help page (More › Help): short "how do I…" answers, grouped like the app. Keep it true to the app:
// when a feature changes, change its answer here too (and the client FAQ in src/client/faq/faqContent.js).
export const ADMIN_HELP = [
  { title: 'Calendar', items: [
    { q: 'Day and Agenda: what is the difference?', a: ['Day shows one day with your bookings, travel and free time. Agenda lists every day ahead. In Agenda, "Earlier appointments" loads past days. Pressing Calendar always brings you back to today.'] },
    { q: 'How do I change my hours for one day?', a: ['Open the day and press Edit hours. Tap a half hour to turn it on or off. On a phone, swipe to scroll; hold, then slide to change several at once. The Day off switch closes the whole day. Booked times and travel are locked. Press Save when you are done.'] },
    { q: 'How do I block time?', a: ['Open the day settings and press Block time. Blocked time is not offered to clients, and travel never overlaps it.'] },
    { q: 'Where are my usual weekly hours?', a: ['More › Working hours and special days.'] },
  ] },
  { title: 'Bookings', items: [
    { q: 'How do I make a booking for a client?', a: ['Press the New booking button. You can book any length; if an area has a minimum, you only see a note, nothing stops you.'] },
    { q: 'How do I confirm a booking?', a: ['Open the booking. For a bank transfer, check the money arrived, then confirm and Mark paid. To confirm before the money arrives, use "Confirm, pay later" and Mark paid when it comes in. For cash, approve the cash request. The client gets an email (and Telegram, if they turned it on).'] },
    { q: 'How do I change who is coming, a treatment or a length?', a: ['Open the booking and press Edit booking. Add or remove a person, change each person\'s name, treatment and length, and keep the time or choose a new one, all in one go. You see the new price and what it means for the money before you save. People you don\'t change keep the price they booked at.',
      'Within the free-cancellation time the price does not go down; tick "Lower the price anyway" if you want it to. If the booking was paid and the price went down, "Refund to send" shows until you press Record refund sent. If it went up, the money shows "£X still to pay" until you press Mark extra received. The client is emailed (and sent a Telegram message) unless you untick "Send the client the new details".',
      'Clients can do the same from their booking page. They only see your usual times for the new length, can\'t go below an area\'s minimum, and you get an alert each time.'] },
    { q: 'How do I move or cancel a booking?', a: ['Open the booking and move it or press Cancel booking. When a late fee applies you can keep it or Waive fee. Mark fee received when the client pays it.'] },
    { q: 'After the appointment', a: ['Mark completed, or Mark no-show if the client was not there.'] },
    { q: 'What happens when a client books several sessions?', a: ['They pay for one at a time. A later session is paid after the one before it: the payment step says "Nothing to pay yet", and its money shows "Paid after earlier session" until it is paid.', 'It is confirmed by itself as soon as the session before it is confirmed. To confirm these yourself instead, switch off "Confirm later sessions automatically" in More › Booking rules; they then come to you as requests, and "Confirm, pay later" confirms them. When the earlier session is over, the client is sent the amount and bank details for the next one. Mark paid when the money arrives.'] },
    { q: 'How do I change the address on a booking?', a: ['Open the booking and press Edit address. An address in another area brings that area\'s fees. The price can\'t change once the booking is paid or a transfer is declared. The client is emailed.'] },
    { q: 'How do I set up repeating bookings?', a: ['Open the booking and press Repeat this booking, or use Repeating bookings on the client\'s page.'] },
    { q: 'How do I send a client my booking link?', a: ['More › Your booking link. The share button on a booking sends the Share message (More › Share message).'] },
    { q: 'Can the client add a booking to their calendar?', a: ['Yes. The message from the share button on a booking includes an "Add it to your calendar" link. It opens a page with two buttons: Google Calendar, and iPhone, Outlook or other calendars. If you move the booking, the same link gives the new time. In your own wording (More › Share message), the {calendar} blank puts the link where you want it.'] },
    { q: 'Does the share message use the client\'s name?', a: ['Yes. It starts "Hi Sarah!" with the client\'s first name, or just "Hi!" if no first name is saved. In your own wording (More › Share message), the {name} blank puts the first name where you want it.'] },
  ] },
  { title: 'To check and Alerts', items: [
    { q: 'What is in To check?', a: ['Everything waiting for you: bank transfers to check, cash requests, bookings outside your areas, and confirmed bookings still unpaid after the session.', 'When a client owes for more than one session, "Remind about both" (or all) sends one WhatsApp reminder listing each session with its date, time, length and amount.'] },
    { q: 'What is in Alerts?', a: ['What clients did: new bookings, changes and cancellations.'] },
    { q: 'What is the Waitlist?', a: ['Clients who asked to hear if a time comes free (they tapped a faded time). Find it in More › Waitlist. When a booking is cancelled, the alert names who wanted that time.'] },
    { q: 'What is Visitors?', a: ['More › Visitors shows how many people opened the booking page and how many booked, where people stop, the times people wanted but couldn\'t get, and "Worth a message": known clients who looked at times and didn\'t book.'] },
  ] },
  { title: 'Clients', items: [
    { q: 'What is on a client\'s page?', a: ['Their details, notes, bookings, Telegram and repeating bookings. The Prices section has two switches: No travel fee and No minimum booking. They apply to new bookings only.'] },
    { q: 'A client typed their phone number wrong. How do I fix it?', a: ['Open the client and press Edit details, correct the phone (or the name or email) and press Save details. If a saved number looks wrong, for example one digit too many, the client\'s page says so in red.', 'When clients book, the app checks the length (a UK mobile has 11 digits starting 07; a number from another country starts with + and its code). If it looks wrong, the client is asked to double-check it, but can still book, so look out for the red line on their page.'] },
    { q: 'The same person is in Clients twice', a: ['Open "Same person?" from Clients to combine the two into one.'] },
  ] },
  { title: 'Money and receipts', items: [
    { q: 'Where do I see my income?', a: ['More › Income. The month calendar shows each day, and "Your hour" shows what you earn per hour, counting travel.'] },
    { q: 'How do receipts work?', a: ['A receipt is made automatically when you mark a booking paid. Clients download the PDF from their booking page. Change the details printed on it in More › Receipt details.'] },
  ] },
  { title: 'Settings in More', items: [
    { q: 'How does my wife get my bookings on Telegram?', a: ['More › Family alerts › Get a link for your wife. Send it to her on WhatsApp; she taps it and presses Start in Telegram. From then on she gets a short message in Spanish when a booking is confirmed, moved or cancelled, with the day, the times and when you will likely be home, plus one of your 100 love lines, in a mixed order so they do not repeat. It never shows the client\'s name, address, phone or price. She can send /stop, or you can press Switch off on the same page.'] },
    { q: 'What can I change?', a: ['Services and prices, Extras, Areas and travel fees (postcodes, congestion charge, minimum booking length), Bank transfer details, Receipt details, Booking rules (notice, how far ahead, free cancellation time, booking limits, and whether later sessions are confirmed automatically), Welcome message, Share message, Google Calendar and Family alerts.', 'The client FAQ takes its numbers from Booking rules and Areas, so it follows your changes by itself.'] },
    { q: 'Where is the client FAQ?', a: ['At /faq on your booking site. Clients find it from the first booking screen, the payment step and their account page.'], link: { href: '/faq', text: 'Open the client FAQ' } },
  ] },
]
