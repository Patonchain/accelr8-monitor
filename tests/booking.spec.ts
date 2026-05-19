import { test, expect } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"
import { snap } from "../lib/shot.js"

// The booking site is slug-gated: each resident gets a personal URL.
// The root URL only renders "personal link required". To exercise the
// actual booking flow, set BOOKING_SLUG to a test-only slug whose CRM
// booking config points at sandbox data.
const ROOT_URL = process.env.BOOKING_URL ?? "https://book.joinaccelr8.com"
const SLUG = process.env.BOOKING_SLUG ?? ""
const SLUG_URL = SLUG ? `${ROOT_URL.replace(/\/$/, "")}/${SLUG}` : ""
const COMPLETE_CHECKOUT = process.env.COMPLETE_STRIPE_CHECKOUT === "1"
const SCREENSHOT_DIR = "results/screenshots/booking"
const visionResults: { page: string; severity: string; description: string; screenshot: string }[] = []

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  await fs.writeFile("results/booking-vision.json", JSON.stringify(visionResults, null, 2))
})

test("root URL renders the 'personal link required' gate", async ({ page }) => {
  const response = await page.goto(ROOT_URL, { waitUntil: "networkidle" })
  expect(response?.ok()).toBe(true)
  await expect(page.getByText(/personal link/i)).toBeVisible({ timeout: 5_000 })

  const shot = await snap(page, path.join(SCREENSHOT_DIR, "gate.jpg"))
  const verdict = await visionCheck(shot, "book.joinaccelr8.com gate page")
  for (const issue of verdict.issues) visionResults.push({ page: ROOT_URL, severity: issue.severity, description: issue.description, screenshot: shot })
})

test("booking slug page renders", async ({ page }) => {
  test.skip(!SLUG_URL, "BOOKING_SLUG not set — supply a test slug to exercise the booking flow")
  const response = await page.goto(SLUG_URL, { waitUntil: "networkidle" })
  expect(response?.ok(), `HTTP ${response?.status()} on ${SLUG_URL}`).toBe(true)

  const shot = await snap(page, path.join(SCREENSHOT_DIR, "slug-page.jpg"))
  const verdict = await visionCheck(shot, `book.joinaccelr8.com/${SLUG}`)
  for (const issue of verdict.issues) visionResults.push({ page: SLUG_URL, severity: issue.severity, description: issue.description, screenshot: shot })
  expect(verdict.issues.filter((i) => i.severity === "error")).toHaveLength(0)
})

test("checkout flow against stripe test mode", async ({ page, context }) => {
  test.skip(!SLUG_URL, "BOOKING_SLUG not set")
  test.skip(!COMPLETE_CHECKOUT, "Set COMPLETE_STRIPE_CHECKOUT=1 (against a deployment using sk_test_*)")

  await page.goto(SLUG_URL, { waitUntil: "networkidle" })

  // Try the most likely checkout entry-point selectors. The booking site's
  // exact markup changes; we list a few and click whichever matches first.
  const checkoutBtn = page
    .locator("button:has-text('Checkout'), button:has-text('Reserve'), button:has-text('Book'), a:has-text('Checkout')")
    .first()
  await checkoutBtn.click()

  // Wait for Stripe checkout to take over (new tab or same tab).
  const stripePage = await context.waitForEvent("page", { timeout: 30_000 }).catch(() => page)
  await stripePage.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })

  await snap(stripePage, path.join(SCREENSHOT_DIR, "stripe-checkout.jpg"))

  await stripePage.fill("input[name='cardNumber']", "4242 4242 4242 4242")
  await stripePage.fill("input[name='cardExpiry']", "12 / 32")
  await stripePage.fill("input[name='cardCvc']", "123")
  await stripePage.fill("input[name='billingName']", "Monitor Test")
  await stripePage.fill("input[name='billingPostalCode']", "94110")
  await stripePage.locator("button[type='submit']").click()

  await stripePage.waitForURL((url) => !url.toString().includes("checkout.stripe.com"), { timeout: 60_000 })

  const shot = await snap(stripePage, path.join(SCREENSHOT_DIR, "checkout-success.jpg"))
  const verdict = await visionCheck(shot, "post-checkout success page")
  for (const issue of verdict.issues) visionResults.push({ page: stripePage.url(), severity: issue.severity, description: issue.description, screenshot: shot })
})
