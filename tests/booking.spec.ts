import { test, expect, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"
import { snap, snapViewports } from "../lib/shot.js"

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
  test.setTimeout(4 * 60_000)
  const response = await page.goto(SLUG_URL, { waitUntil: "networkidle" })
  expect(response?.ok(), `HTTP ${response?.status()} on ${SLUG_URL}`).toBe(true)

  const shots = await snapViewports(page, SCREENSHOT_DIR, "slug-rooms")
  const errsBefore = visionResults.filter((v) => v.severity === "error").length
  for (let i = 0; i < shots.length; i++) {
    const verdict = await visionCheck(shots[i], `book.joinaccelr8.com/${SLUG} rooms (viewport ${i + 1} of ${shots.length})`)
    for (const issue of verdict.issues) visionResults.push({ page: `${SLUG_URL}#vp${i + 1}`, severity: issue.severity, description: `[vp ${i + 1}/${shots.length}] ${issue.description}`, screenshot: shots[i] })
  }
  expect(visionResults.filter((v) => v.severity === "error").length).toBe(errsBefore)
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

// Booking flow:
//   modal → "Sign lease & reserve" → SignWell iframe (lease signing) → Stripe checkout.
// The monitor verifies the modal opens with a usable CTA per room. Going
// deeper (actually signing the lease + paying) is intentionally out of
// scope today — that requires either SignWell test mode or a synthetic
// lease-skip path, neither of which exist yet.
async function runRoomFlow(page: Page, _context: import("@playwright/test").BrowserContext, roomName: string): Promise<void> {
  const slugName = roomName.replace(/[^a-z0-9]/gi, "_").toLowerCase().slice(0, 40)

  await test.step(`room: ${roomName}`, async () => {
    // Reset to a clean slug page before each room so prior modals/scrolls don't interfere.
    await page.goto(SLUG_URL, { waitUntil: "networkidle" })

    const card = page.locator(`text="${roomName}"`).first()
    await card.scrollIntoViewIfNeeded()
    await card.click()

    // Wait for the modal panel to mount before doing anything else.
    await page.waitForSelector("[role='dialog']", { timeout: 10_000 })

    // Capture the entire modal by scrolling within it. The right-hand
    // booking panel is the scrollable container; we use the role=dialog
    // wrapper since it's the stable selector. With the sticky-CTA layout,
    // viewport 0 already shows the button on desktop, but pricing details
    // and amenities are still further down — capture them too.
    const modalShots = await snapViewports(page, SCREENSHOT_DIR, `room-${slugName}-modal`, {
      containerSelector: "[role='dialog']",
      maxViewports: 8,
    })
    for (let i = 0; i < modalShots.length; i++) {
      const verdict = await visionCheck(modalShots[i], `${roomName} modal (viewport ${i + 1} of ${modalShots.length})`)
      for (const issue of verdict.issues) visionResults.push({
        page: `${SLUG_URL}#${slugName}-vp${i + 1}`,
        severity: issue.severity,
        description: `[${roomName} vp ${i + 1}/${modalShots.length}] ${issue.description}`,
        screenshot: modalShots[i],
      })
    }
    const modalShot = modalShots[0] ?? (await snap(page, path.join(SCREENSHOT_DIR, `room-${slugName}-modal.jpg`)))

    // The CTA text varies by state (RoomModal.tsx). On the currently
    // deployed booking site it reads "Reserve — refundable deposit" in
    // the happy path; in-flight WIP rewords this to "Sign lease & reserve".
    // Other states: "Set dates to continue", "Sold out", "Loading lease…".
    // We use getByRole + accessible-name regex which is more robust than
    // text-matches pseudo-class for buttons whose text content may include
    // surrounding whitespace, line breaks, or wrapping spans.
    const dialog = page.locator("[role='dialog']").first()
    const cta = dialog.getByRole("button", { name: /(reserve|sign lease|set dates|sold out|loading lease)/i }).first()
    try {
      await cta.waitFor({ state: "attached", timeout: 10_000 })
    } catch {
      // Diagnostic: list every button in the dialog so the email tells us
      // exactly what the modal is rendering when this fails.
      const buttonsInDialog = await dialog.locator("button").all()
      const texts = await Promise.all(buttonsInDialog.map((b) => b.textContent().then((t) => (t ?? "").trim().slice(0, 60))))
      visionResults.push({
        page: SLUG_URL,
        severity: "error",
        description: `[${roomName}] no CTA button matched in modal. Buttons present: ${JSON.stringify(texts)}`,
        screenshot: modalShot,
      })
      return
    }

    await cta.scrollIntoViewIfNeeded()
    const ctaText = ((await cta.textContent()) ?? "").trim()
    const isDisabled = await cta.isDisabled()

    if (ctaText.startsWith("Sold out")) {
      visionResults.push({
        page: SLUG_URL,
        severity: "warning",
        description: `[${roomName}] is marked sold out (CTA: "${ctaText}")`,
        screenshot: modalShot,
      })
      return
    }
    if (ctaText.startsWith("Set dates")) {
      visionResults.push({
        page: SLUG_URL,
        severity: "error",
        description: `[${roomName}] CTA shows "${ctaText}" but the monitor slug should have proposedDates pre-filled — booking config drift`,
        screenshot: modalShot,
      })
      return
    }
    if (isDisabled) {
      visionResults.push({
        page: SLUG_URL,
        severity: "error",
        description: `[${roomName}] CTA "${ctaText}" is disabled in modal`,
        screenshot: modalShot,
      })
      return
    }

    // Click the active "Sign lease & reserve" CTA. SignWell overlay should mount.
    await cta.click({ timeout: 5_000 }).catch(async (e) => {
      visionResults.push({
        page: SLUG_URL,
        severity: "error",
        description: `[${roomName}] click failed: ${(e as Error).message.slice(0, 120)}`,
        screenshot: modalShot,
      })
      throw e
    })

    // Wait for either the SignWell iframe to mount OR a "Loading lease…"
    // state to clear. signwell.com is the iframe origin.
    let signwellOk = false
    try {
      await page.waitForSelector("iframe[src*='signwell.com'], iframe[title*='SignWell' i]", { timeout: 30_000 })
      signwellOk = true
    } catch {
      // iframe didn't appear — capture whatever state we're in.
    }

    const afterShot = await snap(page, path.join(SCREENSHOT_DIR, `room-${slugName}-after-click.jpg`))
    if (!signwellOk) {
      visionResults.push({
        page: page.url(),
        severity: "error",
        description: `[${roomName}] SignWell lease iframe did not mount within 30s after clicking "${ctaText}"`,
        screenshot: afterShot,
      })
      return
    }

    const verdict = await visionCheck(afterShot, `lease overlay for ${roomName}`)
    for (const issue of verdict.issues) visionResults.push({ page: page.url(), severity: issue.severity, description: `[${roomName}] ${issue.description}`, screenshot: afterShot })
  })
}
