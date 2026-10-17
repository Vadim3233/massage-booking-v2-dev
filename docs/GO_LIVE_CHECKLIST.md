# Going live: what is built, what is left, and what only you can do

Updated 2026-10-15. This is written for the owner, in plain words. The website is live at booking.vadmassage.com (on Vercel), and every database change but one (the morning reminder, step 3) has been applied to the online Supabase project it uses, each one with the owner's say-so. Everything below was built and tested on a local copy first. What is left before real clients is under "What only you can do", with where each item stands.

## New in the design overhaul (2026-10-12)

Both sides were redesigned as one product; the rules (availability, travel buffers, payments, cancellation) did not change and nothing in the database changed.

- **Booking page**: tap a length and you go straight to choosing a time; the time page opens on the first day with room and shows the days before it as full; looking at other days never lets go of a time that is held; the review is a ticket with preferences and extras tucked away and a price that updates by itself; "Continue as guest" is the big button, with "Sign in with email" and "Create an account" plainly under it, and a guest can change their mind on the details screen; a confirmed appointment can be added to a phone's calendar; a regular client is offered "Book your usual"; "Book another appointment" starts afresh.
- **Admin**: a tab bar at the bottom (a rail on a wide screen) with a number on To check and Alerts; the Agenda opens with a short "Needs you" strip where Verify and Approve are one tap and one confirmation away, and **Not yet** puts a payment you cannot settle off until a time you choose; the next appointment is tagged Now or Next; alerts about one booking are one card; New booking is one numbered page where treatment and length are tapped; clients show their initials; more buttons say what they do ("Cancel unpaid booking").
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

## New: delete a client (2026-10-13)

Booking, payment, cancellation and rescheduling rules did not change. It needs one database change, `20261025100000_admin_delete_client.sql`, which was applied to the online Supabase project on 2026-10-13 with the owner's say-so (that one file, after a dry run).

- **Where.** At the bottom of a client's page: **Delete this client…**. It asks first, naming the client and what would go, with "Keep" as the choice that has focus.
- **Who can be deleted.** Someone with no bookings and no weekly repeat: added by mistake, a profile made twice, a made-up test profile. What goes: their details, saved addresses and notes, the waiting-list requests they made, the alerts that name them, and their online account if they have one (so that email can register again). There is no undo.
- **If anything changed while you were deciding** (an address or note added, a waiting-list request made, or the person signing up), nothing is deleted and you are asked again, so only what the question said goes.
- **Who cannot.** A client with bookings, even cancelled ones: bookings, payments and receipts are your records, so they stay, and the page says so and points to switching off online booking. Also not your own profile. And while anyone is in the middle of booking, nothing can be deleted (a few minutes at most); the page says so and has a Check again button.
- **What is not promised.** This does not erase every trace. An alert already sent to Telegram or email cannot be unsent, and database backups (on a paid plan) and Supabase's own logs may keep copies for a while.
- **A record is kept** of each deletion (when, by you, how much went) and never of who the client was. It can be read from the Supabase dashboard only; nothing in the app shows it.
- **Before real clients.** Test accounts that took bookings cannot be deleted from the page. Ask me to clear them with the rest of the test data; I take a copy of the database first.

## New: the link in a booking email works on any phone (2026-10-13)

Booking, payment, cancellation and rescheduling rules did not change. It needed one database change, `20261026100000_booking_access_link.sql`. You applied it to the online Supabase project on 2026-10-15 and I checked it afterwards (every function matches the file, and the new table is closed to everyone from outside), so emails sent from then on carry the private link.

