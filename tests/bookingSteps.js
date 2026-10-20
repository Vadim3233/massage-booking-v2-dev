import { expect } from '@playwright/test'

// Step 3 of the booking is People & length: first "How many people?" (nothing is chosen for the client), then the lengths for that many.
// This answers both: "Just me" (or "2 people"…) when the question is showing, then the length, which goes straight on to the time.
export async function chooseLength(page, minutes = 60, people = 1) {
  const who = page.getByRole('button', { name: people === 1 ? /^Just me/ : new RegExp(`^${people} people`) })
  const length = page.getByRole('button', { name: new RegExp(`^${minutes} minutes`) })
  await expect(who.or(length).first()).toBeVisible()
  if (await who.isVisible()) await who.click()
  await length.click()
}
