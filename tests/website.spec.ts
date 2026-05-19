import { test, expect } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"
import { snapViewports, snap } from "../lib/shot.js"
import { purgeMonitorApplicant, cleanupEnabled, MONITOR_APPLICANT_EMAIL } from "../lib/crmCleanup.js"

const BASE_URL = process.env.WEBSITE_URL ?? "https://joinaccelr8.com"
const SCREENSHOT_DIR = "results/screenshots/website"
const visionResults: { page: string; severity: string; description: string; screenshot: string }[] = []

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  await fs.writeFile("results/website-vision.json", JSON.stringify(visionResults, null, 2))
})

async function scanPage(page: import("@playwright/test").Page, url: string, label: string, fileSlug: string): Promise<void> {
  // joinaccelr8.com runs a per-word unscramble animation on heading load
  // (and likely similar reveals elsewhere). Without an extra settle the
  // first viewport screenshots catch text mid-scramble and the vision model
  // reports false "garbled text" / "corrupted heading" findings. 2.5s lets
  // those effects resolve while still being negligible against the cost
  // of a vision call.
  await page.waitForTimeout(2_500)

  const shots = await snapViewports(page, SCREENSHOT_DIR, fileSlug)
  for (let i = 0; i < shots.length; i++) {
    const verdict = await visionCheck(shots[i], `${label} (viewport ${i + 1} of ${shots.length})`)
    for (const issue of verdict.issues) {
      visionResults.push({
        page: `${url}#vp${i + 1}`,
        severity: issue.severity,
        description: `[vp ${i + 1}/${shots.length}] ${issue.description}`,
        screenshot: shots[i],
      })
    }
  }
}

test("home page loads and renders", async ({ page }) => {
  test.setTimeout(4 * 60_000)
  const response = await page.goto(BASE_URL, { waitUntil: "networkidle" })
  expect(response?.ok(), `HTTP ${response?.status()} on ${BASE_URL}`).toBe(true)
  await scanPage(page, BASE_URL, "joinaccelr8.com home", "home")

  const errs = visionResults.filter((v) => v.page.startsWith(BASE_URL) && v.severity === "error")
  expect(errs.map((e) => e.description), "vision-flagged errors on home").toHaveLength(0)
})

// Core user flow: the application form must actually SUBMIT and reach the
// success page — not just render. This is the test that would have caught
// the 2026-05-19 incident (legacy Supabase key disabled → server action
// write failed silently, page still rendered fine).
test("application form submits end-to-end", async ({ page }) => {
  test.skip(!cleanupEnabled, "SUPABASE_SECRET_KEY unset — can't clean up the test row, so skipping the write")
  test.setTimeout(3 * 60_000)

  // Sweep any leftover row from a prior crashed run before submitting.
  await purgeMonitorApplicant()

  try {
    await page.goto(`${BASE_URL}/apply`, { waitUntil: "networkidle" })

    // Required fields only — Selects are optional in the form.
    await page.fill("#first_name", "Monitor")
    await page.fill("#last_name", "Apptest")
    await page.fill("#email", MONITOR_APPLICANT_EMAIL)
    await page.fill("#phone", "5555550100")
    await page.fill("#startup_description", "Automated monitor submission — verifying the application flow end to end.")
    await page.fill("#why_accelr8", "Automated daily monitor check of the application pipeline.")
    await page.fill("#what_building", "The accelr8-monitor end-to-end test suite.")
    await page.fill("#community_contribution", "Catching broken core flows before real applicants hit them.")
    await page.locator("#communications_consent").click()

    await page.locator("button[type='submit']").click()

    // Server action runs → on success router.push('/apply/success').
    // If the Supabase write fails, the form shows an inline error and the
    // URL stays on /apply — this assertion is what catches that.
    await page.waitForURL(/\/apply\/success/, { timeout: 30_000 })

    const shot = await snap(page, path.join(SCREENSHOT_DIR, "apply-success.jpg"))
    const verdict = await visionCheck(shot, "joinaccelr8.com application success page")
    for (const issue of verdict.issues) {
      visionResults.push({ page: `${BASE_URL}/apply/success`, severity: issue.severity, description: issue.description, screenshot: shot })
    }
  } finally {
    // Always clean up — even if the assertion above failed.
    const purged = await purgeMonitorApplicant().catch(() => ({ people: 0, persons: 0 }))
    console.log(`[apply-test] cleaned up ${purged.people} people + ${purged.persons} persons rows`)
  }
})

test("crawl and screenshot every internal page", async ({ page }) => {
  test.setTimeout(15 * 60_000)
  await page.goto(BASE_URL, { waitUntil: "networkidle" })
  const origin = new URL(BASE_URL).origin
  const hrefs = await page.$$eval("a[href]", (els, origin) =>
    Array.from(
      new Set(
        els
          .map((el) => (el as HTMLAnchorElement).href)
          .filter((h) => h.startsWith(origin) && !h.includes("#") && !h.endsWith(".pdf")),
      ),
    ),
    origin,
  )

  for (const url of hrefs) {
    await test.step(url, async () => {
      const response = await page.goto(url, { waitUntil: "networkidle" })
      expect(response?.ok(), `HTTP ${response?.status()} on ${url}`).toBe(true)
      const slug = url.replace(origin, "").replace(/[^a-z0-9]/gi, "_") || "root"
      await scanPage(page, url, `joinaccelr8.com${new URL(url).pathname}`, slug)
    })
  }
})
