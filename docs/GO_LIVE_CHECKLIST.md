# Going live: what is built, what is left, and what only you can do

Updated 2026-10-13. This is written for the owner, in plain words. Almost nothing here has been done on the real (hosted) Supabase project or on Vercel: the one exception, the database change for "Is this the same person?", is noted under step 3. Everything below was built and tested on a local copy.

## New in the design overhaul (2026-10-12)

Both sides were redesigned as one product; the rules (availability, travel buffers, payments, cancellation) did not change and nothing in the database changed.

- **Booking page**: tap a length and you go straight to choosing a time; the time page opens on the first day with room and shows the days before it as full; looking at other days never lets go of a time that is held; the review is a ticket with preferences and extras tucked away and a price that updates by itself; "Continue as guest" is the big button, with "Sign in with email" and "Create an account" plainly under it, and a guest can change their mind on the details screen; a confirmed appointment can be added to a phone's calendar; a regular client is offered "Book your usual"; "Book another appointment" starts afresh.
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

## New: receipts (2026-10-13)

Booking, payment and cancellation rules did not change. It needs one database change, `20261023100000_booking_receipts.sql`, which was applied to the online Supabase project on 2026-10-13 with the owner's say-so (step 3 below). On a project that does not have it, the Receipt button shows a plain error.

- **Where.** Open a booking whose payment you have marked as received (a confirmed or finished appointment) and press **Receipt**. The first time it makes the receipt and gives it the next number, `VM-2026-0001`, `0002` and so on, never skipping one; pressing it again shows the same receipt. Save your business details once first (More, Receipt details): the receipt asks for them if they are missing.
- **What it says.** Your business name and contact details (an address only if you add one), who it is for with the booking reference, the appointment, a line for each treatment, extra and travel charge, the total paid, and how and when it was paid. It does not show the client's address, says nothing about VAT, and is not a VAT invoice.
- **Sending it.** **Email to** the client (from the app, plain text, no PDF), **WhatsApp** (opens their chat with the receipt already typed in) or **Share or copy**. The email goes out through the same sender as every other email, so it needs the email settings in step 1. The receipt only says "Emailed" once it has really been sent; while it waits it says "Email queued" (and "still waiting" if it takes more than ten minutes, which means the sender may not be switched on), and if it fails it says so. Pressing Email again after a dropped connection cannot send it twice, and an email still waiting when you cancel the booking or refund the payment is stopped.
- **Edit.** Changes the words on that one receipt: who it is for, a note, what each line says, and your details. It cannot change the amounts, the receipt number, or how and when it was paid, because they come from the booking and must match the money you received (the date is the day you marked the payment as received). Every earlier version is kept. If you move the appointment after making the receipt, the receipt tells you and one tap, "Update the date and time", fixes it.
- **Who gets one.** Only a payment marked as received on a confirmed or finished booking. Not a booking still waiting for payment, a cancelled booking (even where you kept a late fee), an appointment you marked as missed, or a refunded payment. If a booking is cancelled after its receipt was made, the receipt stays on record, but it can no longer be sent or changed, and the booking says so.
- **Before real clients start.** Receipts you make while trying it out use up numbers. Ask me to clear the test receipts first so your first real receipt is number 1 (a booking that has a receipt cannot be deleted from the database until its receipt is, on purpose, so I do it in the right order).

## New: any time for a booking you make (2026-10-13)

Booking, payment, cancellation and rescheduling rules did not change for clients. It needs one database change, `20261024100000_admin_any_time.sql`, which was applied to the online Supabase project on 2026-10-13 with the owner's say-so (that one file, after a dry run; step 3 below). It also closes one small gap in how the times clients are offered are worked out (see ADR-035).

- **Where.** On New booking, under the usual times: **Show all times** (only you see it). It lists every half hour from 06:00 to the last start that finishes by midnight.
- **What the times mean.** Solid times are the usual ones. Dashed times are ones the booking page would not offer (a shorter gap than your usual hour, outside your working hours, a day off, or during blocked time); choosing one tells you what you are setting aside, and says it again beside the price. Grey times overlap another appointment (or a time a client is booking right now) and cannot be chosen; tapping one tells you what it clashes with.
- **Never a double booking.** Also refused: a time that has already begun, one that would run past midnight, and one more than a year away. Everything else is yours to decide, except that while a client is part-way through booking that day (a few minutes), unusual times wait and the screen says so, so that the time held for the client is never taken away.
- **Clients see nothing different.** They are still offered only the usual times. After you book an unusual time, the rest of that day usually has no times left for clients, because the first and last appointments of a day set what is offered.
- **Repeating bookings** are only offered at usual times: choosing an unusual time turns the repeat off for that booking. If a repeating client's time is kept free on that day, the screen warns that an unusual booking may stop that week's repeat. **Moving** an existing appointment still offers the usual times only; say if you want the same there.

