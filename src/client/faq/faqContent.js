// The client FAQ (/faq). Every answer must stay true to what the app does today. When a feature changes, change its answer here too.
// Numbers come from the live booking rules and areas, so the page follows the Admin's own settings.

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const pounds = value => `£${Number(value).toFixed(Number(value) % 1 ? 2 : 0)}`
const lengthWords = minutes => minutes % 60 === 0 ? plural(minutes / 60, 'hour') : `${minutes} minutes`

// "Chelsea, Kensington and Fulham"
export function listWords(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function feeLines(areas) {
  const lines = []
  const congestion = areas.filter(area => Number(area.congestion_fee_gbp) > 0)
  const travel = areas.filter(area => Number(area.travel_surcharge_gbp) > 0)
  for (const area of congestion) lines.push(`${area.name}: ${pounds(area.congestion_fee_gbp)} congestion charge`)
  for (const area of travel) lines.push(`${area.name}: ${pounds(area.travel_surcharge_gbp)} travel fee`)
  return lines
}

function minimumLines(areas) {
  return areas.filter(area => Number(area.minimum_booking_minutes) > 0)
    .map(area => `${area.name}: at least ${lengthWords(Number(area.minimum_booking_minutes))} in total`)
}

export function clientFaq({ rules, areas = [] }) {
  const names = areas.map(area => area.name)
  const fees = feeLines(areas)
  const minimums = minimumLines(areas)
  const free = rules.freeHours
  const grace = rules.graceMinutes
  const cancelFee = free === 0
    ? ['You can change or cancel at no charge any time before your appointment begins.']
    : [
      `It's free to change or cancel more than ${plural(free, 'hour')} before your appointment.${grace > 0 ? ` If you change your mind within ${grace % 60 === 0 ? plural(grace / 60, 'hour') : plural(grace, 'minute')} of booking, that's free too.` : ''}`,
      'After that, a late fee of up to the full appointment price may apply. You always see the exact amount before you confirm, and I can reduce or waive it.',
    ]

  return [
    { title: 'Booking', items: [
      { q: 'How do I book?', a: ['Choose your area, the treatment and how long you would like, then a day and a time. Add your details and choose how to pay. Your time is held for you while you finish, and I confirm every appointment myself.'] },
      { q: 'Do I need an account?', a: ['No, you can book as a guest. An account keeps your details and address for next time, shows all your bookings in one place, and lets you book through your AI assistant.'] },
      { q: 'How far ahead can I book, and how late?', a: [`Up to ${plural(rules.horizonDays, 'day')} ahead, and at least ${plural(rules.noticeHours, 'hour')} before the start time.`] },
      { q: 'How long is my time held while I book?', a: ['About 20 minutes. If you need longer, the app asks whether you would like to keep it. If you do nothing, the time is released for someone else.'] },
      { q: "Why can't I see the time I want?", a: ['I travel between clients, so the times you see already allow for my journey.', 'Faded times aren\'t available right now. Tap one if you\'d like to hear if anything changes, and I\'ll let you know. If nothing suits you, press "None of these suit me" and tell me what would.'] },
      { q: 'Is my booking confirmed straight away?', a: ['Your time is reserved as soon as you book. I check every booking myself and confirm it by email, and on Telegram if you turn that on.'] },
      { q: 'Can I book more than one appointment?', a: ['Yes. New clients can book a limited number of appointments ahead at first. Once you have had your first treatment, you can book as many as you like.', 'After booking, press "Book another session": the same treatment and length are kept, so you just pick the time.'] },
      { q: 'What is a special offer link?', a: ['Sometimes a time comes free and I send a link for it, often with a special price. Open the link, choose your area and treatment, and add your details: the time and price are already set. The link page says whether the price is all you pay or whether your area\'s travel fee is added. The first person to book gets it. If it has gone, the link says so and shows my other free times.', 'A special-price booking can\'t be changed online, so just message me if you need to move it.'] },
    ] },
    { title: 'Couples and groups', items: [
      { q: 'Can I book for two people, or more?', a: ['Yes. Each person has their own treatment, one after the other, at the same address. You can choose the same length for everyone, or a different length for each person. The price is the total of each person\'s treatment.'] },
    ] },
    { title: 'Treatments', items: [
      { q: 'Which treatment should I choose?', a: ['Choose the one that feels closest to what you need. Tell me where it hurts and how you feel, and I\'ll build the session around that on the day.'] },
      { q: 'Can I add extras?', a: ['Yes. Any extras I offer are shown with their prices when you book.'] },
      { q: 'Should I tell you about health conditions or injuries?', a: ['Yes, please, but tell me directly rather than in the booking notes or through an AI assistant. I ask about anything medical myself before we start.'] },
    ] },
    { title: 'Areas and travel', items: [
      { q: 'Where do you work?', a: [names.length ? `Selected parts of ${listWords(names)}.` : 'Selected parts of West and Central London.', 'Outside my usual route? Get in touch and I\'ll see what I can do.'] },
      { q: 'Why do you ask for my postcode?', a: ['Your postcode tells me which area you are in, so the price and travel are right. If it belongs to a different area, the app tells you which one to choose. If it is outside my areas, your booking becomes a request: please don\'t pay until I have confirmed it.'] },
      { q: 'Is there a travel fee or congestion charge?', a: [fees.length ? 'Most areas have none. These areas include one:' : 'Not at the moment. If an area ever has one, it is shown in the price before you book.'], list: fees, after: fees.length ? ['It is always shown in the price before you book, never added afterwards.'] : [] },
      ...(minimums.length ? [{ q: 'Is there a minimum booking length?', a: ['In some areas the appointment needs to be a little longer:'], list: minimums, after: ['When you book for two or more people, everyone\'s time adds up. Lengths that are too short are greyed out.'] }] : []),
    ] },
    { title: 'Paying', items: [
      { q: 'How can I pay?', a: ['By bank transfer or in cash. You choose at the payment step. For your first visit, please pay by bank transfer to secure your booking; cash is welcome from your second visit.'] },
      { q: 'How does a bank transfer work?', a: ['After you reserve, you see my bank details and a payment reference. Make the transfer with that reference, then press "I\'ve made the bank transfer". I check it and confirm your appointment.'] },
      { q: 'Do I have to pay for all my sessions at once?', a: ['No. You only pay for your next session. When you book a later one, the payment step says "Nothing to pay yet". After each session I send you the amount and bank details for the next one, by email and on Telegram if you turned it on. If you pay in cash, just pay at each appointment.', 'Would you rather pay for a later session straight away? Press "I\'d rather pay for this one now".'] },
      { q: 'Can I pay later?', a: ['Sometimes I confirm a bank-transfer booking before the money arrives. Your booking then shows that the payment is still awaited, and I may send you a reminder with the date, time, length and amount so you can find it in your bank.'] },
      { q: 'How does paying in cash work?', a: ['Cash is for your second visit onwards. Choose Cash at the payment step and send me your request. I confirm it, and you pay the full amount in cash at your appointment.'] },
    ] },
    { title: 'Changing or cancelling', items: [
      { q: 'How do I change or cancel?', a: ['Use the link in your confirmation email, or sign in and open your booking, then press "Change the time" or "Cancel appointment". Booked as a guest? The link in your latest confirmation email works without a password.'], link: { href: '/account', text: 'Your bookings' } },
      { q: 'Is there a fee for changing or cancelling?', a: cancelFee },
      { q: "Can I change who's coming, the treatment or the length?", a: [
        'Yes. Open your booking and press "Change who\'s coming, treatment or length". You can add or remove a person, change a treatment or a length, and pick a time that suits the new length. You see the new price before you save.',
        free === 0 ? 'The price follows your change: if it goes down after you have paid, I send the difference back; if it goes up, you pay the extra.'
          : `More than ${plural(free, 'hour')} before your appointment, the price follows your change: if it goes down after you have paid, I send the difference back; if it goes up, you pay the extra. Within ${plural(free, 'hour')}, you can still make changes, but the price does not go down and there is no refund. If you pay in cash, I still expect the full amount.`,
      ], link: { href: '/account', text: 'Your bookings' } },
      { q: 'Can I stay a little longer on the day?', a: ['Just ask me during your session. If my next appointment allows, I add the extra time, and your booking page shows it as its own line with the price, and the new total. If you have already paid, you can pay the extra in cash there and then, or by bank transfer: the bank details are on your booking page, with an "I\'ve sent it" button for when it is done.'], link: { href: '/account', text: 'Your bookings' } },
      { q: 'What happens to my payment if I cancel?', a: ['If you have paid and a refund is due, your booking shows "Refund on its way". If a late fee applies, your booking shows that too.'] },
    ] },
    { title: 'Receipts and insurance', items: [
      { q: 'Can I get a receipt for my health insurance?', a: ['Yes. Once your appointment is paid, a PDF receipt is ready on your booking page. It shows the treatment, the date, what you paid (with travel and congestion as separate lines), and my details: Vadim Susarin, Level 5 Soft Tissue Therapist, member of the Institute for Soft Tissue Therapists (ISRM), membership number 9555.'] },
    ] },
    { title: 'Gift vouchers', items: [
      { q: 'Can I give a massage as a present?', a: ['Yes. Go to the Gift vouchers page (/gift), choose the massage, a design and a message, and pay by bank transfer. As soon as your transfer arrives I email you the voucher to print, save as a PDF or send on WhatsApp. Or I can email it to them on a day you choose, in a red envelope they open and scratch to reveal.'] },
      { q: 'What about the travel fee and congestion charge?', a: ['I only visit the areas listed on the gift page, so choose one of the cards there. "Just the massage" suits the areas with no extra charge. A card like "Congestion charge included" also covers the areas with that charge. "Everything included" covers any of my areas, so they never pay extra; choose it if you are not sure where they will book. The amount for travel is fixed when you buy, and isn\'t refunded if their area costs less. If they live outside my areas, please message me before buying.'] },
      { q: 'Can I add something extra, like a stronger massage?', a: ['Yes. Under "Add something extra?" tick any extra you would like them to have. It is paid with the voucher, shown on it, and chosen for them automatically when they book.'] },
      { q: 'How do I use a gift voucher I was given?', a: ['Open the voucher and press Choose my day, scan its code, or press "Have a gift voucher?" on the booking page and enter the code. Choose your area, the treatment and a time. When the voucher pays for everything there is nothing to pay, and your appointment is confirmed straight away. You can choose a longer massage and pay only the difference.'] },
      { q: 'Will I get a receipt for a gift voucher?', a: ['Yes. As soon as your payment arrives, a receipt is ready on your gift page (the link is in your emails): press "Download your receipt". It shows only the last letters of the code, so the gift stays a surprise. Whoever uses the voucher gets their own receipt for the massage too.'] },
      { q: 'How long is a gift voucher valid, and can it be refunded?', a: ['12 months from when it is paid for, until the end of the day printed on it. I send a reminder a month before it ends. It can be refunded within 14 days of buying if it hasn\'t been used. After that it can\'t be refunded or exchanged for cash.', 'It\'s for one visit, for the massage shown on the voucher. A longer massage costs only the difference. If a shorter one is chosen, no money or credit is left over.', 'To cancel, open the link to your gift page (it is in the email you got when you bought it). Before paying, press "Changed your mind? Cancel this gift". After paying, press "Cancel and get a refund": the code stops working straight away and I send your money back to the account it came from within 3 working days.'] },
      { q: 'Can I move or cancel a booking made with a gift voucher?', a: [free === 0
        ? 'Yes, in your account, any time before the appointment begins. If you cancel, the voucher can be used again.'
        : `Yes, in your account, up to ${free} hours before the appointment. If you cancel in time, the voucher can be used again. Within ${free} hours, it can't be moved online (please message me), and cancelling uses the voucher up. If you paid something on top of the voucher, a late fee applies only to that part.`,
        'A booking made with a voucher can only be moved to a day before the voucher ends.'] },
    ] },
    { title: 'Updates', items: [
      { q: 'How will you keep me updated?', a: ['By email, always. You can also turn on Telegram messages when you book: I\'ll message you when your appointment is confirmed, moved or cancelled. Send /stop in the chat to turn them off.', 'You can also add the appointment to your phone\'s calendar with one tap, from your booking page or from the "Add it to your calendar" link in my message. It works with iPhone, Google Calendar, Outlook and most others.'] },
    ] },
    { title: 'Your account and privacy', items: [
      { q: 'I forgot my password.', a: ['Press "Forgot password" on the sign-in page and I\'ll email you a link to choose a new one. If it doesn\'t arrive within a minute, please look in your junk folder too.'] },
      { q: 'Do you track me on the booking page?', a: ['Only the steps of your visit, so I can see where booking gets difficult. There are no tracking cookies and nothing is stored on your phone for this, and I don\'t keep your IP address or device details. If your browser asks not to be tracked, nothing is recorded. Visits are deleted after 90 days.'] },
      { q: 'I typed my phone number wrong. How do I fix it?', a: ['Next time you book, press "Edit my details" on the details step and correct it. Or let me know, and I\'ll correct it for you.', 'A UK mobile number has 11 digits and starts with 07. If your number is from another country, start with + and the country code.'] },
      { q: 'How do I see my bookings?', a: ['Sign in to see your coming and earlier appointments, their payment status and your receipts.'], link: { href: '/account', text: 'Your bookings' } },
    ] },
    { title: 'Booking with your AI assistant', items: [
      { q: 'Can I book through Claude, ChatGPT or another AI assistant?', a: ['Yes, if you have an account and a saved address. It always asks you before it books, and it never takes a payment. Changing or cancelling is done in your account.'], link: { href: '/book-with-ai', text: 'Set it up in two minutes' } },
    ] },
  ]
}