- **What went wrong before.** A guest who booked on the website and opened "See or change your booking" on another phone, or in an email app's own browser, saw "something went wrong" or "no bookings", because the page only knew the browser that had made the booking.
- **What is different.** Every email to a client about a booking now has a private link with a long secret code at the end. Opening it shows that booking on any phone or browser, with no sign-in, and the client can cancel it or move it there. The rules are the ones they always were: inside 24 hours a late fee has to be ticked first, and you and the client are emailed and alerted as before. It works whoever is signed in on that phone, even you as the Admin.
- **How private it is.** The code is random and far too long to guess, and the database keeps only a scrambled copy of it. It belongs to one booking and stops working 30 days after the appointment (or 30 days after the email, if that is later, so an email sent after the appointment, a refund for example, still has a working link). It does not show the client's other bookings. Anyone who has the email can use the link, like any booking link in an email, so clients should not forward it. A wrong or old link only says "This link is not valid or has expired. Please contact Vad." and gives nothing away. You cannot switch off one link on its own; deleting a booking removes its codes.
- **Clients with an account** see the same page with "If you have an account, you can sign in to see all your bookings." The full list (Your bookings) still needs a sign-in.
- **Older emails and the calendar file.** Emails sent before this change, and the link inside "Add to calendar", keep the old address with no code. They open the booking only on the phone where the client booked or is signed in; anywhere else the page says "Booked as a guest? There is no password to enter. Use the link in your latest confirmation email, or the phone you booked on."
- **Your own emails and Telegram messages** do not carry a code, and there are no new settings.
- **To try it**: book as a guest, then open the link in the confirmation email on a different phone or in a private window. It should show the booking and let you cancel or move it. A real iPhone has not been tried.

## New: Telegram updates for clients (2026-10-13)

Booking, payment, cancellation and rescheduling rules did not change for clients. It needed one database change, `20261028100000_client_telegram.sql`. You applied it to the online Supabase project on 2026-10-15 and I checked it afterwards (every function matches the file, the two new tables are closed to everyone from outside, and nothing that was already there changed). It also needs a second Telegram bot that only you can make. Until that is done the box below is simply not shown, and nothing else changes.

- **What clients see.** A box at the top of their confirmation page, and at the top of an open booking on their "Your appointment" page: **Get updates on Telegram**, with one button, **Open Telegram**. They press it, press **Start** in Telegram, and from then on every email about that booking is also sent to their Telegram chat in the same words (confirmed, payment received, moved, cancelled, refund sent). The bot greets them by first name; **/stop** in the chat turns it off. A guest without an account can do it too.
- **Your own alerts do not change.** They still go to your Telegram chat from your own bot. This is a second bot, only for clients, and the two can never be mixed up.
- **What you had to do** (done on 2026-10-16, about 20 minutes; the steps are in `docs/NOTIFICATIONS_SETUP.md`, step 6): make the bot in Telegram's BotFather and tell me only its username (never the token); put three settings into Vercel (the bot's token, a long secret you make up, and last the bot's username) and redeploy after changing them; open one web address once, in a private window. Then make a test booking and press the button to check.
- **Things to know.** There are no reminders in Telegram yet, no receipts, and your screens do not show which clients have linked a chat. A message says what the email says, address included. If a client types a question, the bot points them to the link in their email and to you. A client whose profile you combine with another ("Is this the same person?") keeps their Telegram updates. The box is not shown on a booking opened from the private link in an email (nobody is signed in there), and deleting a client removes their Telegram link along with them.

## New: a reminder on the morning of the appointment (2026-10-14)

Clients get one more email, on the morning of a confirmed appointment. It needs one database change, `20261029100000_day_of_reminders.sql` (not in the online project yet; step 3 below), and the sender running at least once a day after 08:00 London time (`docs/NOTIFICATIONS_SETUP.md`, step 4). Booking, payment and cancellation rules did not change.

- **What it says.** "Hi Ava, a quick reminder: your appointment is today at 14:30, at 12 Edith Road. I'm looking forward to seeing you! You can see or change your booking here: …", then your usual "Warm wishes, Vad".
- **Who gets it.** Confirmed appointments today only (not ones still waiting for payment or cash approval, and not cancelled ones), with an email address, at least an hour away, from 08:00 London time. Once per booking and date, so running the sender again never repeats it. A client emailed about that booking earlier the same day (booked, confirmed or moved) is not reminded as well, and a booking moved to another day is reminded on its new day.
- **When.** The time is the setting `client_reminder_minutes` (minutes after midnight, 480 is 08:00). There is no screen for it yet.
- **Telegram.** Not in this change. A reminder is an ordinary client email in the queue, so it follows the other client emails when clients can link Telegram.
- **Email sending is already on** (step 1 below), so the reminders start as soon as the database change is applied and the sender runs after 08:00. Until then nothing is sent.

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