## New: a reminder on the morning of the appointment (2026-10-14)

Clients get one more email, on the morning of a confirmed appointment. It needs one database change, `20261029100000_day_of_reminders.sql` (only on a local copy so far; step 3 below), and the sender running at least once a day after 08:00 London time (`docs/NOTIFICATIONS_SETUP.md`, step 4). Booking, payment and cancellation rules did not change.

- **What it says.** "Hi Ava, a quick reminder: your appointment is today at 14:30, at 12 Edith Road. I'm looking forward to seeing you! You can see or change your booking here: …", then your usual "Warm wishes, Vad".
- **Who gets it.** Confirmed appointments today only (not ones still waiting for payment or cash approval, and not cancelled ones), with an email address, at least an hour away, from 08:00 London time. Once per booking and date, so running the sender again never repeats it. A client emailed about that booking earlier the same day (booked, confirmed or moved) is not reminded as well, and a booking moved to another day is reminded on its new day.
- **When.** The time is the setting `client_reminder_minutes` (minutes after midnight, 480 is 08:00). There is no screen for it yet.
- **Telegram.** Not in this change. A reminder is an ordinary client email in the queue, so it follows the other client emails when clients can link Telegram.
- **Needs email sending to be switched on** (step 1 below). Until then no client email of any kind goes out, reminders included.

## New: release a first appointment that nobody has booked (2026-10-14)

A day whose first appointment is "At a set time" can now open up on its own. Under **Working hours**, on a weekday or on a special day, a new field **Release time** appears beside the first appointment time. It needs one database change, `20261030100000_anchor_release.sql` (applied to the online project and checked there on 2026-10-15; step 3 below). Booking, payment and cancellation rules did not change, and nothing changes for a day until you pick a release time.

- **What it does.** If nobody has booked the first appointment by the release time on the day before (for example 17:00 the day before), the day is offered to clients as "Any time in my hours" from then on. Without a release time, a first appointment that nobody booked can leave a client with no times at all once it has passed.
- **Once someone has booked**, the day is built around the bookings as always; the release time changes nothing.
- **Special days** have their own release time (or none), starting from the usual week's.
- **The database change is already online** (applied and checked on 2026-10-15). The Working hours screens read and save the new column, so on a project without it they show a plain "Could not save" error. The change adds two empty columns and the same availability calculation with one extra rule that only does anything once a release time is set.

## New: a flexible schedule for a day (2026-10-14)

Each day can now be set to **Flexible** instead of the usual **Chain**. Under **Working hours**, on a weekday or on a special day, a new field **Schedule mode** appears under the end time. It needs one database change, `20261031100000_schedule_mode.sql` (applied to the online project and checked there on 2026-10-15; step 3 below), which builds on the release-time one above, so apply them in that order. Booking, payment and cancellation rules did not change, and every day stays Chain until you change it.

- **What it does.** Once a day has appointments, a Chain day offers clients only the two ends of the day's run (just before the first appointment or just after the last), as before. A Flexible day also offers every half hour in the gaps between appointments, as long as there is room for travel on both sides. It never takes away a time that a chain day would have offered.
- **An empty day is the same in both.** The first appointment (and its release time) still decides what an empty day offers.
- **Special days** start from the usual week's mode, like their hours, and have their own from then on.
- **The database change is already online** (applied after the release-time one and checked on 2026-10-15). The Working hours screens read and save the new column, so on a project without it they show a plain "Could not save" error. Every day stays Chain.

## New: Day settings, one date on its own (2026-10-14)

Press **Day settings** on any day in the Agenda, or in the Day view beside Block time, to change just that date. With **Show every day** on, each free day's whole line opens it, and **Day settings for a date**, beside that switch, opens any date, booked or not. The page shows what the day is set to and why, then lets you change its hours, schedule mode (Chain or Flexible), first appointment and release time with one **Save this day** button, add or change blocked time, and open the day's bookings. **Use my usual week** puts the date back to normal.

