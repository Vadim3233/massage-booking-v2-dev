# The safety net for the free plans

Written 2026-10-15 for the owner, in plain words. The app runs on free plans: Supabase Free for the database and Vercel Hobby for the website. They work, but they come with no automatic backups, no support, and rules that can change. This page says what could go wrong, what is set up to catch it, and what to do when something breaks.

Where each piece stands is tracked in the pull requests that add them; this page describes how they work once they are switched on.

## What could go wrong, and what covers it

| What could go wrong | How likely | What you would notice | What covers it |
| --- | --- | --- | --- |
| Data is lost or damaged: a delete by mistake (yours or mine), a bad update, someone getting into your Supabase login, or a fault at Supabase | Unlikely, but it can never be undone | Clients, bookings or receipts missing | **The daily backup to your PC (section 1).** Paying for Pro later may not bring back what was lost before: Supabase says it currently keeps some daily copies of free projects that appear if you upgrade, but it does not promise them and may stop. Do not rely on it. |
| The database is paused after a quiet week | Unlikely: the reminder sender uses it every minute | The booking page and the Admin say "Something went wrong" | Supabase emails you about a week before it pauses. "Resume project" in the Supabase dashboard brings it back (for up to 90 days). The site check (section 2) also tells you. |
| Vercel pauses the website because the free plan is for non-commercial use | Not known: Vercel does not say how often it checks | The booking page shows a Vercel error (503 DEPLOYMENT_PAUSED); the Admin and the reminder sender stop too | The site check tells you within about an hour. Then see section 5. |
| Someone gets into one of your accounts | Rare, and the worst of all | Anything | Two-step sign-in everywhere (section 4). |
| The database slowly fills up | Slow: about 17 MB a month from the reminder schedule's own log | Nothing for about two years, then errors | The one-line tidy-up (section 3). |

## 1. The daily backup to your PC

**What it does.** Every evening at 21:30 (or as soon as the PC is on, if it was off) a small program on this PC asks Supabase for a full copy of the online database: the structure, every table's data and the logins. It saves the copy in `C:\Users\<you>\VadMassage-Backups\2026-10-15_2130\` (a few MB each), checks that the copy looks complete (clients, bookings and logins are in it), counts the rows of each table in `manifest.json`, and warns if clients, bookings, payments, receipts or addresses fell by more than half since the last backup. It keeps the newest 30 copies plus the last copy of each of the three months before that, and removes the rest. It uses Docker Desktop (the same one the local test copy uses) and starts it if it is not running. Ten minutes after you sign in to Windows, a pop-up warns you if there has been no good backup for three days.

**Setting it up (once, about ten minutes).**

