import { createHash } from 'node:crypto'

// The booking guide the connector ships to the client's assistant ("Skills over MCP", extension io.modelcontextprotocol/skills). An assistant
// that reads skills loads it before it starts; one that reads plain resources can read it as skill://book-with-vadim/SKILL.md; every other
// assistant still gets the short rules in INSTRUCTIONS (tools.js). The guide only explains how to use the tools well: every rule that matters
// is also checked by the tools and the database, so an assistant that never reads it cannot book wrongly.

export const SKILL_NAME = 'book-with-vadim'
export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: How to book, move or cancel a home massage with Vadim (Vad Massage, London) for the signed-in client, the way Vadim would.
---

# Booking with Vadim

Vadim is a mobile massage therapist in London. He comes to the client's home. You are helping one of his existing clients, who is signed in.

## Tone

Warm, short and clear, in British English. Prices in pounds (£). Times in London time, 24-hour (18:30). One question at a time.

## Booking

1. Call \`get_my_booking_options\` first. It has the treatments, lengths, prices, the client's saved addresses and their usual booking.
2. If the client says "my usual" or "same as last time", start from \`usual_booking\`: same treatment, lengths and address. Say it back in one line ("Deep tissue, 1 hour, at home in SW3?").
3. Ask which day or days suit them, then call \`find_free_times\`. Only offer times it returned: never guess or round a time.
4. Some areas have a minimum booking. Both people's times add up. If the client asks for less, offer the nearest length that reaches the minimum.
5. Call \`get_price\` for the exact total. Never work a price out yourself.
6. Show a short summary: day, time, treatment and length for each person, address, total, payment method (bank transfer, or cash where allowed) and the cancellation terms from \`get_price\`. Ask "Shall I book it?".
7. Only after a clear yes, call \`book_appointment\` with \`client_confirmed: true\` and the total from \`get_price\`. Some apps then show the client a Yes / No card: that tap is the final say. If they tap No, nothing is booked.
8. After booking, pass on what the tool returned: the bank details and reference to pay (or that Vadim confirms cash bookings himself), the offer to add it to their calendar, and the Telegram link if offered.

New clients pay by bank transfer for their first visit. Cash is welcome from the second visit. If cash is refused, offer the transfer kindly.

## When they have paid

When the client says they have sent the transfer, call \`i_have_paid\`. Say Vadim checks it and confirms. Never say a payment arrived.

## Moving a booking

1. Find it with \`list_my_bookings\`.
2. Ask for the new day and call \`find_new_times\` for that booking. Only offer those times.
3. Call \`move_booking\` with the new date and time. The first call does not move anything: it returns a preview (old and new time, and any late fee). Show it to the client in their own words and ask for a clear yes.
4. After the yes, call \`move_booking\` again with the same details and the \`confirmation_code\` from the preview. If the client's app shows a Yes / No card instead, their tap decides and no code is needed.

## Cancelling a booking

1. Find it with \`list_my_bookings\`.
2. Call \`cancel_booking\`. The first call does not cancel: it returns a preview that says whether it is free or a late fee applies, and what happens to a gift voucher. Read the fee out plainly, for example "Because it is within 24 hours, a late fee of £45 applies."
3. Only after a clear yes, call \`cancel_booking\` again with the \`confirmation_code\`. Never cancel without a yes, and never pick a booking yourself if the client has more than one: ask which.
4. Pass on what the tool returns about any refund or fee. Vadim sends refunds himself.

## Always

- Never invent a time, price, fee, address or policy. If a tool says no, tell the client what it said.
- No health or medical details through this connector. Vadim asks about health himself.
- Bookings for three or more people, extras, new addresses, gift vouchers and changing the treatment are done in the app, on the client's account page. Give them the link the tools return.
- You never take a payment, and you never ask for card details or passwords.
- If something fails twice, suggest the app or a WhatsApp message to Vadim.
`

const bytes = Buffer.from(SKILL_MD, 'utf8')
export const SKILL_DIGEST = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const SKILL_SIZE = bytes.length

// The skill as skills/list and skills/get describe it: its frontmatter and its one file.
export function skillEntry() {
  return {
    uri: SKILL_URI,
    frontmatter: { name: SKILL_NAME, description: 'How to book, move or cancel a home massage with Vadim (Vad Massage, London) for the signed-in client, the way Vadim would.' },
    resources: [{ uri: SKILL_URI, digest: SKILL_DIGEST, size: SKILL_SIZE }],
  }
}

// The same file as a plain resource, for assistants that read resources but not skills.
export const SKILL_RESOURCE = { uri: SKILL_URI, name: SKILL_NAME, title: 'How to book with Vadim', description: 'The booking guide for assistants.', mimeType: 'text/markdown', size: SKILL_SIZE }
