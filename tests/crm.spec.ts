import { test, expect } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"
import { snap, snapViewports } from "../lib/shot.js"

const BASE_URL = process.env.CRM_URL ?? "https://accelr8-crm.vercel.app"
const EMAIL = process.env.CRM_MONITOR_EMAIL ?? "monitor@joinaccelr8.com"
const PASSWORD = process.env.CRM_MONITOR_PASSWORD ?? ""
const SCREENSHOT_DIR = "results/screenshots/crm"
const visionResults: { page: string; severity: string; description: string; screenshot: string }[] = []

const GATED_PAGES = ["/board", "/queue", "/tickets", "/settings"]

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  await fs.writeFile("results/crm-vision.json", JSON.stringify(visionResults, null, 2))
})

test("login page loads", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" })
  expect(response?.ok()).toBe(true)
  const shot = await snap(page, path.join(SCREENSHOT_DIR, "login.jpg"))
  const verdict = await visionCheck(shot, "CRM login page")
  for (const issue of verdict.issues) visionResults.push({ page: `${BASE_URL}/login`, severity: issue.severity, description: issue.description, screenshot: shot })
  expect(verdict.issues.filter((i) => i.severity === "error")).toHaveLength(0)
})

async function signIn(page: import("@playwright/test").Page): Promise<{ ok: boolean; reason: string; shot?: string }> {
  await page.goto(`${BASE_URL}/login`)
  await page.fill("input[type='email']", EMAIL)
  await page.fill("input[type='password']", PASSWORD)
  await page.locator("button[type='submit'], button:has-text('Sign in')").first().click()

  // Wait up to 15s either for navigation away from /login, or for an
  // error message to appear inline. We capture both states.
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    if (!page.url().includes("/login")) return { ok: true, reason: "signed in" }
    const errEl = page.locator("text=/not allowlist|unauthor|invalid|error/i").first()
    if (await errEl.count()) {
      const text = (await errEl.textContent())?.trim() ?? "auth error"
      const shot = path.join(SCREENSHOT_DIR, "signin-error.jpg")
      await page.screenshot({ path: shot, type: "jpeg", quality: 75, fullPage: true })
      return { ok: false, reason: text.slice(0, 200), shot }
    }
    await page.waitForTimeout(500)
  }
  const shot = path.join(SCREENSHOT_DIR, "signin-timeout.jpg")
  await page.screenshot({ path: shot, type: "jpeg", quality: 75, fullPage: true })
  return { ok: false, reason: "sign-in did not redirect within 15s (likely allowlist mismatch)", shot }
}

test("monitor user can sign in", async ({ page }) => {
  test.skip(!PASSWORD, "CRM_MONITOR_PASSWORD not set")
  const result = await signIn(page)
  if (!result.ok && result.shot) {
    visionResults.push({
      page: `${BASE_URL}/login`,
      severity: "error",
      description: `sign-in failed: ${result.reason}`,
      screenshot: result.shot,
    })
  }
  expect(result.ok, result.reason).toBe(true)
})

for (const gp of GATED_PAGES) {
  test(`gated page renders: ${gp}`, async ({ page }) => {
    test.skip(!PASSWORD, "CRM_MONITOR_PASSWORD not set")
    const signin = await signIn(page)
    test.skip(!signin.ok, `signin failed: ${signin.reason}`)

    test.setTimeout(4 * 60_000)
    const response = await page.goto(`${BASE_URL}${gp}`, { waitUntil: "networkidle" })
    expect(response?.ok(), `HTTP ${response?.status()} on ${gp}`).toBe(true)

    const slug = gp.replace(/[^a-z0-9]/gi, "_") || "root"
    const shots = await snapViewports(page, SCREENSHOT_DIR, slug)
    const errsBefore = visionResults.filter((v) => v.severity === "error").length
    for (let i = 0; i < shots.length; i++) {
      const verdict = await visionCheck(shots[i], `CRM ${gp} (viewport ${i + 1} of ${shots.length})`)
      for (const issue of verdict.issues) visionResults.push({ page: `${BASE_URL}${gp}#vp${i + 1}`, severity: issue.severity, description: `[vp ${i + 1}/${shots.length}] ${issue.description}`, screenshot: shots[i] })
    }
    expect(visionResults.filter((v) => v.severity === "error").length, `vision errors on ${gp}`).toBe(errsBefore)
  })
}