- **What is saved.** A special day, the same one the Special days list shows. Your usual week is not touched.
- **Warns, never moves.** If different hours leave a booking outside them, you are told which and can save anyway. Nothing is moved or cancelled for you.
- **A day that has passed** can be looked at but not changed.
- **No database change of its own.** Saving a day writes the release time and schedule mode, so it needs the two database changes above (`20261030100000_anchor_release.sql`, then `20261031100000_schedule_mode.sql`), which are already online (2026-10-15). On a project without them, saving shows "Could not save".

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
3. **The real Supabase project**: the database changes (about 40 files in `supabase/migrations`) have only been applied to a local copy. They need rehearsing on a Supabase branch first, then applying to the dev project, then to production. Ask for this as its own step; I will not do it without you saying so. The one for "Is this the same person?", `20261022100000_same_person_clients.sql`, has been applied to the online project (2026-10-13); the screens that use it show a plain error on a project that does not have it. The next one, `20261023100000_booking_receipts.sql`, is what makes receipts work and has been applied online too (2026-10-13). The newest, `20261024100000_admin_any_time.sql`, is what makes "Show all times" work and has been applied online too (2026-10-13). The one after that, `20261029100000_day_of_reminders.sql`, is what makes the morning reminder work. It has only been applied to a local copy so far. Until it is applied online, the sender reports the reminder step as failed and carries on exactly as before, so the new sender code can be deployed first. The newest, `20261030100000_anchor_release.sql`, is what makes release times work. It has been applied online too (2026-10-15), which the screens needed before they were deployed (see "New: release a first appointment", above). The one after that, `20261031100000_schedule_mode.sql`, is what makes the flexible schedule work. It has been applied online too (2026-10-15), after the release-time one, which the screens needed before they were deployed (see "New: a flexible schedule for a day", above).
4. **Your own details**: save your real bank details in More, Bank transfer details, and your business details for receipts in More, Receipt details; check the treatments, prices and areas in More; set your usual week in Working hours.
5. **Your own phone**: use it on an iPhone in Safari for a week with your own bookings before opening it to clients.
6. **Fonts and privacy**: the pages load the Playfair Display and Inter fonts from Google Fonts. That sends visitors' addresses to Google. If you would rather not, say so and the fonts can be served from the site itself instead.
7. **Sign-in settings in Supabase** (about 10 minutes, on the project the website uses; the Authentication menu). Switch **Allow anonymous sign-ins** on (Sign In / Providers), because "Continue as guest" cannot work without it: with it off, the button shows "Something went wrong". Leave **Confirm email** on, because the app uses a confirmed email to recognise a returning client. Under Emails, SMTP Settings, set up your own email sender (the Resend account from step 1 can do it): Supabase's built-in sender only delivers to people on your Supabase team, so clients would never get the sign-up or "Forgot password?" email. Under URL Configuration, make the Site URL the address of the booking page and add it, and the `/account` page, to the Redirect URLs, so the link in the email comes back to the right place. Leave bot protection (CAPTCHA) off for now: the booking page does not send the check yet, so with it on, guests and sign-up would be refused. Google is switched on in the project, but the app does not offer it yet.

## Known limits (worth knowing, not blockers)

- A guest who books twice as a guest, or a guest who registers later, appears as two profiles under Clients. This is on purpose: an email typed by a guest cannot be trusted, so it is never used to link them to an existing client by itself. The app asks you instead (see "Is this the same person?" above). A guest who comes back on a new phone or browser makes a new guest profile each time, so each one is a question to answer.
- Text left over from setting up still shows to clients until you write your own: the extra "Aftercare advice" says "Describe this enhancement." (More, Extras). Check the treatments, extras and areas once as a client would see them.
- The "New test client" helper (it fills in made-up details) exists only in development builds: the live booking page and its preview links never show it, whatever is added to the address.
- A client's page shows "Upcoming" and "Next appointment" for an appointment earlier today until the day is over.

- Not tried on a real iPhone: the Add to Home Screen icons, adding an appointment to the calendar (the `.ics` file) and how it reads with VoiceOver. All of it was checked in a desktop browser and with automated tests. Please try each once on your phone before telling clients.

- Repeating bookings are set up by you for now; clients cannot yet ask for a repeat themselves. The daily job that books each next session runs when the sender is called (see `docs/NOTIFICATIONS_SETUP.md`), so it must be scheduled at least once a day.

- The two-hour notice, the 40 days and the 24 hours are now settings, but the hold on a time while a client books (20 minutes, plus one 10-minute extension) and the 60-minute travel allowance are still fixed in the database.
- Clients cannot yet change their own details or addresses from `/account`; you do that under Clients.
- There is no analytics or financial reporting, and no WhatsApp assistant. These were left out on purpose. Receipts are built but simple: no PDF, no VAT, and none for a cancelled booking or a missed appointment.
- The waitlist never contacts anyone: it shows you who to message and when a time opens up.
- Fees and refunds are records for you; the app does not take or send money.
- The continuous-integration checks on GitHub have not run yet. Open a pull request to start them.
