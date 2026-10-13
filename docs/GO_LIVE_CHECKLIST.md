# Going live: what is built, what is left, and what only you can do

Updated 2026-10-09. This is written for the owner, in plain words. Nothing here has been done on the real (hosted) Supabase project or on Vercel. Everything below was built and tested on a local copy.

## New in the design overhaul (2026-10-12)

Both sides were redesigned as one product; the rules (availability, travel buffers, payments, cancellation) did not change and nothing in the database changed.

- **Booking page**: tap a length and you go straight to choosing a time; the time page opens on the first day with room and shows the days before it as full; looking at other days never lets go of a time that is held; the review is a ticket with preferences and extras tucked away and a price that updates by itself; "Continue as guest" is the plain way on and signing in waits behind "Returning client?"; a confirmed appointment can be added to a phone's calendar; a regular client is offered "Book your usual"; "Book another appointment" starts afresh.
- **Admin**: a tab bar at the bottom (a rail on a wide screen) with a number on To check and Alerts; the Agenda opens with a "Needs you" strip where Verify and Approve are one tap and one confirmation away; the next appointment is tagged Now or Next; alerts about one booking are one card; New booking is one numbered page where treatment and length are tapped; clients show their initials; more buttons say what they do ("Cancel unpaid booking").
- **Directions from the Agenda**: every appointment still to come, in the Agenda and the Day view, has a Directions button beside its status that opens the way to the address in Google Maps. Cancelled and finished appointments do not.
- **Alerts by day**: alerts sit under the day they came in (Today, Yesterday, then the date) with the day heading in sight while you scroll, and each card shows just the time.
- **To check by day**: payments to check sit under the day of their appointment (Today, Tomorrow, then the date), soonest first, and each day's heading says how much needs you that day.
- **Stays up to date**: coming back to the Admin from the bank or WhatsApp refreshes the Agenda, the Day view, To check and Alerts by itself, and nothing blanks while it does.
- **Cancelling and moving**: cancelling shows No fee, Standard fee and Full price as one tap each (anything else is typed); moving a booking uses the same day-and-time picker as booking; both keep their buttons at the bottom while the form scrolls.
- **Payment screen**: the amount, then the bank details, then the terms to tick, then what happens next, with the booking itself last. Pressing the button before the terms are ticked takes the client to the box and says why.
- **Details are checked kindly**: a phone number or postcode that cannot be right is named beside its field before a time is reserved. A quick second tap on a choice no longer picks the next treatment or length by accident. On a reserved booking there is no way back, so the payment screen offers "Change the time or cancel this booking" instead.
- **Your booking link** (More): the address of the booking page to copy or send on WhatsApp, and a link that starts part-way through for one area, treatment and length (for example `/?area=chelsea&treatment=massage&minutes=60`).
- **Home screen**: on an iPhone, open the booking page or the Admin in Safari, press Share, then Add to Home Screen. The Admin gets its own name ("Vad Admin") and icon and opens full screen.

## New: "Is this the same person?" (2026-10-13)

Booking, payment and cancellation rules did not change. It needs one database change, which was applied to the online Supabase project on 2026-10-13 with the owner's say-so (step 3 below).

- **A guest who registers later is no longer turned away.** Before, someone who had booked as a guest and then registered with the same email saw "This email is already linked to another client account" and could not carry on. Now they register normally and get a profile of their own.
- **The app asks you before it combines anything.** When two profiles share an email or a phone number (07700 900123 and +44 7700 900123 count as the same number), the pair is listed under "Might be the same person" at the top of Clients. When there is something to combine (a booking on either profile) you also get one alert, "Is this the same person?". Two profiles that each have their own login are never offered: they are two real accounts.
- **You decide, side by side.** The alert opens the two profiles next to each other: what each holds (bookings, notes, addresses) and how each is signed in. Choose "Yes, combine them" (it asks once more, because there is no undo), "No, different people" (the app remembers and never asks about that pair again) or "Decide later". If the first names differ, or only a phone number matches (a phone number typed when booking is never checked), the screen says so and "Yes" is no louder than "No".
- **What combining does.** The profile with the login stays (with no login on either, you choose; the app suggests the one you added yourself). Its bookings keep their status, payment and fees exactly as they were; the other profile's bookings, weekly repeats, notes, addresses (one the client already had is not copied twice, and entry instructions are never lost) and waitlist requests move across, and any missing email, phone number or last name is filled in. A note on the profile says what was combined, and the old profile is saved whole in the database so a mistake can be put right by hand. A guest whose profile is combined will then see and change those bookings only by signing in.
- **For pairs the app cannot spot** (a different email and phone), open the client and press "Combine with another client…" at the bottom of their page.
- **A client who shares an email or phone with someone else can still be corrected** (a family on one phone, for example); only a new email or phone that another client already uses is refused.

## What works now (tested locally)