Press **Day settings** on any day in the Agenda, or in the Day view beside Block time, to change just that date. With **Show every day** on, each free day's whole line opens it, and **Day settings for a date**, above that switch, opens any date, booked or not. The page shows what the day is set to and why, then lets you change its hours, schedule mode (Chain or Flexible), first appointment and release time with one **Save this day** button, add or change blocked time, and open the day's bookings. **Use my usual week** puts the date back to normal; it asks first, because it removes the date's own settings.

- **What is saved.** A special day, the same one the Special days list shows. Your usual week is not touched.
- **Warns, never moves.** If different hours leave a booking outside them, you are told which and can save anyway. Nothing is moved or cancelled for you.
- **A day that has passed** can be looked at but not changed.
- **No database change of its own.** Saving a day writes the release time and schedule mode, so it needs the two database changes above (`20261030100000_anchor_release.sql`, then `20261031100000_schedule_mode.sql`), which are already online (2026-10-15). On a project without them, saving shows "Could not save".

## New: Not yet, and a tighter Agenda (2026-10-15)

**Not yet** sits beside Verify or Approve in the Needs you box and on the To check page. Press it, choose when to be reminded (in 3 hours, tomorrow morning, or the morning before the appointment) and the payment leaves the box and the number on To check until then. It waits on the To check page as "Reminder set", with **Check now** to bring it back at once, and Undo in the message that appears.

- **Nothing else changes.** The booking keeps its time, the client is told nothing, and nothing is cancelled or confirmed. A payment you can already settle can still be verified or approved from To check while it is put off.
- **It comes back by itself** when its time comes, and at once if the booking or its payment changes (the client declaring again, say).
- **Kept on the phone you used.** No database change. Another device (a laptop) does not know about it and still shows the payment as needing you; if a phone ever forgets, the payment simply comes back.
- **It does not buzz your phone.** The reminder shows the next time you open the Admin.
- **Thinner Agenda.** Booking cards use the full width with their time inside, and are a little thinner; each day's heading is one line with a clock icon that opens Day settings (it stays pinned at the top while you scroll, so it was cut from 102px to 48px); the Needs you box is about a third shorter.

## New: cancelled bookings are out of the way (2026-10-15)

The Agenda no longer lists cancelled bookings, so it shows only your current ones. A second switch, **Show cancelled**, sits next to **Show every day**, on one line; switch it on to see the cancelled ones again, with the days that only had cancelled bookings. Both switches start off, and each is remembered on the phone you used.

- **Money still to sort out stays in view.** A cancelled booking where you still owe a refund, or a late fee is still due, stays in the list whatever the switch says. Its status is amber: "Cancelled · refund £85.00 to send" or "Cancelled · late fee £20.00 due". Once you record the refund, or mark the fee received or waived, it drops out like the others. It matters because nothing else lists refunds to send: the cancellation alert says so once, and the booking's own page shows "Refund due".
- **The Day view and a day's own page follow the same choice.** They have no switch; a day with cancelled bookings has one line, "Show 2 cancelled bookings", which turns into "Hide cancelled bookings".
- **What does not change.** Day headings still count only what is going ahead. Alerts, To check and the Clients pages still show cancelled bookings. Nothing is deleted or changed: they are only out of sight.
- **A little different at the top.** The two switches share one line, and the **Day settings for a date** button now has the line above them. On the smallest phones the switches are a touch smaller so both still fit.
- **No database change.**

## New: a proper "choose a new password" page (2026-10-16)

If a client forgets their password, the link in the reset email now opens a page of its own, `booking.vadmassage.com/reset-password`, with **Choose a new password** at the top.

