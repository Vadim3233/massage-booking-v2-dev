# Going live: what is built, what is left, and what only you can do

Updated 2026-10-09. This is written for the owner, in plain words. Nothing here has been done on the real (hosted) Supabase project or on Vercel. Everything below was built and tested on a local copy.

## New in the design overhaul (2026-10-12)

Both sides were redesigned as one product; the rules (availability, travel buffers, payments, cancellation) did not change and nothing in the database changed.

- **Booking page**: tap a length and you go straight to choosing a time; the time page opens on the first day with room and shows the days before it as full; looking at other days never lets go of a time that is held; the review is a ticket with preferences and extras tucked away and a price that updates by itself; "Continue as guest" is the plain way on and signing in waits behind "Returning client?"; a confirmed appointment can be added to a phone's calendar; a regular client is offered "Book your usual"; "Book another appointment" starts afresh.
- **Admin**: a tab bar at the bottom (a rail on a wide screen) with a number on To check and Alerts; the Agenda opens with a "Needs you" strip where Verify and Approve are one tap and one confirmation away; the next appointment is tagged Now or Next; alerts about one booking are one card; New booking is one numbered page where treatment and length are tapped; clients show their initials; more buttons say what they do ("Cancel unpaid booking").
- **Your booking link** (More): the address of the booking page to copy or send on WhatsApp, and a link that starts part-way through for one area, treatment and length (for example `/?area=chelsea&treatment=massage&minutes=60`).
- **Home screen**: on an iPhone, open the booking page or the Admin in Safari, press Share, then Add to Home Screen. The Admin gets its own name ("Vad Admin") and icon and opens full screen.

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
3. **The real Supabase project**: the database changes (about 40 files in `supabase/migrations`) have only been applied to a local copy. They need rehearsing on a Supabase branch first, then applying to the dev project, then to production. Ask for this as its own step; I will not do it without you saying so.
4. **Your own details**: save your real bank details in More, Bank transfer details; check the treatments, prices and areas in More; set your usual week in Working hours.
5. **Your own phone**: use it on an iPhone in Safari for a week with your own bookings before opening it to clients.
6. **Fonts and privacy**: the pages load the Playfair Display and Inter fonts from Google Fonts. That sends visitors' addresses to Google. If you would rather not, say so and the fonts can be served from the site itself instead.

## Known limits (worth knowing, not blockers)

- Not tried on a real iPhone: the Add to Home Screen icons, adding an appointment to the calendar (the `.ics` file) and how it reads with VoiceOver. All of it was checked in a desktop browser and with automated tests. Please try each once on your phone before telling clients.

- Repeating bookings are set up by you for now; clients cannot yet ask for a repeat themselves. The daily job that books each next session runs when the sender is called (see `docs/NOTIFICATIONS_SETUP.md`), so it must be scheduled at least once a day.

- The two-hour notice, the 40 days and the 24 hours are now settings, but the hold on a time while a client books (20 minutes, plus one 10-minute extension) and the 60-minute travel allowance are still fixed in the database.
- Clients cannot yet change their own details or addresses from `/account`; you do that under Clients.
- There is no analytics, receipts or financial reporting, and no WhatsApp assistant. These were left out on purpose.
- The waitlist never contacts anyone: it shows you who to message and when a time opens up.
- Fees and refunds are records for you; the app does not take or send money.
- The continuous-integration checks on GitHub have not run yet. Open a pull request to start them.