1. In Supabase, open your project and press **Connect** at the top. Choose **Session pooler** and copy the connection string. It looks like `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`. Use the Session pooler one: the other kind only works on a network with IPv6 and often fails at home.
2. The string has `[YOUR-PASSWORD]` where the database password goes. If you do not know the password: **Project Settings, Database, Reset database password**. Choose letters and numbers only. The live website does not use this password (it uses its own keys), so changing it does not affect the site; it only affects tools that connect directly with the old one.
3. Save the whole string, with the real password in place of `[YOUR-PASSWORD]`, as the **first line of a plain text file** called `db-url.txt` in the folder `C:\Users\<you>\.vad-backup\` (make the folder if it is not there). This file can read and change your whole database: never put it in the project folder, an email or a chat, and do not paste it to me. This is the one step only you can do.
4. Run the installer once (from anywhere, as long as `-ProjectDir` is the project folder that has `node_modules`):

   ```
   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -ProjectDir <the project folder>
   ```

   It copies the tool to `C:\Users\<you>\VadMassage-Backups\tool\` and creates two Windows scheduled tasks, "Vad Massage - database backup" and "Vad Massage - backup check". Add `-WhatIf` to see what it would do without doing it. `-Remove` takes the two tasks away again (backups already made are kept). `-Time 20:00` changes the hour.
5. Double-click **Back up now.cmd** in the tool folder. It should end with "Backup saved". Open the new folder and look at `manifest.json`: it lists how many clients, bookings and logins the copy holds.

**Keeping the copies private.** They contain names, phone numbers, addresses and your notes. They stay in your Windows user folder, which other accounts cannot open. Turn on Windows Device encryption if your PC offers it (Settings, Privacy & security, Device encryption). The tool refuses to save inside a git checkout, because the project's repository is public. Do not email them or upload them. A client who asks to be erased is erased from the live database straight away, but older backups still hold their details until they expire (up to about four months): say so in your privacy notice.

**Checking it.** The newest folder name is the date of the last backup. `backup.log` in the backups folder records every run, including failures and their reason (never the password). To ask the question directly: `node scripts\backup-database.mjs --check`.

**Getting your data back.** There are two different situations.

*A. Something was deleted or changed by mistake, and the project is still there.* Do not make more changes. Tell me which day and what is missing. The safe route is to restore the old copy into a scratch project on this PC, look at it, and copy back only what is missing. Never overwrite the live database with an old copy: that would also throw away every booking made since.

*B. The project is gone or unusable (deleted, damaged, or the account is lost).* I do the commands with you; the keys and passwords stay yours.

1. Create a new Supabase project in the same region as before (West EU, Ireland). In **Database, Extensions** switch on `pg_cron` and `pg_net`.
2. In the newest backup folder, restore with the **Session pooler** string of the new project:

   ```
   & "C:\Program Files\PostgreSQL\18\bin\psql.exe" --file schema.sql --command "SET session_replication_role = replica" --file data.sql --dbname "<the new project's string>"
   ```

   Do not use `roles.sql` (the new project already has the standard roles, and it refuses a few lines on purpose). Do not add `--single-transaction`: Supabase's own login tables differ a little between versions, so a few messages about `auth` or `storage` tables or columns may appear. They are harmless. What matters is that everything in `public` and the logins (`auth.users`, `auth.identities`) go in.
3. Check the numbers: `select count(*) from public.clients;` and the same for `public.bookings` should match `manifest.json`.
4. Redo what lives outside the database: in the new project's Authentication settings, Confirm email on, Allow anonymous sign-ins on, the Resend email settings, and the Site URL and redirect addresses; the every-minute schedule (`docs/NOTIFICATIONS_SETUP.md`, step 4, with the new address); and in Vercel the four settings that point at the project (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), then redeploy, because the first two are built into the site. Logins keep their passwords, so your Admin login works as before, but everybody is signed out and has to sign in again.
5. Open the live site, make a test booking, and look at the Admin.

*What was tested (2026-10-15).* A backup of the local test database was restored into a brand-new, empty project on this PC with the commands above. All 38 tables in `public` came back identical row for row, with the 10 logins and their 8 sign-in identities. Six messages appeared about Supabase's own login tables, which an older empty project did not have yet, and nothing of ours was affected. The first backup of the online project is for you to run (step 5); it cannot be tested without your connection string.

**What the backup does not cover:** the settings kept in the Supabase and Vercel dashboards (listed in B4), your code (it is in GitHub), and your Telegram, Resend and domain accounts.

## 2. The site check

Every half hour GitHub visits four public addresses: the booking page, the Admin page, the reminder sender's door and Supabase's door. The sender and Supabase must answer "locked" (that proves they are alive; they do not talk to strangers); the pages must open. An address that fails three times in a row, twenty seconds apart, makes the check fail, and GitHub emails you ("Run failed: Site check"). It makes ordinary public requests only: no keys, no logins, nothing is changed.

It is a smoke alarm, not a guarantee. GitHub can be late by a quarter of an hour, and it cannot tell whether booking works end to end. Make sure GitHub is allowed to email you: GitHub, Settings, Notifications, Actions, "Send notifications for failed workflows only". If the site stays down you may get an email for each failed check.

## 3. The one-line tidy-up (you run it once)

The every-minute schedule writes a log line each time, and Supabase never clears it: about 17 MB a month. This keeps the last seven days. In the Supabase SQL editor run:

```sql
select cron.schedule('prune-cron-history', '17 3 * * *', $$
  delete from cron.job_run_details where end_time < now() - interval '7 days'
$$);
```

Check it: `select jobname, schedule, active from cron.job order by jobname;` should list `prune-cron-history` and `send-notifications`. To undo it: `select cron.unschedule('prune-cron-history');`

## 4. Two-step sign-in (you do this, about five minutes each)

A stolen login is the one thing the free plans cannot fix for you. Turn on two-step sign-in (an authenticator app or a passkey, in each service's Security or Account settings) for: **Supabase**, **Vercel**, **GitHub**, the **Google account** you use to sign in to them, the **domain registrar** where vadmassage.com is registered, **Resend**, and the **Telegram** account that owns the alerts bot. Keep the recovery codes somewhere safe that is not this PC.

## 5. If something breaks

| What you see | What it probably is | What to do |
| --- | --- | --- |
| The booking page shows a Vercel error such as 503 DEPLOYMENT_PAUSED | Vercel paused the site (free plan, non-commercial use) | Read the email Vercel sent. Ask Vercel support whether your use counts as commercial, or upgrade the project to Pro ($20 a month). Your data is untouched. |
| The page opens but every step says "Something went wrong", or the Admin shows no data | The Supabase project is paused | Supabase dashboard, your project, **Resume project**. It takes a few minutes. |
| Alerts stopped arriving but the site works | The every-minute schedule or the sender stopped | Tell me. `docs/NOTIFICATIONS_SETUP.md` has the checks; the Alerts tab in the Admin still records everything. |
| Clients, bookings or receipts are missing | A delete or a bad update | Stop changing things. Tell me the day and what is missing (section 1, A). |
| A "Site check" email from GitHub | One of the four addresses stopped answering | Open the failed run on GitHub to see which one, then use the rows above. |
| A pop-up says no good backup for three days | The PC was off, Docker could not start, or the connection string stopped working (for example after a password reset) | Run **Back up now.cmd** and read what it says; `backup.log` has the reason. |

## 6. If you decide to pay

Supabase Pro is from $25 a month: Supabase, the organisation's Billing page, Change subscription plan. Daily backups (kept seven days) begin and pausing for inactivity stops, and you can switch back to Free at any time with the unused days credited. Vercel Pro is $20 per person a month: Vercel, Settings, Billing, Upgrade. Prices are in US dollars before tax. Even on Pro, keep the daily backup to your PC: it is a second copy that does not depend on one company.
