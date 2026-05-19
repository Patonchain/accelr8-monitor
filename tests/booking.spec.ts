import { test, expect } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"

// Defaults to live booking site for read-only flow checks. Override with
// BOOKING_URL=<staging-url-with-test-stripe-keys> to exercise full checkout.
const BASE_URL = process.env.BOOKING_URL ?? "https://book.joinaccelr8.com"
const COMPLETE_CHECKOUT = process.env.COMPLETE_STRIPE_CHECKOUT === "1"
const SCREENSHOT_DIR = "results/screenshots/booking"
const visionResults: { page: string; severity: string; description: string; screenshot: string }[] = []

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  await fs.writeFile("results/booking-vision.json", JSON.stringify(visionResults, null, 2))
})

test("rooms list loads", async ({ page }) => {
  const response = await page.goto(BASE_URL, { waitUntil: "networkidle" })
  expect(response?.ok()).toBe(true)

  const shot = path.join(SCREENSHOT_DIR, "rooms-list.png")
  await page.screenshot({ path: shot, fullPage: true })
  const verdict = await visionCheck(shot, "book.joinaccelr8.com rooms list")
  for (const issue of verdict.issues) visionResults.push({ page: BASE_URL, ...issue, screenshot: shot })
  expect(verdict.issues.filter((i) => i.severity === "error")).toHaveLength(0)
})

test("room modal opens", async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: "networkidle" })
  const firstRoom = page.locator("[data-room-card], .room-card, button:has-text('View')").first()
  await firstRoom.click()
  await page.waitForTimeout(800)

  const shot = path.join(SCREENSHOT_DIR, "room-modal.png")
  await page.screenshot({ path: shot, fullPage: true })
  const verdict = await visionCheck(shot, "book.joinaccelr8.com room detail modal")
  for (const issue of verdict.issues) visionResults.push({ page: `${BASE_URL}#room`, ...issue, screenshot: shot })
})

test("application form is reachable", async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: "networkidle" })
  const firstRoom = page.locator("[data-room-card], .room-card, button:has-text('View')").first()
  await firstRoom.click()
  const applyBtn = page
    .locator("button:has-text('Apply'), button:has-text('Book'), a:has-text('Apply')")
    .first()
  await applyBtn.click()
  await page.waitForTimeout(1500)

  const shot = path.join(SCREENSHOT_DIR, "application-form.png")
  await page.screenshot({ path: shot, fullPage: true })
  const verdict = await visionCheck(shot, "book.joinaccelr8.com application form")
  for (const issue of verdict.issues) visionResults.push({ page: `${BASE_URL}#apply`, ...issue, screenshot: shot })
})

test("stripe checkout creates a session", async ({ page, context }) => {
  test.skip(!COMPLETE_CHECKOUT, "Set COMPLETE_STRIPE_CHECKOUT=1 (against a test-mode deployment)")

  await page.goto(BASE_URL, { waitUntil: "networkidle" })
  const firstRoom = page.locator("[data-room-card], .room-card, button:has-text('View')").first()
  await firstRoom.click()
  await page.locator("button:has-text('Apply'), button:has-text('Book')").first().click()
  await page.waitForTimeout(1500)

  // Fill in known application fields (these may need adjustment as the form changes).
  await page.fill("input[name='firstName'], input[name='first_name']", "Monitor")
  await page.fill("input[name='lastName'], input[name='last_name']", "Test")
  await page.fill("input[type='email']", "monitor@joinaccelr8.com")
  await page.fill("input[type='tel'], input[name='phone']", "5551234567")
  await page.locator("button:has-text('Continue'), button:has-text('Checkout')").first().click()

  // Wait for Stripe to take over.
  const stripePage = await context.waitForEvent("page", { timeout: 30_000 }).catch(() => page)
  await stripePage.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })

  const shot = path.join(SCREENSHOT_DIR, "stripe-checkout.png")
  await stripePage.screenshot({ path: shot, fullPage: true })

  // Fill Stripe's test card.
  await stripePage.fill("input[name='cardNumber']", "4242 4242 4242 4242")
  await stripePage.fill("input[name='cardExpiry']", "12 / 32")
  await stripePage.fill("input[name='cardCvc']", "123")
  await stripePage.fill("input[name='billingName']", "Monitor Test")
  await stripePage.fill("input[name='billingPostalCode']", "94110")
  await stripePage.locator("button[type='submit']").click()

  // Wait for return to success page.
  await stripePage.waitForURL((url) => !url.toString().includes("checkout.stripe.com"), { timeout: 60_000 })
  const successShot = path.join(SCREENSHOT_DIR, "checkout-success.png")
  await stripePage.screenshot({ path: successShot, fullPage: true })

  const verdict = await visionCheck(successShot, "post-checkout success page")
  for (const issue of verdict.issues) visionResults.push({ page: stripePage.url(), ...issue, screenshot: successShot })
})
