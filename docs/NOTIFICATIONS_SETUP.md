# Alerts and emails: what is built and what you need to switch on

Updated 2026-10-11. Nothing here has been connected to a real Telegram bot, email account or hosted database. The code is built and tested locally with pretend senders.

## What happens

1. Something happens to a booking (a client books, says they have paid, cancels or moves; you confirm, cancel or move).
2. The database writes the message at once and puts it in three places for you:
   - **In the app:** the Alerts tab, with a red number for unread. This works with nothing to set up.
   - **Telegram** and **email to you**, queued for the sender.
3. Clients get a plain email when their booking is confirmed, cancelled, moved, or refunded (only if they gave an email address), and when you email them a receipt from the booking page (see ADR-034). A receipt email is queued like the others, so the receipt shows "Email queued" until the sender has delivered it (and "still waiting" after ten minutes) and "Emailed to" once it has; without the email settings below it stays queued, and WhatsApp and Share or copy still work. The "See or change your booking" link in a client's email carries a private code that opens that one booking on any phone with no sign-in (ADR-037). The sender makes the code just before the email goes, with the service key it already has, so there is nothing new to set up; it is made only for an email to a client, never for you.
4. The sender (`api/dispatch-notifications.js`) delivers the queued Telegram and email messages. A failed message is tried again after 2, 8, 18 and 32 minutes, then it is left marked failed so you can see it.
5. A client who presses **Open Telegram** on their booking page and then Start also gets those same messages in Telegram, from a second bot that is only for clients (see step 6 below and ADR-049). Their messages never go to your chat.

**Reminders.** On the morning of an appointment the client gets one more email: "Hi Ava, a quick reminder: your appointment is today at 14:30, at 12 Edith Road. I'm looking forward to seeing you! You can see or change your booking here: …". It goes to confirmed appointments only (not ones still waiting for payment or cash approval, and not cancelled ones), when the booking has an email address, from 08:00 London time, and when the appointment is at least an hour away. Each booking is reminded once for its date, so one that was moved is reminded on its new day. A client who was already emailed about that booking earlier the same day (booked, confirmed or moved) is not reminded as well. The time is the setting `client_reminder_minutes` (minutes after midnight, 480 is 08:00); there is no screen for it yet. It is an ordinary client email, so anything that follows client emails follows it too.

You are alerted about: a new online booking, "I've paid", a cash request, and a client cancelling or moving. You are **not** alerted about things you did yourself. One more alert is in the app only, with no Telegram message or email because nothing about it is urgent: "Is this the same person?", when two client profiles share an email or a phone number and one of them has a booking (see ADR-033).

## What you need to do

### 1. Telegram (about 10 minutes)
- Use the bot from the old app. Its token is the long text like `123456:ABC...` from BotFather (`/mybots`, then the bot, then API Token).
- Send any message to the bot from your own Telegram, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Your chat ID is the number after `"chat":{"id":`.
- Do not paste the token anywhere except the Vercel setting below. Never into chat, code or a document.

### 2. Email with Resend (about 20 minutes)
- Create a free account at resend.com and add the domain `vadmassage.com`. Resend shows a few DNS records (SPF, DKIM). Add them where your domain's DNS is managed, then press Verify.
- Create an API key (sending access only).
- Choose the From address, for example `Vad <hello@vadmassage.com>`.

### 3. Settings in Vercel
In the Vercel project, Settings, Environment Variables (Production), add:

| Name | Value |
| --- | --- |
| `APP_BASE_URL` | `https://booking.vadmassage.com` |
| `TELEGRAM_BOT_TOKEN` | the bot token |
| `ADMIN_TELEGRAM_CHAT_ID` | your chat ID |
| `RESEND_API_KEY` | the Resend key |
| `EMAIL_FROM` | `VadMassage <hello@book.vadmassage.com>` (an address on the domain you verified in Resend; the live site uses `book.vadmassage.com`) |
| `ADMIN_ALERT_EMAIL` | the address you want alerts sent to |
| `EMAIL_REPLY_TO` | where client replies should go |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key from Supabase (Settings, API). Keep it secret; it is used only by the sender on the server. |
| `CRON_SECRET` | a long random string you make up (30 or more characters) |

A channel is only used when its settings are all present, so you can start with Telegram alone and add email later.

