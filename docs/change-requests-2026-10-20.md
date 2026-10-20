# Change requests from Vadim (2026-10-20)

Five changes added after `docs/admin-ui-notes.md` (Part A) and `docs/google-calendar-sync-brief.md` (Part B), saved as sent. The analysis, the decisions Vadim made in the questionnaire, and the agreed order are under **Answers and order** at the end.

## Change 1 – Share message: add cancellation terms (add-on to Part A §3)

In the shared booking message, add the exact last moment the client can cancel with a full refund, as a date and time in London time, plus one short line on what happens after that. For example: "Free cancellation until Wed 28 Oct, 17:30. After that, the full session price may be charged."

- Calculate the deadline in the backend, from the same cancellation-policy rules the system already uses for cancellation fees and refunds (the 24-hour rule, and the grace period for bookings made less than 24 hours before the appointment). Don't recreate the policy in React. If no function returns this deadline yet, add a small read-only one and use it in the share message.
- If the free-cancellation moment has already passed when I share, say so plainly instead: "The free cancellation period has ended."
- Tests: a booking made well in advance (deadline = start − 24h), a booking made inside 24 hours (grace period applies), and a deadline that falls across the clocks change on 25 Oct 2026.

## Change 2 – Client booking: make the number of people impossible to misread

Context: a client booked 1 person × 120 min (£170), but claimed he understood it as 2 people × 60 min (£180). The page said "per person", but that was too easy to miss.

- Make "How many people?" its own required step, before duration. Use large buttons: "Just me", "2 people", "3 people", and so on, up to the maximum the booking system already allows (taken from the existing rules or settings, not a hard-coded number). Nothing is pre-selected; the client must tap one.
- Every option states the number of people, the length of each session and the total price. For example: "60 min · 1 person · £90"; "2 hours · 1 person · £170"; "2 people × 60 min, one after the other · 2 hours in total · £180". Don't rely on a "per person" label alone.
- If people in a group can choose different lengths, list each person's session separately, with the total time and price underneath.
- Prices come from the existing pricing source in the database, never hard-coded in React.
- Summary before payment: one bold plain sentence, such as "One 2-hour massage for 1 person – £170". Under it, a small "Change number of people" link that goes back to the people step without losing the details already entered.
- Repeat the same sentence in the confirmation screen, the confirmation email and the WhatsApp share message, all produced by the same formatter.
- Store the number of people on the booking (if it isn't already clear from the sessions) and show it on the admin booking card, e.g. "1 person · 120 min" or "3 people · 3 × 60 min".
- No change to pricing rules, availability or booking behaviour. The Stage 0 suites must pass unchanged.

## Change 3 – Admin: Income screen (week / month / year)

- **Income is money actually received.**
  - Counts: bank transfers verified as paid, cash marked as received (not just approved), and late-cancellation fees actually paid, minus refunds recorded as sent.
  - Doesn't count: unpaid bookings, bookings awaiting payment, and cash approved but not yet received.
- **Each amount belongs to the period of the appointment date** (Europe/London), not the date the money arrived. A cancelled booking's kept money counts in its original appointment's period. Future periods are labelled as upcoming.
- **The screen:**
  - **Navigation:** under More, with tabs Week / Month / Year and arrows to move between periods. Weeks run Monday to Sunday.
  - **Figures:** the total; a comparison with the previous period ("—" when the previous period was £0); bank transfer vs cash; the number of sessions; and the average per booking.
  - **Chart and list:** a bar chart of the sub-periods, and the list of bookings behind the total.
  - **Export:** "Download for accountant" as a CSV (date, booking reference, client name, method, amount received, refund, net).
- **Rules:**
  - Everything is calculated in the database through read-only, admin-only functions, and React only displays the result.
  - The existing payment and refund records are the source.
  - Before building, check whether "cash received" and "refund sent" can be recorded.
  - Admin only, with grant-matrix tests.
  - pgTAP tests for each money rule, the London-time period boundaries (including 25 Oct 2026), and weeks running Monday–Sunday.
  - No change to booking or payment behaviour.

## Change 4 – Income screen additions

- **4.1 Tax year view:** the Year tab gets a Calendar year / Tax year switch (6 April – 5 April, "Tax year 2026/27"). The CSV follows the selected year type. Tests: 5 and 6 April fall in different tax years.
- **4.2 "Money owed to you":** a list and a count badge of appointments that have happened with no money received:
  - transfers not received;
  - cash not marked received;
  - late fees unpaid.

  Each shows what is missing and opens the booking. Cancelled bookings with nothing due, and fully refunded bookings, are left out. It uses the same database source.
- **4.3 "Still to come":** under the total, the money expected for the rest of the selected period, kept separate from income and never shown for past periods. Tests: an unpaid future booking counts here and not in income; once paid, it moves to income.

## Change 5 – Later ideas (opinion only)

- Income per working hour, including travel (income ÷ (treatment time + travel buffer)), overall and per area.
- Expenses and profit: "add expense" (date, category, amount, note or receipt photo). Income − expenses = profit, and the CSV includes expenses.

## Answers and order (2026-10-20)

**Checked against the live database and the code:**
- Prices are 60 min £90, 90 min £125, 2 hours £170; a group is the sum of its sessions.
- At most 4 people and 240 minutes, fixed in code. People in a group can have different lengths.
- "Mark payment received" (cash) and "Record refund sent" exist. The refund stores neither its amount nor its date.
- A prepaid no-show gets a full fee "due" on top of the payment.
- The late-cancellation charge is the whole booking price.

**Vadim's choices:**
- **Change 1:** "Free to cancel or move until …. After that, the full price may be charged."
- **Change 2:**
  - mixed lengths are allowed (the same length for everyone by default);
  - options show the full total for the client's area;
  - emails change too.
- **Change 3:** "number of sessions" counts bookings; there is a "Cash received" button on the card after the appointment.
- **Change 4.3:** "still to come" includes bookings still waiting for payment.
- **Going live:** pull requests only. Vadim tests before anything goes live.

**Order:**
1. Change 1, in pull request 61.
2. Money groundwork: refund amount and date, the no-show fix, and the Cash received button.
3. Income and tax year.
4. Money owed and still to come.
5. Change 2: the people step, then one sentence everywhere.
6. Google Calendar, once Google is set up.
