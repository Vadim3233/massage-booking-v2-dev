# Codex Handoff — VAD Massage Booking V2

Updated: 2026-09-27.

## Working principle

Preserve the product. Replace the architecture. Read `APP_PLAN.md`, `DECISIONS.md`, `V2_REBUILD_MASTER_PLAN.md`, `DATABASE_MODEL.md` and `CLIENT_BOOKING_SLICE.md` before continuing. V1 is a read-only product-behaviour reference at `C:/Projects/massage-booking-app`; never copy its monolith or universal serializers.

V2 repository: `Vadim3233/massage-booking-v2-dev`, local path `C:/Projects/massage-booking-app-v2`, branch `main`.

## Remote database

Read-only `npx supabase migration list` on 2026-09-27 confirmed Local = Remote through `20260927193000_client_quote_finalize.sql` (all twelve migrations). That migration is now applied remotely and must not be edited.

No migration was created, edited or pushed during the client UI work. Do not change remote Supabase or deploy without explicit user approval.

## Implemented client slice

Area → Treatment → Duration → Date & Time → Review → Your Details → Payment → Confirmation.

- Real active catalogue and explicit deployed RPC adapters.
- Distinct 60/90/120 session rows, maximum 240 minutes per visit.
- Server availability and pre-auth ten-minute holds, persistent opaque browser key, obsolete-hold release.
- Browser history, temporary draft persistence, hold-expiry feedback.
- Server quotes, appointment-level enhancements with zero public scheduling impact, per-session preferences.
- Email registration/login, Google redirect, password recovery/update and canonical account activation.
- Contact details and saved address reuse.
- Durable idempotency payload for ambiguous retries; no browser-created order or booking.
- Server-backed confirmation with actual payment state and separate session rows.
- Bank transfer awaits verification; cash awaits approval. Bank details are explicit public environment configuration.

`src/App.jsx` remains thin. The client feature owns UI, state and API modules; no browser business database or direct booking/payment writes were introduced.

See `CLIENT_BOOKING_SLICE.md` for source references, tests, configuration and gaps. The old two malformed dollar delimiters in the pgTAP finalization test were fixed and pushed previously in commit `83aac2235a12b6b3cdd3717928308a61dcdaa9ff`.

## Validation commands

```powershell
npx supabase db reset
npx supabase test db
npm test
npm run test:e2e
npm run lint
npm run build
git diff --check
```

`npm test` includes real local Supabase HTTP adapter tests. It requires the local stack. `npm run test:e2e` uses Playwright/Microsoft Edge and a localhost-only Vite server. Its bank details are deliberately fictitious test configuration, never production configuration. No remote writes are used for tests.

## Remaining work

- Supply verified real bank details and verify Google/redirect/email delivery configuration before release.
- Physical Android/Safari verification and final visual parity.
- My Bookings management, Admin UI, payment approval UI, cancellation/rescheduling, waitlist, notifications and Telegram integration remain later slices.
- Do not imply notification delivery or approval happened merely because booking creation succeeded.
- Core release acceptance is broader than this first client slice; the master plan remains the roadmap.

Stop before deployment. Do not push to GitHub unless requested for the new work.