**For clients** (the website)
- Choose area, treatment, length, date and time, sign in or continue as a guest, pay by bank transfer or cash, get a confirmation.
- A booking waiting for payment keeps its time until you confirm or remove it. Nothing is ever cancelled automatically.
- `/account`: see their bookings, cancel or change the time themselves. Inside the free window they must acknowledge a late fee first. Free for an hour after booking.
- If a day is full, they can leave their details for the waitlist.
- The booking page opens with a warm welcome, three plain steps and the free change window. You can write your own welcome and a "A little about me" (training, experience, insurance: only what is true) under More, Welcome message.

**For you** (the Admin)
- The Admin opens on the Agenda; the Day view is one tap away.
- Calendar (day and agenda), booking details with call, WhatsApp, directions and email.
- Create a booking for someone, complete, no-show, cancel, move; late fees and refunds are recorded for you to settle.
- Payment Review: confirm a transfer, approve cash, or remove a booking, with a note of when it was booked.
- Clients: search, profile, addresses, private notes, booking history, online booking on or off.
- Working hours, special days, and blocked time or personal events over a range of dates and hours (a holiday, a few days, or a couple of hours), with a warning if a change clashes with a booking.
- Repeating bookings: tick "Repeat every Thursday" when creating a booking. The weekly slot is held for that client, the next session becomes a booking about a week before the day and they are asked to pay for it, and you can skip a date, pause or stop it from the client's page.
- Settings: treatments and prices, extras, areas and travel fees, bank details, and the booking rules (days ahead, notice, free window, grace period, booking limits).
- Your private notes about a client show on their booking, so "ring the bell twice" is in front of you on the day.
- Waitlist, with the times that could be booked for each person right now.
- Alerts in the app (red number on Alerts) for new bookings, "I've paid", cash requests, client cancellations and moves, and waitlist activity.

## What only you can do before real clients use it

1. **Telegram and email alerts** (about 30 minutes). Follow `docs/NOTIFICATIONS_SETUP.md`: the old bot's token and your chat ID, a Resend account with `vadmassage.com` verified, and the settings in Vercel. Alerts in the app work without any of this.
2. **Vercel**: create or open the project, add `booking.vadmassage.com`, and put in the settings listed in the notifications notes. Also set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for the website to reach Supabase.
3. **The real Supabase project**: the database changes (about 40 files in `supabase/migrations`) have only been applied to a local copy. They need rehearsing on a Supabase branch first, then applying to the dev project, then to production. Ask for this as its own step; I will not do it without you saying so. The newest one, `20261022100000_same_person_clients.sql`, is what makes "Is this the same person?" work. It has been applied to the online project (2026-10-13); the screens that use it come with the pull request that adds them, and show a plain error on a project that does not have it yet.
4. **Your own details**: save your real bank details in More, Bank transfer details; check the treatments, prices and areas in More; set your usual week in Working hours.
5. **Your own phone**: use it on an iPhone in Safari for a week with your own bookings before opening it to clients.
6. **Fonts and privacy**: the pages load the Playfair Display and Inter fonts from Google Fonts. That sends visitors' addresses to Google. If you would rather not, say so and the fonts can be served from the site itself instead.

## Known limits (worth knowing, not blockers)

- A guest who books twice as a guest, or a guest who registers later, appears as two profiles under Clients. This is on purpose: an email typed by a guest cannot be trusted, so it is never used to link them to an existing client by itself. The app asks you instead (see "Is this the same person?" above). A guest who comes back on a new phone or browser makes a new guest profile each time, so each one is a question to answer.
- Text left over from setting up still shows to clients until you write your own: the extra "Aftercare advice" says "Describe this enhancement." (More, Extras). Check the treatments, extras and areas once as a client would see them.
- The "New test client" helper (it fills in made-up details) exists only in development builds: the live booking page and its preview links never show it, whatever is added to the address.
- A client's page shows "Upcoming" and "Next appointment" for an appointment earlier today until the day is over.

- Not tried on a real iPhone: the Add to Home Screen icons, adding an appointment to the calendar (the `.ics` file) and how it reads with VoiceOver. All of it was checked in a desktop browser and with automated tests. Please try each once on your phone before telling clients.

- Repeating bookings are set up by you for now; clients cannot yet ask for a repeat themselves. The daily job that books each next session runs when the sender is called (see `docs/NOTIFICATIONS_SETUP.md`), so it must be scheduled at least once a day.

- The two-hour notice, the 40 days and the 24 hours are now settings, but the hold on a time while a client books (20 minutes, plus one 10-minute extension) and the 60-minute travel allowance are still fixed in the database.
- Clients cannot yet change their own details or addresses from `/account`; you do that under Clients.
- There is no analytics, receipts or financial reporting, and no WhatsApp assistant. These were left out on purpose.
- The waitlist never contacts anyone: it shows you who to message and when a time opens up.
- Fees and refunds are records for you; the app does not take or send money.
- The continuous-integration checks on GitHub have not run yet. Open a pull request to start them.
