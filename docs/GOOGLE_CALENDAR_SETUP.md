# Google Calendar copy: setting it up

Your bookings are copied into a calendar of their own, **VadMassage bookings**, in your Google account. You can see them on your phone, even with no internet. It is one way only: changing or deleting something in Google never changes a booking, and the next check puts it back.

You do this once. It takes about 15 minutes. Google's screens change from time to time, so the names below may differ slightly.

## 1. Make the Google "app" that is allowed to write the calendar

1. Go to <https://console.cloud.google.com> and sign in with **the Google account whose calendar you want to use** (the one on your phone).
2. At the top, open the project list and choose **New project**. Name it `VadMassage calendar`, then **Create**, and make sure it is selected.
3. Menu ☰ › **APIs and services** › **Library**. Search for **Google Calendar API**, open it and press **Enable**.
4. Menu ☰ › **Google Auth Platform** (in older screens, "OAuth consent screen"). Press **Get started**:
   - **App name:** `VadMassage bookings`. **User support email:** your email.
   - **Audience:** **External**.
   - **Contact information:** your email. Agree to the policy and press **Create**.
5. In **Google Auth Platform** › **Data access**, press **Add or remove scopes**. Under **Manually add scopes**, paste each of these on its own, press **Add to table**, then **Update** and **Save**:
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `openid`
   - `email`

   The first one lets the app make **its own** calendar and change only that one. It cannot see or touch your other calendars.
6. In **Google Auth Platform** › **Audience**, press **Publish app**, then confirm, so it says **In production**.

   **This matters:** while it says "Testing", Google ends the connection every 7 days.
7. In **Google Auth Platform** › **Clients**, press **Create client**:
   - **Application type:** **Web application**. **Name:** `VadMassage booking site`.
   - Under **Authorised redirect URIs**, press **Add URI** and paste exactly: `https://booking.vadmassage.com/api/google-calendar`
   - Press **Create**.
8. Google shows a **Client ID** and a **Client secret**. Keep this window open for step 2. The secret is shown only once: if you lose it, make a new one under the same client.

## 2. Give the two codes to the booking site (Vercel)

1. Go to <https://vercel.com>, open the booking site's project, then **Settings** › **Environment Variables**.
2. Add `GOOGLE_CLIENT_ID` with the Client ID as its value, for **Production**.
3. Add `GOOGLE_CLIENT_SECRET` with the Client secret as its value, for **Production**. Never paste it anywhere else.
4. Open **Deployments**, press ⋯ on the latest production one, then **Redeploy**, so the site picks up the two codes.

(`APP_BASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already there from the email set-up.)

## 3. Connect

1. On **booking.vadmassage.com** (connecting only works on the live site, because that is the address Google was given), open the Admin › **More** › **Google Calendar** and press **Connect Google Calendar**.
2. Choose your Google account.
3. Google warns **"Google hasn't verified this app"**. That is normal for a private app that only you use. Press **Advanced**, then **Go to VadMassage bookings (unsafe)**.
4. Tick the box that lets it **make secondary calendars and change their events**, then press **Continue**.
5. You come back to the page and it says **Connected**. Within a few minutes all your bookings appear in a new calendar called **VadMassage bookings** in Google Calendar. On your phone, make sure that calendar is ticked to show.

## 4. Share it as free/busy (for example with your wife)

In Google Calendar on a computer:
1. Hover over **VadMassage bookings** in the list on the left, press ⋮ and choose **Settings and sharing**.
2. Under **Share with specific people or groups**, press **Add people and groups** and enter their email.
3. Under **Permissions**, choose **See only free/busy (hide details)**, then press **Send**.

They see only when you are busy, with no names or details.

## If the page says "Needs reconnect"

Google stopped accepting the saved sign-in. This happens if you removed the app's access in your Google account, changed your Google password in some cases, or the app was left in "Testing" (see 1.6). Press **Connect again** and sign in as in step 3. Nothing is lost: everything is copied once you are connected.

## Good to know

- **What an event shows:** the status and the client's name (for example `Massage – Anna Smith`, `⏳ Awaiting payment – …`, `✓ Massage – …` when done), the treatment and its length, the **address** as the event's location (your phone offers directions, and keeps it offline), and a **Travel** event after it. It never shows the phone, email, prices, payment or notes. Someone you share the calendar with as free/busy sees none of this, only that you are busy.
- **When it updates:** about a minute after any change. It also checks every 15 minutes, and rewrites everything at about 3 a.m.
- **Resync now** puts every booking in again, which is useful if you edited events in Google by mistake.
- **Disconnect** stops the copying and withdraws the app's access. The calendar stays in Google; delete it there if you want (Settings and sharing › Remove calendar).
