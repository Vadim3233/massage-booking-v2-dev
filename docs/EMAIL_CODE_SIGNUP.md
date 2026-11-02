# Sign-up with an email code

## Why

On 2 Nov 2026 two new clients lost their held time while signing up. The confirmation **link** in the email opened in a different browser
window (the email app's own browser, or another browser). That window knew nothing about the booking, so their own held time looked taken.

Now the email carries a **6-digit code**. The client types it on the booking page they never left, and carries straight on with the same
choices and held time. The link is still in the email as a fallback, and the page still has "I used the link in the email instead".

## Release order

The new email works with the old web app too (the old app ignores the code; the link still works). So:

1. **Email template first** (Supabase Dashboard → Authentication → Email Templates → *Confirm signup*):
   - Subject: `Your VadMassage code: {{ .Token }}`
   - Body: everything in `supabase/templates/confirmation.html` below the comment.
   - Check Authentication → Settings that the email OTP length is 6.
2. **Then merge the web app.** No database migration is needed.

Never merge first: the new page asks for a code that the old email doesn't contain (the link fallback would still work, but it is the
very path that caused the problem).

## Check after release

Create an account from the booking page with a real email address on a phone: the email should show a 6-digit code, the code should
confirm on the same page, and the time chosen before signing up should still be held.
