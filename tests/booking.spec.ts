import { test, expect, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"
import { snap } from "../lib/shot.js"

// The booking site is slug-gated: each resident gets a personal URL.
// `BOOKING_SLUG` should point at a synthetic test row that exists for
// the sole purpose of letting the monitor walk every room type.
const ROOT_URL = process.env.BOOKING_URL ?? "https://book.joinaccelr8.com"
const SLUG = process.env.BOOKING_SLUG ?? ""
const SLUG_URL = SLUG ? `${ROOT_URL.replace(/\/$/, "")}/${SLUG}` : ""
// COMPLETE_STRIPE_CHECKOUT=1 enables submitting the test card on the
// Stripe Checkout page. Only safe against a deployment configured with
// `sk_test_*` (i.e. book-staging.joinaccelr8.com). Against live the
// checkout still finishes against `sk_live_*` and creates a real charge.
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

test("slug page renders the rooms list", async ({ page }) => {
  test.skip(!SLUG_URL, "BOOKING_SLUG not set")
  const response = await page.goto(SLUG_URL, { waitUntil: "networkidle" })
  expect(response?.ok(), `HTTP ${response?.status()} on ${SLUG_URL}`).toBe(true)

  // Force any lazy-loaded room cards to mount.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(800)
  await page.evaluate(() => window.scrollTo(0, 0))

  const shot = await snap(page, path.join(SCREENSHOT_DIR, "slug-rooms.jpg"))
  const verdict = await visionCheck(shot, `book.joinaccelr8.com/${SLUG} rooms list`)
  for (const issue of verdict.issues) visionResults.push({ page: SLUG_URL, severity: issue.severity, description: issue.description, screenshot: shot })
  expect(verdict.issues.filter((i) => i.severity === "error")).toHaveLength(0)
})

// Each room card on the slug page → open the modal → click checkout → expect
// to land at Stripe's checkout host. Optionally complete the payment.
//
// We enumerate cards dynamically (Playwright can't parametrize at collection
// time over runtime data). One umbrella test walks every card and sub-steps
// per room. If any room blocks, the test reports which room and why.
test("walk every room type through checkout", async ({ page, context }) => {
  test.skip(!SLUG_URL, "BOOKING_SLUG not set")
  test.setTimeout(8 * 60_000)

  await page.goto(SLUG_URL, { waitUntil: "networkidle" })

  // Strategy: rooms are rendered as <article> or button-like cards inside the
  // BookingExperience grid. We pick the cards that contain a price string
  // ($X,XXX / mo) — that's the most reliable identifier across markup
  // changes. Returns the visible room names so we can iterate by text.
  const roomNames = await page.evaluate(() => {
    const priceRe = /\$\s*\d/
    const cards = Array.from(document.querySelectorAll("article, [role='button'], button, a")).filter(
      (el) => priceRe.test(el.textContent ?? ""),
    )
    const names = new Set<string>()
    for (const card of cards) {
      const heading = card.querySelector("h2, h3, h4, [class*='title']")
      const name = heading?.textContent?.trim()
      if (name && name.length > 2 && name.length < 80) names.add(name)
    }
    return Array.from(names)
  })

  if (roomNames.length === 0) {
    // Useful diagnostic so the daily email shows the page state.
    const shot = await snap(page, path.join(SCREENSHOT_DIR, "no-rooms-found.jpg"))
    visionResults.push({
      page: SLUG_URL,
      severity: "error",
      description: "Could not identify any room cards on the slug page. Selector heuristic needs an update.",
      screenshot: shot,
    })
    throw new Error("zero room cards detected on slug page")
  }

  for (const name of roomNames) {
    await runRoomFlow(page, context, name)
  }
})

async function runRoomFlow(page: Page, context: import("@playwright/test").BrowserContext, roomName: string): Promise<void> {
  const slugName = roomName.replace(/[^a-z0-9]/gi, "_").toLowerCase()

  await test.step(`room: ${roomName}`, async () => {
    // Reset to a clean slug page before each room so prior modals/scrolls don't interfere.
    await page.goto(SLUG_URL, { waitUntil: "networkidle" })

    const card = page.locator(`text="${roomName}"`).first()
    await card.scrollIntoViewIfNeeded()
    await card.click()

    // Wait for the modal to mount; RoomModal renders the checkout CTA.
    await page.waitForTimeout(800)
    const modalShot = await snap(page, path.join(SCREENSHOT_DIR, `room-${slugName}-modal.jpg`))
    const modalVerdict = await visionCheck(modalShot, `book.joinaccelr8.com room modal: ${roomName}`)
    for (const issue of modalVerdict.issues) visionResults.push({ page: SLUG_URL, severity: issue.severity, description: `[${roomName}] ${issue.description}`, screenshot: modalShot })

    const checkoutBtn = page
      .locator("button:has-text('Checkout'), button:has-text('Reserve'), button:has-text('Book'), a:has-text('Checkout')")
      .first()
    if (!(await checkoutBtn.count())) {
      visionResults.push({
        page: SLUG_URL,
        severity: "error",
        description: `[${roomName}] could not find a checkout/reserve/book button in modal`,
        screenshot: modalShot,
      })
      return
    }

    // Stripe Checkout opens in the same tab on book.joinaccelr8.com. Catch a
    // new-tab opening too in case that flips.
    const newPagePromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null)
    await checkoutBtn.click()
    const stripePage = (await newPagePromise) ?? page

    try {
      await stripePage.waitForURL(/checkout\.stripe\.com/, { timeout: 25_000 })
    } catch {
      const shot = await snap(stripePage, path.join(SCREENSHOT_DIR, `room-${slugName}-no-stripe.jpg`))
      visionResults.push({
        page: stripePage.url(),
        severity: "error",
        description: `[${roomName}] checkout click did not lead to Stripe within 25s`,
        screenshot: shot,
      })
      return
    }

    const stripeShot = await snap(stripePage, path.join(SCREENSHOT_DIR, `room-${slugName}-stripe.jpg`))
    const stripeVerdict = await visionCheck(stripeShot, `Stripe checkout for ${roomName}`)
    for (const issue of stripeVerdict.issues) visionResults.push({ page: stripePage.url(), severity: issue.severity, description: `[${roomName}] ${issue.description}`, screenshot: stripeShot })

    if (!COMPLETE_CHECKOUT) return

    // Fill the test card and submit. Only safe against sk_test_* deployments.
    await stripePage.fill("input[name='cardNumber']", "4242 4242 4242 4242")
    await stripePage.fill("input[name='cardExpiry']", "12 / 32")
    await stripePage.fill("input[name='cardCvc']", "123")
    await stripePage.fill("input[name='billingName']", "Monitor Test")
    await stripePage.fill("input[name='billingPostalCode']", "94110")
    await stripePage.locator("button[type='submit']").click()

    try {
      await stripePage.waitForURL((url) => !url.toString().includes("checkout.stripe.com"), { timeout: 60_000 })
    } catch {
      const shot = await snap(stripePage, path.join(SCREENSHOT_DIR, `room-${slugName}-card-fail.jpg`))
      visionResults.push({
        page: stripePage.url(),
        severity: "error",
        description: `[${roomName}] test card submission did not redirect to success within 60s`,
        screenshot: shot,
      })
      return
    }

    const successShot = await snap(stripePage, path.join(SCREENSHOT_DIR, `room-${slugName}-success.jpg`))
    const successVerdict = await visionCheck(successShot, `post-checkout success for ${roomName}`)
    for (const issue of successVerdict.issues) visionResults.push({ page: stripePage.url(), severity: issue.severity, description: `[${roomName}] ${issue.description}`, screenshot: successShot })
  })
}
