import { test, expect } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"

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
  const shot = path.join(SCREENSHOT_DIR, "login.png")
  await page.screenshot({ path: shot, fullPage: true })
  const verdict = await visionCheck(shot, "CRM login page")
  for (const issue of verdict.issues) visionResults.push({ page: `${BASE_URL}/login`, ...issue, screenshot: shot })
  expect(verdict.issues.filter((i) => i.severity === "error")).toHaveLength(0)
})

test("monitor user can sign in", async ({ page }) => {
  test.skip(!PASSWORD, "CRM_MONITOR_PASSWORD not set")
  await page.goto(`${BASE_URL}/login`)
  await page.fill("input[type='email']", EMAIL)
  await page.fill("input[type='password']", PASSWORD)
  await page.locator("button[type='submit'], button:has-text('Sign in')").first().click()
  await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 30_000 })
  expect(page.url()).not.toContain("/login")
})

for (const gp of GATED_PAGES) {
  test(`gated page renders: ${gp}`, async ({ page }) => {
    test.skip(!PASSWORD, "CRM_MONITOR_PASSWORD not set")
    // sign in inline so each test is independent
    await page.goto(`${BASE_URL}/login`)
    await page.fill("input[type='email']", EMAIL)
    await page.fill("input[type='password']", PASSWORD)
    await page.locator("button[type='submit'], button:has-text('Sign in')").first().click()
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 30_000 })

    const response = await page.goto(`${BASE_URL}${gp}`, { waitUntil: "networkidle" })
    expect(response?.ok(), `HTTP ${response?.status()} on ${gp}`).toBe(true)

    const slug = gp.replace(/[^a-z0-9]/gi, "_") || "root"
    const shot = path.join(SCREENSHOT_DIR, `${slug}.png`)
    await page.screenshot({ path: shot, fullPage: true })
    const verdict = await visionCheck(shot, `CRM ${gp}`)
    for (const issue of verdict.issues) visionResults.push({ page: `${BASE_URL}${gp}`, ...issue, screenshot: shot })
    expect(verdict.issues.filter((i) => i.severity === "error"), `vision errors on ${gp}`).toHaveLength(0)
  })
}
