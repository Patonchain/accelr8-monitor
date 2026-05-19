import { test, expect } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { visionCheck } from "../lib/visionCheck.js"

const BASE_URL = process.env.WEBSITE_URL ?? "https://joinaccelr8.com"
const SCREENSHOT_DIR = "results/screenshots/website"
const visionResults: { page: string; severity: string; description: string; screenshot: string }[] = []

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  await fs.writeFile("results/website-vision.json", JSON.stringify(visionResults, null, 2))
})

test("home page loads and renders", async ({ page }) => {
  const response = await page.goto(BASE_URL, { waitUntil: "networkidle" })
  expect(response?.ok(), `HTTP ${response?.status()} on ${BASE_URL}`).toBe(true)

  const shot = path.join(SCREENSHOT_DIR, "home.png")
  await page.screenshot({ path: shot, fullPage: true })

  const verdict = await visionCheck(shot, "joinaccelr8.com homepage")
  for (const issue of verdict.issues) {
    visionResults.push({ page: BASE_URL, severity: issue.severity, description: issue.description, screenshot: shot })
  }
  expect(verdict.issues.filter((i) => i.severity === "error"), "vision-flagged errors on home").toHaveLength(0)
})

test("crawl and screenshot every internal page", async ({ page }) => {
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
      const shot = path.join(SCREENSHOT_DIR, `${slug}.png`)
      await page.screenshot({ path: shot, fullPage: true })

      const verdict = await visionCheck(shot, `joinaccelr8.com${new URL(url).pathname}`)
      for (const issue of verdict.issues) {
        visionResults.push({ page: url, severity: issue.severity, description: issue.description, screenshot: shot })
      }
    })
  }
})