- **What went wrong before.** You tried it on 2026-10-16. The link signed you in on the booking page's first step, with the new-password form at the very bottom of that page where nobody would find it. From Your bookings it signed you in without ever asking for a new password. And pressing the link a second time opened the site as if nothing had happened.
- **What happens now.** The page asks for the new password twice (at least 8 characters), saves it, and leaves the client signed in, with buttons to Your bookings and to book. It works only from the link itself: someone who is simply signed in cannot use it.
- **A link that has been used or has expired** says so in words and offers to send a new one from the same page. So does the page opened with no link. The words do not reveal whether an email has an account.
- **The booking page and Your bookings** now say the same plain thing when any email link, for example one confirming an email, comes back with a problem.
- **Older reset emails**, sent before this change, are sent on to the new page by themselves.
- **A link works once** (Supabase's rule) and stops working after a while. Some mail programs open links to check them and can use one up; if that happens, the page offers a new link.
- **Your Admin's own reset page** is unchanged.
- **No database change.** In Supabase the Redirect URLs should include `https://booking.vadmassage.com/**`, which already covers this page.
- **To try it:** on https://booking.vadmassage.com/account press **Sign in**, then **Forgot password?**, use your `+test` address, press the link in the email, choose a new password, then sign out and sign in with it.

## New: Your bookings says where the money stands (2026-10-16)

A client's **Your bookings** list now has one quiet line under each booking that says where its money stands.

- **Paid:** "£90.00 · Paid".
- **Cash:** "£125.00 · Pay in cash at your appointment" until the appointment has passed. After that it says "£125.00 · Cash", and "Paid" once you record the cash as received.
- **Bank transfer:** "£90.00 to pay by bank transfer" while you are waiting for it, and just "£90.00" once the client says they have sent it (the status already says you will check it).
- **After a cancellation:** "Refund of £90.00 on its way" until you record the refund, then "Refunded"; "Late fee of £20.00 due" until you mark the fee received or waived. A cancelled booking with nothing owed either way has no line.
- **Colours:** green when it is settled, amber when money still has to move, plain otherwise.
- **No database change.**
- **To try it:** sign in at https://booking.vadmassage.com/account with a client that has bookings (your `+test` address) and look at each tile.

## New: a cancelled booking says when it was cancelled (2026-10-16)

- **In your Agenda, the Day view and a day's own page,** a cancelled card says who cancelled it and when, after its status: "Cancelled" and then "by client · Wed 14 Oct, 18:20" ("by you" when you cancelled it, "automatically" when the system did). When the status is long because money is still to send, the note drops to a line of its own, so the cards stay as narrow as before. You can tell a late cancellation from an early one without opening the booking.
- **On the page a client sees** for a cancelled booking, one line under the heading says "Cancelled on Friday 16 October at 16:40." For a client with a late fee it shows why. It is there when they open the booking from their list and from the link in an email.
- **Times are London time.** A booking with no recorded cancellation time shows nothing.
- **Not in the client's list of bookings.** A client knows when they cancelled, and the list does not carry the time.
- **No database change.**
- **To try it:** switch **Show cancelled** on in the Agenda and look at a cancelled card; then open a cancelled booking as the client.

## New: a calmer, more premium look (2026-10-16)

The booking pages, a client's account pages and the whole Admin share one new look: warm ivory pages, white cards, **slate blue** (instead of green) for buttons, links and whatever is selected, and **midnight navy** headings. The gold is gone, including the app icon on a phone's home screen: remove the app from the home screen and add it again to get the new icon.

- **Same meaning, same colour, always with words.** Sage is confirmed or paid, amber means you need to act, terracotta on peach is cancelled or be careful, deep red is an error or something that cannot be undone.
- **The Day view and the Agenda.** The selected tab and date are slate blue, with a dot for today; the working hours are a powder-blue row; "Show 3 cancelled bookings" is a peach row; travel time has a car, free time is tinted sage, and each booking card has a slate edge. A cancelled booking is a quiet soft-grey card with a terracotta edge and the note of who cancelled it and when.
- **Nothing else changed.** The layout, wording, prices, payments, scheduling and sign-in work as before. One small fix on the way: the Admin sign-in error now sits inside the sign-in card instead of loose at the left edge of the page.
- **Not changed, because it is set outside this site.** The sign-up and password emails that Supabase sends keep their green and gold until you edit those templates in Supabase.
- **To try it:** open the Vercel preview of this change on your phone and look at Day, Agenda, To check, a booking, and the booking pages as a client.

## New: a hint for finding the email (2026-10-17)

- **Under "Confirmation email:"** on the page a client sees after booking, and on the page of an open booking (from Your bookings or from the link in an email), one grey line says: "My emails come from hello@book.vadmassage.com. Can't find one? Look in your spam folder and press “Not spam”." A new sender's first email can land in spam, and one "Not spam" teaches the inbox to trust the rest.
- **Not on the payment step,** where no email has gone yet, and **not on a booking with no email address,** which already says "Please contact Vad to confirm your email".
- **If you ever change the sender address** (the `EMAIL_FROM` setting in Vercel), the address in this line has to change with it. It is one line in `src/client/emailSender.js`, and a test fails if it no longer matches the setup guide.
- **No database change, no new setting, no new package.**
- **To try it:** make a test booking and look under the email address on the confirmation page; then open it from Your bookings.

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

1. **Telegram and email alerts**: done on 2026-10-12 (`docs/NOTIFICATIONS_SETUP.md` has the steps). The sender runs every minute. On 2026-10-13 the Telegram, in-app and email alerts were being delivered; the only emails that failed went to made-up test addresses (`example.com`), which email providers refuse. Emails go out from `hello@book.vadmassage.com` through Resend (the domain `book.vadmassage.com` is verified there), with replies going to `bookings@vadmassage.com`. On 2026-10-16 the headers of a real booking email showed SPF, DKIM and DMARC all passing, so the setup is right; even so, the first emails to a new person's Gmail can land in spam until they press "Not spam".
2. **Vercel**: done. The project `massage-booking-v2-dev` serves `booking.vadmassage.com`, and the live site and its alerts work. It is on the free Hobby plan: see step 8.
3. **The online Supabase project**: done for every database change except one (the files in `supabase/migrations` up to `20261031100000_schedule_mode.sql`, including receipts, "Show all times", deleting a client, the private booking link, Telegram updates for clients, the release time and Chain or Flexible, the last four on 2026-10-15). The one exception is in the code but not in the online project yet: the morning reminder, `20261029100000_day_of_reminders.sql` (that email does nothing until you say to apply it). Each was applied only with your say-so, one file at a time after a dry run, and a new database change waits for you in the same way. The project is called `massage-booking-v2-dev` but it is the one the live site uses. The plan is to keep it as the real one once the test data is cleared (step 9); say if you would rather have a separate project for real clients.
4. **Sign-in settings in Supabase**: done on 2026-10-16. Guest booking is switched on ("Allow anonymous sign-ins") and **Confirm email** is on. The account emails ("Confirm sign up" and "Reset password") go out from your own address, `hello@book.vadmassage.com`, through Resend (Authentication, Emails, SMTP Settings) instead of Supabase's built-in sender, which only reaches people on your Supabase team, and they have VadMassage wording (the Templates tab). A test sign-up and a test reset both arrived in the inbox, and the links came back to the site. Under URL Configuration the Site URL should be `https://booking.vadmassage.com` and the Redirect URLs should include `https://booking.vadmassage.com/**`, which covers the booking page, Your bookings and the reset page; if a link ever lands somewhere strange, look there first. Leave bot protection (CAPTCHA) off for now: the booking page does not send the check yet, so with it on, guests and sign-up would be refused. Google is switched on in the project, but the app does not offer it yet.
5. **Your own details**: your receipt details and your bank transfer details are both saved (More, Receipt details; More, Bank transfer details), so a client who chooses bank transfer is shown the bank details. Open the payment page once as a client would, to be sure they read the way you want. Your usual week is already set in Working hours; look it over once, and check the treatments, prices and areas in More the same way.
6. **Your own phone**: use it on an iPhone in Safari for a week with your own bookings before opening it to clients.
7. **Fonts and privacy**: the pages load the Playfair Display and Inter fonts from Google Fonts. That sends visitors' addresses to Google. If you would rather not, say so and the fonts can be served from the site itself instead.
8. **The plans you are on** (checked in the providers' own documentation on 2026-10-13): both services are on their free plans, and each has a limit that matters once real clients rely on the site. Vercel's free Hobby plan is for personal, non-commercial use only, so a business website belongs on its Pro plan ($20 per month per paid user at the time of writing). Supabase's free plan keeps no automatic backups and pauses a project after about a week with too little activity (it can be resumed for 90 days after that); its Pro plan ($25 per month) adds daily backups kept for 7 days and never pauses. Billing is yours to set up; I never enter payment details. If you stay on the free plans for a while, ask me now and then for a copy of the database.
9. **Clearing the test data**: before real clients, the test data is cleared from the online project, only with your say-so and after I have taken a copy of the database. On 2026-10-15 it held 18 clients (10 marked "(test)"; the other 8 are not marked, so you tell me which, if any, are real people), 21 bookings (7 confirmed, 14 cancelled) and 2 receipts. Clearing it also starts receipt numbering again, so your first real receipt is number 1. Your working hours, treatments, extras, areas, bank details and receipt details stay.
10. **The clients' Telegram bot**: done on 2026-10-16. The bot is `@VMBookingsBot`, for clients only. Its token and the shared secret are in Vercel, Telegram knows where to send messages, and the box shows on the confirmation page. A first client linked their chat and received "Your appointment is confirmed" and "Your appointment has moved" on Telegram in the same minute as the emails. A client without the Telegram app can ignore the box: they still get every email.

## Known limits (worth knowing, not blockers)

- A guest who books twice as a guest, or a guest who registers later, appears as two profiles under Clients. This is on purpose: an email typed by a guest cannot be trusted, so it is never used to link them to an existing client by itself. The app asks you instead (see "Is this the same person?" above). A guest who comes back on a new phone or browser makes a new guest profile each time, so each one is a question to answer.
- The extra "Aftercare advice" from setting up is switched off and has no text, so clients do not see it. If you switch it on, write its text first (More, Extras). Check the treatments, extras and areas once as a client would see them.
- The "New test client" helper (it fills in made-up details) exists only in development builds: the live booking page and its preview links never show it, whatever is added to the address.
- A client's page shows "Upcoming" and "Next appointment" for an appointment earlier today until the day is over.

- Not tried on a real iPhone: the Add to Home Screen icons, adding an appointment to the calendar (the `.ics` file) and how it reads with VoiceOver. All of it was checked in a desktop browser and with automated tests. Please try each once on your phone before telling clients.

- Repeating bookings are set up by you for now; clients cannot yet ask for a repeat themselves. The daily job that books each next session runs when the sender is called (see `docs/NOTIFICATIONS_SETUP.md`), so it must be scheduled at least once a day.

- The two-hour notice, the 40 days and the 24 hours are now settings, but the hold on a time while a client books (20 minutes, plus one 10-minute extension) and the 60-minute travel allowance are still fixed in the database.
- Clients cannot yet change their own details or addresses from `/account`; you do that under Clients.
- There is no analytics or financial reporting, and no WhatsApp assistant. These were left out on purpose. Receipts are built but simple: no PDF, no VAT, and none for a cancelled booking or a missed appointment.
- The waitlist never contacts anyone: it shows you who to message and when a time opens up.
- Fees and refunds are records for you; the app does not take or send money.
- GitHub runs the build, the database tests, the unit tests and the lint check on every pull request. The browser tests (Playwright) run on my computer only, not on GitHub.
