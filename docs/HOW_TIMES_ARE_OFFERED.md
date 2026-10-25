# How the times clients see are worked out

Written on 2026-10-14 from the owner's own description, checked against the booking code, the database and a test on a local copy. It is not new behaviour: it is how the app already works, in one place, in the words the screens use. Where the planning notes and the code say "anchor", the screens say "first appointment".

## Three separate ideas

**Working hours** answer "what part of this day am I willing to work?"

**First appointment** (the "anchor") answers "if nobody has booked yet, where should this day begin?" It has two settings:

- **At a set time**: an empty day offers clients only that time. It can also have a **release time**, which opens the day up if nobody takes that time (see "Releasing a first appointment that nobody has booked" below).
- **Any time in my hours**: an empty day offers every usual start inside the working hours.

**The schedule mode** answers "once bookings exist, how are new ones added?" It is set for each day, and has two settings:

- **Chain** (the default): new bookings are attached to the two ends of the day's run of appointments, never to little gaps in the middle.
- **Flexible**: new bookings can also go into the gaps between appointments, as long as there is room for travel on both sides.

On top of these, the app takes away whatever cannot work: the treatment length, 60 minutes of travel between appointments, bookings already made, a time a client is holding while they pay, blocked time, the notice you need, and how far ahead clients may book (the last two are set in Booking rules).

## First appointment, on an empty day

Wednesday, working 10:00 to 20:00, first appointment **At a set time** 15:00, nobody has booked: clients are offered **only 15:00**. That is where the day's chain starts. It does not mean every booking has to start at 15:00.

The same Wednesday with **Any time in my hours**: clients are offered 10:00, 10:30, 11:00 and so on, as far as the treatment length, travel, blocked time and the end of the day allow. The first client to book decides where the chain starts.

So with a set time you decide where an empty day starts, and without one the first client does.

## Releasing a first appointment that nobody has booked

A first appointment **At a set time** keeps an empty day to that one time. If nobody takes it, a client who looks later sees nothing, even though the day has hours left. A **release time** fixes that. It is a time on the day before: if nobody has booked the first appointment by then, the day is offered as **Any time in my hours** from then on.

Wednesday, working 10:00 to 20:00, first appointment at 15:00, release time **17:00 the day before**. Until 17:00 on Tuesday, an empty Wednesday offers only 15:00. From 17:00 on Tuesday, if nobody has booked, it offers 10:00, 10:30, 11:00 and so on, as for any day, as far as the treatment length, travel, blocked time and the end of the day allow. Your notice period still applies, as always.

- **It only matters for an empty day.** Once someone has booked, the day is worked out from the bookings, release time or not. If that booking is cancelled and nobody else has booked, a day that is already past its release time is open again.
- **Where it is set.** Wherever the first appointment is set: on a weekday of the usual week, and on a special day. A special day has its own release time, or none; it does not borrow the usual week's.
- **London time.** "The day before" is counted in London time, so it stays right either side of the clocks changing.
- **Keep it until someone books** (no release time) is the default and works as before.
- **Only with a set time.** A day with **Any time in my hours**, or a day off, has no release time.

## The chain, once there is a booking

Once someone has booked 15:00, the set time has done its job and the day is worked out from the real bookings. With 60 minute treatments and 60 minutes of travel, a booking at 15:00 leaves 13:00 (before it) and 17:00 (after it). If 13:00 and 17:00 are then booked as well, the day runs 13:00, 15:00, 17:00 with travel in between, and the next offers are at the two ends again.

Bookings that are waiting for payment or for your approval count as part of the chain, and so does a time that a client is holding while they pay.

## Flexible days

On a **Flexible** day, once there are appointments, clients are offered every half hour that leaves room for travel on both sides of every other appointment, gaps between appointments included. Take a Wednesday working 10:00 to 20:00, with 60 minute treatments and 60 minutes of travel. With one booking at 15:00, a chain day offers 13:00 and 17:00; a flexible day offers every half hour from 10:00 to 13:00 and from 17:00 to 19:00. With bookings at 10:00 and 18:00 a chain day offers nothing, because both ends of the day are already used, and a flexible day offers 12:00 to 16:00 in between.

- **A flexible day always offers everything a chain day would**, and the gaps as well. Switching a day to flexible never takes a time away.
- **An empty day is the same in both modes.** The first appointment (and its release time) decides what an empty day offers; the mode only matters once someone has booked.
- **Blocked time** is never offered, and travel cannot run through it: a time is not offered if the treatment, or the travel into it from an appointment before it, overlaps blocked time. When it would be the first appointment of the day, the travel on to the next booking is checked instead. These are the same checks as at the two ends of a chain.
- **Where it is set.** On a weekday of the usual week and on a special day. A special day starts from the usual week's mode, like its hours, and has its own mode from then on.
- **Holds and moves work as in a chain.** A time a client is holding counts as an appointment, and a booking that is being moved is not in its own way.

## Moving a booking

When you move a booking, it is set aside while the times are worked out, so it is never in its own way. That has one surprise. If it is the only booking of a day whose first appointment is **At a set time**, the day looks empty without it, and an empty day offers only that set time. A Sunday that starts at 12:00, with one booking at 12:00, offers 12:00 and nothing else when you press Reschedule.

**Show all times** is there for this, under the usual times, as on New booking. It lists every half hour of the day: solid times are the usual ones, dashed times are not (it says what you are setting aside), and grey times overlap another appointment. A time that has already begun, one that would run past midnight and one more than a year away are not offered. While a client is part-way through booking that day, times outside the usual ones wait a few minutes. Clients are still offered only the usual times, including when they move their own booking.

## Your usual week

Each weekday has its own hours, a first appointment setting, or is a day off. For example Monday to Wednesday and Friday 10:00 to 20:00, Thursday off. A date follows the usual week unless it has a special day.

## Special days

A special day replaces the usual week for **one date**: its hours and its first appointment together. Your usual Tuesday may be 10:00 to 20:00, and Tuesday 20 October 13:00 to 18:00; the Tuesday after is back to 10:00 to 20:00. A Friday can be 12:00 to 19:00 with a first appointment at 14:30 while your usual Friday has none.

The app looks for a special day first and uses the usual week only when there is none. **Use my usual week** removes the special day, and that date follows the usual week again.

Adding a special day starts from what the usual week says for that weekday, so only what is special about the day needs changing. A special day keeps a copy of those hours when it is saved: if you change the usual week later, special days that already exist do not change.

## Good to know

- With **At a set time**, only that time is offered until someone books. If that time has already passed, or is inside your notice period, clients see **no times at all** that day, even though your hours run later. Tested on a local copy: with the set time already past, no times were offered; with it about three hours ahead, exactly that time; with **Any time in my hours**, every usual time from the notice period onwards. If you would still like to take bookings later that day, use **Any time in my hours** for that date, or give the first appointment a **release time**, after which the day offers every usual time.
- A set time has to fit: if the treatment would finish after your hours, or the time falls in blocked time, it is not offered.
- A day off, or blocked time, always wins over the first appointment.
