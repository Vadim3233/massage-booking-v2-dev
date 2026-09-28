# First V2 client-booking slice

Implemented locally on 2026-09-27. No migration edits, remote database changes or deployment.

## Product reference inspected before implementation

Read-only V1 checkout: `C:/Projects/massage-booking-app`.

- `src/components/Booking/ClientBookingFlowScreens.jsx`: Area (active choices, fees, more areas, contact fallback), Treatment (one treatment), Duration (60/90/120 quantities), Date & Time (server slots and hold), Your Details (contact/address/notes).
- `src/App.jsx`: Review around lines 3650–3900 (separate sessions/preferences, shared note, appointment enhancements, fee breakdown); Payment/Confirmation around 3950–4430 (verification versus paid, explicit cash request, reference and summary); authentication around 5939–6030.
- `src/lib/bankTransferDetails.js`: public environment configuration and unavailable state.

V2 implements these behaviours independently. The only necessary payment presentation adjustment is that the server-generated reference appears after finalization, so the action says “Submit bank-transfer booking” rather than pretending a reference/order already exists.

## Ownership

- `src/App.jsx`: composition and configuration/error boundary only.
- `src/client/auth`: email registration/login, Google OAuth redirect, password reset/update, session subscription.
- `src/client/booking/bookingApi.js`: explicit catalogue reads and deployed RPC adapters. No direct booking/order/payment writes.
- `bookingDraft.js`, `bookingStore.js`, `useBookingHistory.js`: session rows, temporary persistence, holds, browser history, quote invalidation and durable idempotent retry.
- `components/`: selection, review, details, payment and canonical confirmation reads.
- `paymentConfig.js`, `.env.example`: public bank configuration, without embedded production values.

## Local verification

Start local Supabase and run `npx supabase db reset`, `npx supabase test db`, `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.

`npm test` includes real HTTP adapter tests and therefore requires local Supabase. `tests/localSupabase.js` obtains only local CLI credentials, rejects non-local URLs, creates isolated fixtures and removes fixture-owned rows. Service-role credentials are confined to Node test setup, never passed to the browser.

`npm run test:e2e` starts a localhost-only Vite server using local Supabase. It uses Microsoft Edge through Playwright; install Edge or select an installed Playwright browser channel in `playwright.config.js`. Bank details on this test server are explicitly fictitious and never written to `.env.local`.

Coverage includes bank/cash journeys, real failed finalization, browser Back/reload, distinct session rows, email registration/activation and obsolete hold release. The adapter tests also cover authoritative quote, conflict rollback, hold-token ownership, private-record access and duplicate retry/outbox prevention.

## Release gaps and scope boundaries

- Supply real `VITE_BANK_ACCOUNT_NAME`, `VITE_BANK_SORT_CODE`, `VITE_BANK_ACCOUNT_NUMBER` before enabling bank-transfer checkout outside local tests.
- Verify Google provider configuration and allowed redirect URLs. Local browser tests exercise email auth; live Google and externally delivered confirmation/recovery emails are not verified.
- Physical Android/Safari devices remain to be checked; browser tests use a mobile viewport and actual history Back.
- Waitlist, My Bookings management, Admin UI/payment approval, cancellation, Telegram linking and notification workers remain later slices. The confirmation page reads the created booking through RLS; it does not claim those integrations exist.
- Catalogue/working-hours content must be configured in the chosen environment. There is no fake production catalogue or fallback availability.
- The built UI has minimal mobile styling; final V1 visual parity is a later phase of the master plan.

## Verified results (2026-09-27)

Fresh local reset passed. pgTAP: 77/77 tests across 5 files. Vitest: 60/60 tests across 4 files (including 7 real local HTTP adapter tests). Playwright: 5/5 browser journeys across 1 file. Lint and production build passed. No migration changes or deployment.

## Exact changed-file manifest

- `.env.example`
- `.gitignore`
- `docs/APP_PLAN.md`
- `docs/CLIENT_BOOKING_SLICE.md`
- `docs/CODEX_HANDOFF.md`
- `docs/DATABASE_MODEL.md`
- `docs/DECISIONS.md`
- `package-lock.json`
- `package.json`
- `playwright.config.js`
- `src/App.jsx`
- `src/client/auth/AuthPanel.jsx`
- `src/client/auth/useClientAuth.js`
- `src/client/booking/booking.css`
- `src/client/booking/bookingApi.integration.test.js`
- `src/client/booking/bookingApi.js`
- `src/client/booking/bookingDraft.js`
- `src/client/booking/BookingFlow.jsx`
- `src/client/booking/bookingStore.js`
- `src/client/booking/bookingStore.test.js`
- `src/client/booking/components/ConfirmationStep.jsx`
- `src/client/booking/components/DetailsStep.jsx`
- `src/client/booking/components/PaymentStep.jsx`
- `src/client/booking/components/ReviewStep.jsx`
- `src/client/booking/components/SelectionSteps.jsx`
- `src/client/booking/paymentConfig.js`
- `src/client/booking/useBookingHistory.js`
- `src/index.css`
- `src/lib/supabase.js`
- `src/shared/ErrorBoundary.jsx`
- `tests/e2e/booking.spec.js`
- `tests/localSupabase.js`
- `tests/start-local-ui.js`
- `vite.config.js`
