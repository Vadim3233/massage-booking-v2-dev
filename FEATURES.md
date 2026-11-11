# VadMassage booking app: feature catalogue

Last updated: 11 November 2026 (up to the client's first name in the share message).

This is a plain-English list of everything the app does today, grouped by area. Each entry says what the feature does, why it was built, where it was built (the pull request, or "PR", and any database change, called a "migration"), and what would need to become a **setting** if the same feature were offered to other therapists in a general app.

## How to use this from another project

Vadim is building a separate, general app for therapists. This file is the menu of features that can be carried over.

1. **Pick features by name.** In the other project, tell Claude something like: "Read FEATURES.md in the massage-booking-v2-dev repository and build *Confirm now, pay later* and *Edit hours* for my therapist app." The entry names below are meant to be quoted like that.
2. **Read the "For a general app" line first.** It lists what is specific to Vadim's business (his name, London, his prices, his rules) and should become an option each therapist sets, rather than being copied as it is.
3. **Go deeper when building.** Each entry points to its PR number(s) and migration file(s) in this repository. Many also name an ADR number: that is the matching entry in `docs/DECISIONS.md`, which has the full reasoning, the edge cases and what was found in review.
4. **Copy the idea, not the wording.** Client-facing text here is in Vadim's voice ("Warm wishes, Vadim"). A general app should let each therapist write their own.

Where the files are in this repository: screens in `src/client` (clients) and `src/admin` (Vadim's side), database changes in `supabase/migrations`, background jobs and the AI connector in `api` and `server`.

**Keeping this file current (standing rule):** whenever a feature ships, its entry here is added or updated in the same PR.

## What is specific to Vadim's business (at a glance)

These are the things that are written for Vadim today. In a general therapist app each should be a setting, with Vadim's choice as one example.

| Today, for Vadim | Make it a setting for |
| --- | --- |
| Mobile therapist: he travels to the client's home or hotel, with travel time between visits | Visit type: mobile only, own premises (clinic) only, or both |
| London areas with travel fees, the London congestion charge, UK postcodes | Service areas (or none), travel fee and extra charges per area, the postcode format of the country |
| British pounds, UK bank transfer (sort code and account number), UK tax year (6 April) | Currency, payment methods and their details, the tax year start |
| Bank transfer and cash only, no card payments | Which payment methods are offered (a card provider could be added) |
| Session lengths of 60, 90 and 120 minutes, with his prices | Treatments, lengths and prices (already editable in the app) |
| 60 minutes of travel allowed around each visit | Travel buffer (or none for a clinic) |
| Free changes up to 24 hours before, and for 1 hour after booking; full price as late fee | Cancellation window, grace period and the late fee amount or percentage (most are already settings) |
| New client: 1 booking at a time; returning: 5; 40 days ahead; 2 hours' notice | Booking limits (already settings) |
| London time for every date and time | Time zone |
| Morning-of reminder email from 08:00 | Reminder timing (morning of, day before, hours before) |
| Receipts with his ISRM membership (Level 5 Soft Tissue Therapist, no. 9555), numbered VAD-YYYY-NNNN, no VAT | Professional body and membership number, receipt prefix, VAT on or off |
| "Warm wishes, Vadim" on every client message, and Vadim's photo and words on the booking page | Therapist name, sign-off, photo, welcome text, brand colours |
| One therapist, one diary | One or several therapists (not built here) |
| Telegram for his own alerts and as an option for clients | Which alert channels are offered (Telegram, email, WhatsApp, SMS) |

---

## 1. Client booking

### Online booking flow
- **What it does:** A client books from a phone in a few steps: choose the area, the treatment, how many people and how long, a day and time, their details and address, then how to pay. The price follows their choices on the screen and is worked out by the database, never by the phone. Back on the phone returns through the steps without losing anything typed.
- **Why:** The core of the business: clients book themselves without messaging Vadim.
- **Built in:** the foundation work before numbered PRs (migrations `20260923…` to `20260930…`: catalogue, scheduling, bookings and holds, quotes and finalising), then PR #8 and the design overhaul PR #11 (ADR-014, ADR-017, ADR-032).
- **For a general app:** the steps (area first suits a mobile therapist; a clinic would skip it), treatments, lengths and extras.

### A time is held while the client finishes
- **What it does:** Once a client picks a time it is held for them for a few minutes while they type their details, so nobody else can take it. Looking at other days never lets go of it.
- **Why:** Two people must never book the same time.
- **Built in:** foundation migrations `20260924104500_create_booking_hold_rpc.sql`, `20260928180000_booking_hold_extension.sql`; PR #92 (`20261120100000_own_hold_never_blocks.sql`) made sure a client's own held time never blocks them.
- **For a general app:** how long a hold lasts.

### How times are offered (Chain and Flexible days)
- **What it does:** Times are worked out from working hours, existing bookings, blocked time and the travel time around each visit. A **Chain** day offers only the time just before the first booking or just after the last, so the day stays one tidy run. A **Flexible** day offers every half hour that leaves room for travel. An empty day can offer only a set first appointment ("At a set time") or any time in the hours.
- **Why:** A mobile therapist loses money on gaps; Chain keeps the day compact.
- **Built in:** foundation (`20260924071000_booking_availability_rpc.sql`, `20260928190000_owner_aware_availability.sql`, `20260930120000_weekday_start_1430.sql`), PR #29 (`20261031100000_schedule_mode.sql`, ADR-046). See `docs/HOW_TIMES_ARE_OFFERED.md`.
- **For a general app:** Chain or Flexible per day, the travel buffer, the half-hour step.

### First appointment released the day before
- **What it does:** A day that offers only a set first appointment can open up to any time in the hours if nobody has booked it by a chosen time the day before (for example 17:00).
- **Why:** Keeps the preferred start while not wasting a day nobody booked.
- **Built in:** PR #28, `20261030100000_anchor_release.sql` (ADR-045).
- **For a general app:** release time, or never.

### How many people (couples and groups)
- **What it does:** The booking asks "How many people?" first, then each person's length. One plain sentence says who, how long and the price (for example "2 people · 60 min each · £180"). Each person is a separate session, so two 60-minute sessions are never treated as one 120-minute one.
- **Why:** Couples book together, and the old app got the times and prices wrong.
- **Built in:** PR #68, PR #69 (Admin card), PR #70 (emails, `20261110100000_people_sentence_emails.sql`) (ADR-014, ADR-072 to 074). PR #92 makes the people step always ask again.
- **For a general app:** maximum people per visit; whether extra people are allowed at all.

### Extras
- **What it does:** Optional add-ons chosen during booking, priced on top, shown on the booking card.
- **Why:** Upsells such as longer focus or products.
- **Built in:** foundation (`20260923183500_payments_preferences_enhancements.sql`), editable in PR #8 (ADR-026); shown on calendar cards in PR #75.
- **For a general app:** the list of extras and their prices (already editable).

### Session preferences
- **What it does:** Optional notes on pressure, focus areas and similar, tucked behind one optional section on the review screen.
- **Why:** Lets Vadim prepare, without making the booking longer for clients who don't care.
- **Built in:** foundation (`20260928123500_refine_session_preferences.sql`), PR #11.
- **For a general app:** which preference questions to ask.

### Book as a guest, or sign in
- **What it does:** "Continue as guest" is the quick way on. Signing in and creating an account are plain buttons beside it and at the top of every booking page. A guest can change their mind and sign in before paying without losing their choices.
- **Why:** Many clients won't make an account; returning clients want their details remembered.
- **Built in:** foundation (`20260928151000_guest_checkout_identity.sql`, `20260927110000_activate_client_account.sql`), PR #20, PR #22 (ADR-038, ADR-040).
- **For a general app:** whether guests are allowed.

### Sign-up with a 6-digit code
- **What it does:** A new account is confirmed by typing a 6-digit code from an email, on the same page, instead of leaving to click a link.
- **Why:** Clients got lost leaving the booking to click an email link.
- **Built in:** PR #94 (no migration). See `docs/EMAIL_CODE_SIGNUP.md`.
- **For a general app:** nothing specific.

### Returning clients: details and address filled in
- **What it does:** A signed-in client's usual address is already chosen, and their name and phone are locked until they press "Edit my details". A regular is offered their usual booking.
- **Why:** Fewer taps for loyal clients, and no accidental changes.
- **Built in:** PR #23, PR #25, PR #11 (ADR-041, ADR-042).
- **For a general app:** nothing specific.

### One address box, and a required postcode
- **What it does:** The address is one box that a whole address can be pasted into, with entry instructions and a label (for example "Home" or "Hotel") as small extra boxes. A separate Postcode box is required.
- **Why:** Four boxes were fiddly; the postcode decides the area and its fees.
- **Built in:** PR #54 (`20261104100000_single_address.sql`, ADR-059), PR #88 (postcode box, no migration), PR #77 (label hint "Home or Hotel").
- **For a general app:** address format of the country; a clinic needs no client address.

### Postcode check against areas
- **What it does:** Each area can list the postcodes it covers. A postcode in another area asks the client to choose that area (so the fees are right). A postcode in no area still books, but marks it for Vadim to confirm and tells the client not to pay yet.
- **Why:** Clients chose a cheap area and typed an address elsewhere.
- **Built in:** PR #87, `20261118100000_area_postcodes.sql` (ADR-082).
- **For a general app:** postcode format, and whether out-of-area is a request or a refusal (Vadim chose request).

### Minimum booking length per area
- **What it does:** An area can require a minimum total time at the address (for example 90 minutes for a far area). Shorter lengths are greyed out for clients. Couples' times add up. A per-client switch "No minimum booking" exempts a client. The Admin is never blocked, only shown a note.
- **Why:** Far trips are not worth a short session.
- **Built in:** PR #101, `20261124100000_area_minimum_booking.sql`.
- **For a general app:** minimum per area (already a setting); the offered values (90/120/180).

### Faded "wanted" times and "let me know" (replaces the old waitlist)
- **What it does:** Times that are not available are shown faded within working hours (plus up to 2 evening hours). Tapping one says "<time> on <day> isn't available, but in case anything changes, I can let you know", with one button. Vadim sees these in Waitlist and Visitors, and a cancellation alert names who wanted that time. Nothing is ever booked or messaged automatically.
- **Why:** The old five-field waitlist only appeared when a whole day was full, so almost nobody used it.
- **Built in:** first waitlist in PR #8 (`20261018100000_waitlist.sql`, ADR-028); replaced in PR #105 (`20261130100000_visitors_and_wanted_times.sql`, ADR-095).
- **For a general app:** how many evening hours to show faded (already a setting, 0 to 2), the wording.

### Booking several sessions, paying one at a time
- **What it does:** A returning client can book several sessions ahead but pays only for the next one. A later session's payment step says "Nothing to pay yet". It is confirmed by itself (a switch in Booking rules), and after the earlier session the client is sent the amount and bank details for the next. "Book another session" appears after booking and in Your bookings.
- **Why:** A client asked whether she had to pay for all her sessions at once.
- **Built in:** PR #111, `20261202100000_pay_one_session_at_a_time.sql` (ADR-097).
- **For a general app:** pay for each session separately, or all up front; automatic confirmation on or off.

### Links that open the booking part-way
- **What it does:** Links such as `/?area=chelsea&treatment=massage&minutes=60` open the booking with those choices made. More › Your booking link gives Vadim his own link to share.
- **Why:** Vadim sends clients straight to the right place from WhatsApp or social media.
- **Built in:** PR #11 (deep links, ADR-032).
- **For a general app:** the therapist's own link.

### Welcome text and "Choose your area" arrow
- **What it does:** The first booking screen shows Vadim's photo, a short welcome and an about text he edits himself, a trust strip, and a bouncing "Choose your area" pill that scrolls down to the areas on a phone.
- **Why:** A warm, personal first impression; on phones the areas were hidden below the welcome.
- **Built in:** PR #8 (`20261021100000_welcome_content.sql`), design refresh PR #106, arrow PR #112 (no migration).
- **For a general app:** photo, welcome text and about text (already editable), brand colours.

### Where the emails come from
- **What it does:** Booking pages say which address emails come from and to look in spam if one doesn't arrive.
- **Why:** Clients missed confirmation emails.
- **Built in:** PR #48.
- **For a general app:** the sending address.

---

## 2. Client account and self-service

### Your bookings (/account)
- **What it does:** A client sees their bookings and can cancel or move them without messaging Vadim. Inside the free-change window they must tick that they understand the exact late fee first. Each booking has one line saying where its money stands ("£90.00 · Paid", "Refund of £90.00 on its way", "Late fee of £90.00 due").
- **Why:** Routine changes shouldn't need a message, and the fee rule is applied the same way every time.
- **Built in:** PR #8 (`20261012100000_client_self_service.sql`, ADR-022), PR #44 (money line, ADR-052), PR #45 (cancelled date, ADR-053).
- **For a general app:** cancellation rules (already settings).

### Change who's coming, treatment or length (clients)
- **What it does:** From their booking page (signed in or from the email link) a client can add or remove a person, change a treatment, a name or a length, and choose a time that suits the new length. Only the usual chain-mode times are offered, worked out as if their own booking weren't there, and the current time stays chosen if it still fits. The new price and what it means for their money show before they save. They can't go below the area minimum, or change once the appointment has started. Vadim gets an alert for every change.
- **Why:** A couple where one person can't come shouldn't need a message to Vadim.
- **Built in:** this PR (`20261204100000_edit_booking_services.sql`, `src/client/account/ChangePanel.jsx`).
- **For a general app:** the free-cancellation window (already a setting).

### Open a booking from the email, with no sign-in
- **What it does:** The "See or change your booking" link in every email carries a private code that opens that one booking on any phone, for cancelling or moving it, without signing in.
- **Why:** Guests and clients Vadim added himself have no login.
- **Built in:** PR #18, `20261026100000_booking_access_link.sql` (ADR-037).
- **For a general app:** nothing specific.

### Add to calendar
- **What it does:** A confirmed appointment can be added to the client's own phone calendar.
- **Why:** Fewer missed appointments.
- **Built in:** PR #11.
- **For a general app:** nothing specific.

### Forgotten password page
- **What it does:** The reset link opens its own page to choose a new password, and offers to send a new link if the old one ran out.
- **Why:** The reset link used to land on the booking page, which confused people.
- **Built in:** PR #42 (ADR-051).
- **For a general app:** nothing specific.

### Receipts on the booking page
- **What it does:** A client downloads their PDF receipt from their booking page (see Receipts below).
- **Built in:** PR #85.

### Client FAQ (/faq)
- **What it does:** A page of plain answers for clients (booking, paying, changing, receipts). Numbers such as the cancellation window are read live from the settings, so they never go out of date. Linked from the welcome, the payment step and the account page.
- **Why:** Vadim wanted "everything possible explained".
- **Built in:** PR #109 (no migration, ADR-096). Content in `src/client/faq/faqContent.js`.
- **For a general app:** each therapist's own policy answers (refunds, missed appointments, what to prepare at home).

---

## 3. Payments and money

### Bank transfer or cash, chosen at the top of the payment step
- **What it does:** The payment step asks "How would you like to pay?" with two tiles. Bank transfer shows the bank details and a reference, and the client presses "I've made the bank transfer". Cash means paying at the appointment. A transfer is never marked paid just because the client says so; Vadim checks and confirms.
- **Why:** Vadim takes no card payments; a client missed the cash option when it was a small link.
- **Built in:** foundation and PR #8 (`20260929100000_provisional_payment_reservations.sql`, `20261007120000_admin_payment_review.sql`, `20261010100000_pending_until_admin_decides.sql`, ADR-005, ADR-015, ADR-019), PR #43, PR #96 (no migration).
- **For a general app:** payment methods offered, bank details format, whether cash needs approval.

### Bookings wait for Vadim, never for a timer
- **What it does:** A booking waiting for payment keeps its time until Vadim confirms it or removes it. Nothing is cancelled automatically.
- **Why:** The business runs on loyalty; a client paying late must not lose their time.
- **Built in:** PR #8, `20261010100000_pending_until_admin_decides.sql` (ADR-019).
- **For a general app:** automatic expiry on or off (Vadim: off).

### Confirm now, pay later
- **What it does:** A bank-transfer booking can be confirmed while the money is still to come. Cards show two pills, one for the booking and one for the payment, and "Mark paid" is pressed later. The client gets an email (and Telegram if on).
- **Why:** Some clients book and pay later; there was no way to say "the appointment is on, the money is still to come".
- **Built in:** PR #83, `20261116100000_confirm_pay_later.sql` (ADR-081).
- **For a general app:** nothing specific.

### "Not yet": put off a payment you can't check yet
- **What it does:** A payment waiting for Vadim has a "Not yet" button that hides it until a chosen time (in 3 hours, tomorrow 09:00, or the day before the appointment). Nothing changes for the client.
- **Why:** Keeps the To check list clear when the bank hasn't shown the money yet.
- **Built in:** PR #35 (ADR-048).
- **For a general app:** the reminder choices.

### Change how a confirmed booking is paid
- **What it does:** "Change to cash" or "Change to bank transfer" on a confirmed booking. A paid booking stays paid, the receipt is corrected, and the client is not notified.
- **Why:** Clients pick the wrong method or pay at the door.
- **Built in:** PR #110, `20261201100000_switch_payment_method.sql`.
- **For a general app:** nothing specific.

### Payment reminders by WhatsApp
- **What it does:** Vadim can send a friendly payment reminder as WhatsApp text (or copy it). When a client owes for several sessions, one reminder lists each with date, time, length and amount. Available on the To check cards, the booking page and the client's page.
- **Why:** Clients who pay later sometimes forget; naming each session lets them check their bank.
- **Built in:** PR #79, PR #99 (no migrations).
- **For a general app:** the reminder wording.

### Late fees and refunds
- **What it does:** Cancelling or moving more than 24 hours ahead, or within an hour of booking, is free. Inside 24 hours it is still allowed, but the full price is recorded as a late fee due, which Vadim can lower or waive. A no-show records the full price unless he chooses less. Before cancelling, a box says exactly what happens to the money ("you keep £45.00, refund £45.00"). A refund is recorded from the card once sent, keeping its amount and date. Money moves outside the app.
- **Why:** Clear, consistent rules, while loyal clients can be treated kindly.
- **Built in:** PR #8 (`20261011100000_booking_lifecycle.sql`, `20261009110000_keep_paid_at_on_refund.sql`, ADR-021), PR #57 (ADR-062), PR #65 (`20261108100000_money_groundwork.sql`, ADR-070), PR #50 (wording).
- **For a general app:** free window (hours), grace after booking, late fee as full price or a percentage, no-show fee.

### Cash received from the card
- **What it does:** A cash booking can be marked "Cash received" straight from its calendar card.
- **Why:** Fewer taps after a session.
- **Built in:** PR #65, `20261108100000_money_groundwork.sql` (ADR-070).

### Unpaid sessions after the appointment show in To check
- **What it does:** To check also lists confirmed bookings whose session has finished but whose transfer or cash hasn't been recorded.
- **Why:** Pay-later bookings used to vanish from view once confirmed.
- **Built in:** PR #97, `20261121100000_overdue_payments_to_check.sql`.

### Receipts (PDF, for insurance claims)
- **What it does:** A receipt is made automatically when a booking is marked paid, numbered without gaps (VAD-2026-0001…). It is an A4 PDF with the practitioner's credentials, one line per treatment, extra, travel and congestion charge, how and when it was paid. Business details are set in More › Receipt details. A refunded or cancelled booking keeps its receipt, stamped REFUNDED or VOID. Vadim can correct the words but never the amounts. It can be emailed, sent on WhatsApp or downloaded by the client.
- **Why:** Clients asked for receipts, then needed more detail for insurance claims.
- **Built in:** PR #13 (`20261023100000_booking_receipts.sql`, ADR-034), PR #85 (`20261117100000_receipt_pdf.sql`).
- **For a general app:** professional body, membership number and title; receipt number prefix; VAT registration; business address.

### Income
- **What it does:** More › Income shows money received by week, month, year or UK tax year, money owed and still to come, with a CSV download. The month is a calendar shaded by income, and "Your hour" shows what each working hour earned, counting travel time, by area and by month.
- **Why:** Vadim wanted to see what he earns, and what his time is really worth once travel is counted.
- **Built in:** PR #66 (`20261109100000_income.sql`, ADR-071), PR #104 (`20261129100000_income_calendar_hourly.sql`, ADR-094).
- **For a general app:** tax year start, currency; travel counting only for mobile therapists.

### No travel fee for a chosen client
- **What it does:** A switch on a client's page (Prices section) removes the travel fee from their new bookings. The congestion charge still applies.
- **Why:** Vadim wanted to treat certain regulars kindly.
- **Built in:** PR #91, `20261122100000_no_travel_fee.sql`.
- **For a general app:** nothing specific (only relevant with travel fees).

---

## 4. Messages and notifications

### Alerts to Vadim (in the app, Telegram and email)
- **What it does:** New online bookings, "I've paid", cash requests, cancellations and moves by clients reach Vadim in the app, on Telegram and by email, each with a link to the exact booking. His own actions never alert him. Failed sends are retried. An alert stops saying "New" once opened.
- **Why:** He must know at once when a client does something.
- **Built in:** PR #8, `20261013100000_notifications.sql` (ADR-023), PR #34. Setup in `docs/NOTIFICATIONS_SETUP.md`.
- **For a general app:** which channels, the therapist's own Telegram or email.

### Emails to clients
- **What it does:** Clients are emailed when a booking is confirmed, moved, cancelled or refunded, in both plain text and a branded version that matches the booking pages, with a button to see or change the booking. Every email says who, how long and the price in the same sentence as the screens.
- **Why:** Clear, trustworthy messages that look like the business.
- **Built in:** PR #8, PR #49 (ADR-055), PR #70 (ADR-074).
- **For a general app:** brand name, colours, sending address.

### Morning reminder
- **What it does:** On the morning of a confirmed appointment (from 08:00, at least an hour before) the client gets one reminder email with the time and address.
- **Why:** Fewer missed appointments.
- **Built in:** PR #27, `20261029100000_day_of_reminders.sql` (ADR-044).
- **For a general app:** when to remind (Vadim chose the morning of the day only), the wording.

### Client updates on Telegram
- **What it does:** A client can press "Get updates on Telegram" and from then on gets every booking message there too, from a bot just for clients. /stop turns it off. Vadim can also send a client a one-time Telegram link from their page.
- **Why:** Many clients prefer messages to email.
- **Built in:** PR #36 (`20261028100000_client_telegram.sql`, ADR-049), PR #47, PR #78 (`20261113100000_admin_telegram_link.sql`, ADR-078).
- **For a general app:** the therapist's own bot.

### Family alerts on Telegram (for Vadim's wife)
- **What it does:** Vadim's wife gets a short Telegram message when a booking is confirmed, moved or cancelled: the day, the times and when he will likely be home that day (end of the day's last booking plus its travel time). Unconfirmed requests and past bookings say nothing. The messages are in Spanish, with emojis, and each ends with one of 100 funny love lines (Vadim's own nine, plus ones he approved, 20 of them Andalusian for Seville and Olivares), in a mixed order: every line once before any repeats. They never include the client's name, address, phone or price. She connects from a one-time link Vadim makes in More › Family alerts and sends her on WhatsApp; she presses Start in Telegram. /stop in the chat, or Switch off on the page, ends it. More than one person can be connected.
- **Why:** She wants to know when he is working and when he will be home, without seeing clients' private details.
- **Built in:** PR #118 (`20261206100000_family_telegram_alerts.sql`). Uses the clients' Telegram bot, so nothing new to set up. Server: `server/familyAlerts.js` (sent by the every-minute sender), `server/telegramWebhook.js` (family links start with `family_`). Page: `src/admin/SettingsFamilyAlerts.jsx`.
- **For a general app:** the language, the love lines (the `family_love_lines` table), how much detail to show, and who the alerts are for (partner, assistant, receptionist).

### Sign-off "Warm wishes, Vadim"
- **What it does:** Every client message ends "Warm wishes, Vadim".
- **Why:** Vadim's chosen voice, with his full name.
- **Built in:** PR #103, `20261125100000_sign_off_vadim.sql`.
- **For a general app:** the therapist's name and sign-off.

### Share a booking on WhatsApp
- **What it does:** A share button on a booking sends its details to the client's WhatsApp chat (or the phone's share sheet, or Copy). It never includes private notes or internal details. The wording can be changed in More › Share message, with fixed blanks such as {date} and {address}, and says until when the client can cancel for free.
- **Why:** Vadim talks to most clients on WhatsApp.
- **Built in:** PR #58 (ADR-063), PR #61 (`20261106100000_share_message.sql`, ADR-066), PR #67 (`20261106110000_cancellation_terms.sql`), PR #76 (warmer standard wording, no bank details).
- **For a general app:** the wording (already editable), the messaging app used.

### Add-to-calendar link in the share message
- **What it does:** The share message has an "Add it to your calendar: <link>" line (the `{calendar}` blank). The link opens a small page on the booking site showing the date, time and address, with two buttons: **Add to iPhone, Outlook or other calendar** (a calendar file) and **Add to Google Calendar**. The page is read fresh each time, so a moved booking gives the new time and a cancelled one says it was cancelled. The link uses the booking's long random id, so nobody can guess another client's link.
- **Why:** Clients get the message on WhatsApp and want the appointment in their phone's calendar with one tap.
- **Built in:** PR #115 (`20261203100000_share_message_calendar.sql`, only needed for using `{calendar}` in custom wording; the standard message works without it). Server: `api/calendar.js`, `server/calendarLink.js`, short address `/calendar/<id>` in `vercel.json`.
- **For a general app:** the event title ("Massage with Vadim"), the time zone (London), the site address.

### Client's first name in the share message
- **What it does:** The share message greets the client by first name: "Hi Sarah! Thank you so much for booking with me...". If no first name is saved it says "Hi! Thank you...", never "Hi !". Custom wording (More › Share message) can put the `{name}` blank anywhere.
- **Why:** A personal greeting feels warmer than a plain "Hi!".
- **Built in:** PR #117 (`20261205100000_share_message_name.sql`, only needed for using `{name}` in custom wording; the standard message works without it).
- **For a general app:** nothing Vadim-specific; first name only (not the full name), by choice.

---

## 5. Admin: calendar and schedule

### Agenda and Day view
- **What it does:** The Agenda lists the days ahead with their bookings; the Day view shows one day with bookings, travel and free time. Every day shows its working hours. Blocked time and special days are shown. Switches show every day, or cancelled bookings. "Earlier appointments" loads past days without jumping, and pressing Calendar returns to today. A "Needs you" box shows what waits for Vadim.
- **Why:** The diary is the screen Vadim uses most, on his phone.
- **Built in:** PR #8, PR #26 (ADR-043), PR #33, PR #35, PR #41 (ADR-050), PR #56 (`20261105100000_day_hours.sql`, ADR-061), PR #98.
- **For a general app:** nothing specific.

### Booking colours
- **What it does:** Booking boxes are sage when settled and sand while waiting on money or on Vadim, the same everywhere; words always carry the meaning too.
- **Why:** See at a glance what needs attention.
- **Built in:** PR #55 (ADR-060).
- **For a general app:** colours follow the brand.

### Working hours, special days and blocked time
- **What it does:** Vadim sets his usual week, special days (a day off or different hours for one date, starting from the usual week) and blocked time over any range of dates and hours (a holiday, "Friday 14:00 to Monday 09:00"). Before saving he is warned which bookings would clash, by name; nothing is moved automatically.
- **Why:** He changes his hours himself, without the database.
- **Built in:** PR #8 (`20261014100000_schedule_control.sql`, `20261019200000_block_ranges.sql`, ADR-024, ADR-031), PR #9, PR #21 (ADR-039), PR #32.
- **For a general app:** nothing specific.

### Day settings for one date
- **What it does:** Every day has a Day settings page: hours, Chain or Flexible, first appointment and its release, blocked time, all for that one date. Saving goes back to where it was opened.
- **Why:** Change one day without touching the usual week.
- **Built in:** PR #30 (ADR-047), PR #73 (ADR-077).

### Edit hours: tap half-hours on or off
- **What it does:** "Edit hours" in the Day view shows the day as half-hour blocks: mint is working, empty is off. Tap one, or hold and slide to change several. A Day off switch closes the day. Booked times and travel are locked. Save shows only while editing. On a phone, a swipe scrolls.
- **Why:** The fastest way to open or close parts of a day on a phone.
- **Built in:** PR #81 (`20261115100000_day_grid.sql`, ADR-080), PR #82, PR #86.
- **For a general app:** the block size (half hour).

### Google Calendar copy
- **What it does:** Vadim's bookings are copied to a "VadMassage bookings" Google Calendar, with travel as events and each booking's address as its location (works offline, with directions). Titles never include private details. Connected from More › Google Calendar.
- **Why:** He wanted his bookings beside his personal calendar.
- **Built in:** PR #64 (`20261107100000_calendar_sync.sql`, ADR-067 to 069), PR #72 (`20261112100000_calendar_address.sql`, ADR-076). Setup in `docs/GOOGLE_CALENDAR_SETUP.md`.
- **For a general app:** calendar name; which details go into events.

---

## 6. Admin: bookings

### New booking (by Vadim)
- **What it does:** One numbered page: client, treatment, length, area, time and payment. The client's usual choices fill in (even the area of a client whose bookings were all cancelled). The client's name opens their page and the booking waits. It says exactly which detail is missing.
- **Why:** Vadim books many clients himself from WhatsApp messages.
- **Built in:** PR #8 (`20261008120000_admin_new_booking.sql`), PR #10, PR #59 (ADR-064), PR #60 (ADR-065), PR #93.
- **For a general app:** nothing specific.

### Show all times (any time, never a double booking)
- **What it does:** Under the usual times, "Show all times" lists every half hour of the day. Choosing an unusual one says what is being set aside (a shorter gap, outside hours, a day off, blocked time). A time that overlaps another booking can never be chosen. Works for new bookings and for moving one.
- **Why:** Vadim knows more than the rules (neighbours, a longer day), but a double booking must never happen.
- **Built in:** PR #14 and #15 (`20261024100000_admin_any_time.sql`, ADR-035), PR #80 (`20261114100000_admin_reschedule_any_time.sql`, ADR-079).

### Record an appointment that already happened
- **What it does:** "It has already happened" lets Vadim enter a past appointment (up to a year back), paid or not, by bank or cash.
- **Why:** To bring in sessions from before the app, or ones he forgot to enter.
- **Built in:** PR #52, `20261027100000_admin_past_bookings.sql` (ADR-057).

### Confirm, cancel, move, complete, no-show
- **What it does:** Every change goes through one safe action that records who did what and when; repeated taps never do it twice. Status and payment are separate, and each step is guarded so impossible changes can't happen.
- **Why:** Money and appointments must always be right and traceable.
- **Built in:** PR #8 (`20261009100000_booking_status_guard_and_audit.sql`, `20261011100000_booking_lifecycle.sql`, `20261019100000_cancel_reason_optional.sql`, ADR-018, ADR-021).

### Edit booking: people, treatments, lengths and time in one step
- **What it does:** "Edit booking" changes who is coming (1 to 4 people), each person's name, treatment and length, and the date and time, in one step, with the new price and money outcome shown before saving. Unchanged people keep their booked price; changes use today's prices; travel and extras stay. Outside the free-cancellation window the price follows the change both ways; inside it the price never goes below what was booked unless "Lower the price anyway" is ticked. Paid and cheaper: "Refund to send" until Record refund sent. Paid and dearer: "£X still to pay" until "Mark extra received". A refund already sent is never undone, and the receipt is corrected. The client gets an email and Telegram message unless unticked.
- **Why:** A booking for two where one person can't come had to be cancelled and rebooked.
- **Built in:** this PR (`20261204100000_edit_booking_services.sql`, `src/admin/EditBooking.jsx`, rules in the Claude Doc "Changing a booking: the rules").
- **For a general app:** nothing specific.

### Edit address on a booking
- **What it does:** Vadim can change the address of a booking still to come. A different area brings its fees and a new total, which is refused once money has been paid or a transfer declared. The client is emailed.
- **Why:** Clients move between home and hotel, or typed the wrong address.
- **Built in:** PR #87 (ADR-082).

### Repeating bookings
- **What it does:** A booking can repeat weekly, every 2 to 4 weeks (up to 12), monthly on the same weekday, or on chosen dates. The slot is kept free; a real booking is made about a week before each date, asking for payment then. Vadim can cancel some dates, or everything still to come.
- **Why:** Regulars book the same slot; a year of real unpaid bookings would clutter the diary.
- **Built in:** PR #8 (`20261020100000_repeating_bookings.sql`, `20261020200000_series_settings.sql`, ADR-030), PR #53 (`20261103100000_repeat_patterns.sql`, ADR-058).
- **For a general app:** how many days before each date the booking is made (already a setting, 7). Not built: clients setting up repeats themselves.

### To check
- **What it does:** One list of everything waiting for Vadim: transfers to check, cash requests, bookings outside the areas and unpaid sessions after the appointment, with Verify, Approve, Not yet and reminder buttons.
- **Why:** One place for everything that needs him.
- **Built in:** PR #8 (`20261007120000_admin_payment_review.sql`, `docs/ADMIN_PAYMENT_REVIEW.md`), PR #35, PR #97.

---

## 7. Admin: clients

### Client directory and profile
- **What it does:** Search clients; each page shows contact links (call, WhatsApp, email), a summary (visits, money paid, next and last visit, fees and refunds due), details, saved addresses, private notes, booking history, Telegram, repeats and a switch for online booking. A client needs only a first name.
- **Why:** Look someone up, see what they owe, correct details without the database.
- **Built in:** PR #8 (`20261015100000_admin_clients.sql`, ADR-025), PR #51 (`20261101100000_client_name_only.sql`, ADR-056).
- **For a general app:** nothing specific.

### Phone number checks (booking and Admin)
- **What it does:** When a client types their phone number on the booking details step, the app checks its length as they leave the box: a UK mobile has 11 digits starting 07 (other UK numbers 10 or 11), and a number from another country starts with + (or 00) and its country code. If it looks wrong, a gentle note says what (for example "one digit too many") and asks them to double-check, but **never stops the booking**: Vadim corrects the number later if needed. Only something that cannot be a phone number at all (fewer than 7 or more than 20 digits) stops the step, as before. A short hint sits under the box. In the Admin's own client forms the same check must pass before saving. A client page whose saved number looks wrong says so in red and points to Edit details.
- **Why:** A client registered with one extra digit, so Vadim could not reach him. Vadim did not want a new obstacle in the booking journey.
- **Built in:** PR #114 (no database change; the database still accepts 7 to 20 digits).
- **For a general app:** the home country (UK, 11 digits) should be a setting.

### Same person? Combine two profiles
- **What it does:** Profiles sharing an email or phone are listed as "Might be the same person". Vadim compares them side by side and combines them, or says they are different people (remembered). Nothing is ever combined by itself.
- **Why:** A guest who later signs up, or a client entered twice.
- **Built in:** PR #12, `20261022100000_same_person_clients.sql` (ADR-033).

### Delete a client with no bookings
- **What it does:** A client with no bookings can be deleted after a clear question. A client with bookings cannot (their money records stay); online booking can be switched off instead.
- **Why:** Clear test and duplicate profiles without losing records.
- **Built in:** PR #16, `20261025100000_admin_delete_client.sql` (ADR-036).

### Per-client price switches
- **What it does:** A Prices section on a client's page with "No travel fee" and "No minimum booking". They apply to new bookings only.
- **Why:** Kindness to regulars.
- **Built in:** PR #91, PR #101 (see sections 1 and 3).

---

## 8. Settings Vadim changes himself (More)

### Services, prices, extras and areas
- **What it does:** Add, change, hide and reorder treatments (with their lengths and prices), extras, and areas (travel fee, congestion charge, postcodes, minimum booking). New prices apply to new bookings only.
- **Why:** He changes prices without a developer.
- **Built in:** PR #8 (`20261016100000_business_settings.sql`, ADR-026), PR #87, PR #101.
- **For a general app:** already settings; the "congestion charge" field is London-specific and should be a general "extra charge per area".

### Bank details
- **What it does:** Account name, bank, sort code and account number, shown only to clients who are booking.
- **Built in:** PR #8 (ADR-026).
- **For a general app:** bank details format per country.

### Booking rules
- **What it does:** Days ahead clients can book (40), hours of notice (2), free-cancellation window (24 hours), grace after booking (60 minutes), booking limits for new (1) and returning (5) clients, days before a repeat session is made (7), evening hours shown faded (0 to 2), and "Confirm later sessions automatically".
- **Why:** He wanted to change the rules himself; the screens and the FAQ read them live.
- **Built in:** PR #8 (`20261017100000_booking_rules_settings.sql`, ADR-027), PR #105, PR #111.
- **For a general app:** already settings; Vadim's numbers are the defaults.

### Welcome, share message, receipt details, booking link, Google Calendar
- **What it does:** The text clients read first, the share message wording, the details printed on receipts, his own booking link and the calendar connection.
- **Built in:** see the matching entries above.

### Admin Help (More › Help)
- **What it does:** Short "how do I…" answers for Vadim, grouped like the app.
- **Built in:** PR #109 (no migration). Content in `src/admin/helpContent.js`.

---

## 9. Insight

### Visitors
- **What it does:** More › Visitors shows how many people opened the booking page and how many booked, where people stop, the times people wanted but couldn't get, and "Worth a message": known clients who looked at times and didn't book. No cookies; visits are kept 90 days, with a privacy line in the page footer.
- **Why:** Vadim wanted to know who looked and why they didn't book.
- **Built in:** PR #105, `20261130100000_visitors_and_wanted_times.sql` (ADR-095).
- **For a general app:** how long visits are kept; privacy wording for the country.

### Income
- See section 3.

---

## 10. Booking through a client's own AI assistant

### AI assistant connector
- **What it does:** A client can add VadMassage to their own AI assistant (Claude, ChatGPT or any assistant that supports MCP), sign in with their usual account, and ask it to see free times, get a price, book (1 or 2 people), pay by transfer or cash, and see their bookings. Every action runs through the same rules as the website, and the assistant must get a clear yes before booking. A help page is at `/book-with-ai`.
- **Why:** Clients increasingly ask their AI to do things for them.
- **Built in:** PR #89, `20261119100000_ai_assistant_bookings.sql` (ADR-083). Existing clients only for now.
- **For a general app:** connector name, who may use it (existing clients only or anyone), maximum people.

---

## 11. Look and feel

### One design for clients and Admin
- **What it does:** One look throughout: ivory, slate blue and midnight navy, Playfair Display headings and Inter text, navy bands at the top of each page, colour that always comes with words, small animations under 0.4 seconds that switch off for people who ask for reduced motion. The Admin uses the same style.
- **Why:** A warm, premium first impression, and screens that feel like one product.
- **Built in:** PR #11 (ADR-029, ADR-032), PR #46 (ADR-054), PR #106 (design refresh), PR #108 (Admin in the same style).
- **For a general app:** brand colours, fonts, logo and photo.

---

## 12. Behind the scenes

### Daily backup to Vadim's PC
- **What it does:** A scheduled task copies the database to his PC every day, with a recovery guide.
- **Why:** The free Supabase plan keeps no backups.
- **Built in:** PR #37, PR #84 (scripts in `scripts/`).
- **For a general app:** a managed backup instead of a PC script.

### Site check every half hour
- **What it does:** A GitHub check confirms every half hour that the live site and database answer.
- **Built in:** PR #38 (`.github/workflows/site-check.yml`).

### Safety rules in the database
- **What it does:** Every booking and payment change is recorded in a history nobody can edit; every table states its own permissions; clients only ever see their own data.
- **Why:** Money records must be trustworthy and private.
- **Built in:** `20260923184500_command_audit_outbox.sql`, PR #8 (ADR-018), PR #71 (`20261111100000_explicit_table_grants.sql`, ADR-075). See `docs/SAFETY_NET.md`.

---

## Not built yet (ideas on record)

- Half-hour sessions for extra people in a group booking (for example 1.5 h + 30 min).
- A "next booking" alert with one-tap directions after a session ends.
- Client statistics on the Clients page.
- Clients setting up repeating bookings themselves.
- Open PRs not merged: #7 (admin audit plan), #74 (slow sign-in way out), #90 (security fixes), #95 (session needed to hold a time).