### 4. Make the sender run
The sender does nothing until something calls it. The same call also runs the daily job for repeating bookings (it makes the next session's booking when it is due and asks the client to pay), so it should run at least once a day even if you only use in-app alerts. The morning reminders are planned each time the sender runs from 08:00 London time, so it must run **at least once a day after 08:00 London time**. A run sends up to 50 queued messages, ten at a time. Pick one:

- **Vercel Cron (simplest):** add a `crons` entry to `vercel.json`, for example `{ "path": "/api/dispatch-notifications", "schedule": "* * * * *" }`. Vercel sends your `CRON_SECRET` automatically. **Free (Hobby) Vercel plans only allow a daily schedule**, so a one-minute schedule needs a paid plan. For the reminders a daily `0 8 * * *` (08:00 UTC, which is 08:00 in winter and 09:00 in summer, London time) is enough for a handful a day. The Supabase scheduler below sends them at 08:00 sharp. Ask before adding it, because an unsupported schedule fails the deploy.
- **Supabase scheduler (works on any plan):** in the Supabase SQL editor, enable the `pg_cron` and `pg_net` extensions and run the statement below once, replacing the two values. It asks the sender to run every minute.

```sql
select cron.schedule('send-notifications', '* * * * *', $$
  select net.http_get(
    url := 'https://booking.vadmassage.com/api/dispatch-notifications',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET')
  );
$$);
```

### 5. Check it works
- Make a test booking from the client site and press "I've made the bank transfer". Within a minute you should see the alert in the app and on Telegram, and an email.
- If a message does not arrive, the Alerts tab still has it. Failed deliveries keep their reason in the database (`notification_deliveries.last_error`).

### 6. Telegram updates for clients: a second bot, for clients only (about 20 minutes)
This switches on the **Get updates on Telegram** box on a client's booking confirmation and on their "Your appointment" page (ADR-049). It needs a new bot, separate from the one that sends your alerts (the site ignores a token that is the same as your alerts bot's). Nothing below is needed for anything else to work. The box stays hidden until the very last setting, so please do the steps in this order.

**a. Make the bot.**
1. In Telegram, open **@BotFather** (the one with the blue tick) and send `/newbot`.
2. It asks for a **name**, which clients see at the top of the chat (for example "Vad Massage").
3. It asks for a **username**, which must end in `bot` (for example `VadMassageBot`; if it is taken, try `VadMassageBookingBot`).
4. BotFather replies with a long **token** (like `123456:ABC...`). That is the bot's password. Keep it safe: do not paste it into chat, a document or an email. It goes only into Vercel, below.

**b. Two settings in Vercel first** (Settings, Environment Variables, Production):

| Name | Value |
| --- | --- |
| `TELEGRAM_CLIENT_BOT_TOKEN` | the new bot's token |
| `TELEGRAM_WEBHOOK_SECRET` | a long secret you make up: 30 or more letters, digits, `-` or `_`, nothing else (the site refuses anything shorter than 16; it is how our site knows a call really came from Telegram) |

Vercel applies a new or changed setting only to a **new deployment**, so after adding (or ever changing) any of the three settings, **redeploy**: Deployments, the latest one, Redeploy. Do that now. The email and alert settings in step 3 stay as they are. The sender that runs every minute sends the clients' Telegram messages too, with no change to how it is scheduled.

**c. Tell Telegram where to send messages, once.** Put your token and your secret into this address and open it in a **private (incognito) browser window**, then close the window afterwards, because the address contains both secrets and should not stay in your history. It should say `"Webhook was set"`:

`https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://booking.vadmassage.com/api/telegram-webhook&secret_token=<SECRET>`

If you ever change the secret, open it again (and redeploy first).

**d. Last, show the box.** Add the third setting, `VITE_TELEGRAM_CLIENT_BOT_USERNAME`, with the bot's username without the @ (for example `VadMassageBot`). It is not secret: it is built into the booking page. **Redeploy** once more. Until this is done the box is not shown; once it is, the box shows even if something above was missed, and pressing Start would then do nothing, so check the next step.

**e. Check it works.** Make a test booking on the site and, on its confirmation page, press **Open Telegram** and then **Start** in Telegram: the bot says it is connected (with the client's first name) and the page says so too. Then confirm or move that booking as the Admin: the message arrives in Telegram within a minute, as well as the email. Send `/stop` in the chat and the updates stop.

## Safety notes
- Secrets are read only from Vercel environment variables. None are in the code.
- The sender refuses any caller without `CRON_SECRET` and never shows secrets or technical errors in its replies.
- Only the sender's server key can read the Telegram and email queue; browsers cannot, and you can read only the in-app copy.
