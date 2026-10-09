# Alerts and emails: what is built and what you need to switch on

Updated 2026-10-11. Nothing here has been connected to a real Telegram bot, email account or hosted database. The code is built and tested locally with pretend senders.

## What happens

1. Something happens to a booking (a client books, says they have paid, cancels or moves; you confirm, cancel or move).
2. The database writes the message at once and puts it in three places for you:
   - **In the app:** the Alerts tab, with a red number for unread. This works with nothing to set up.
   - **Telegram** and **email to you**, queued for the sender.
3. Clients get a plain email when their booking is confirmed, cancelled, moved, or refunded (only if they gave an email address).
4. The sender (`api/dispatch-notifications.js`) delivers the queued Telegram and email messages. A failed message is tried again after 2, 8, 18 and 32 minutes, then it is left marked failed so you can see it.

You are alerted about: a new online booking, "I've paid", a cash request, and a client cancelling or moving. You are **not** alerted about things you did yourself.

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
| `EMAIL_FROM` | `Vad <hello@vadmassage.com>` |
| `ADMIN_ALERT_EMAIL` | the address you want alerts sent to |
| `EMAIL_REPLY_TO` | where client replies should go |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key from Supabase (Settings, API). Keep it secret; it is used only by the sender on the server. |
| `CRON_SECRET` | a long random string you make up (30 or more characters) |

A channel is only used when its settings are all present, so you can start with Telegram alone and add email later.

### 4. Make the sender run
The sender does nothing until something calls it. The same call also runs the daily job for repeating bookings (it makes the next session's booking when it is due and asks the client to pay), so it should run at least once a day even if you only use in-app alerts. Pick one:

- **Vercel Cron (simplest):** add a `crons` entry to `vercel.json`, for example `{ "path": "/api/dispatch-notifications", "schedule": "* * * * *" }`. Vercel sends your `CRON_SECRET` automatically. **Free (Hobby) Vercel plans only allow a daily schedule**, so a one-minute schedule needs a paid plan. Ask before adding it, because an unsupported schedule fails the deploy.
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

## Safety notes
- Secrets are read only from Vercel environment variables. None are in the code.
- The sender refuses any caller without `CRON_SECRET` and never shows secrets or technical errors in its replies.
- Only the sender's server key can read the Telegram and email queue; browsers cannot, and you can read only the in-app copy.
