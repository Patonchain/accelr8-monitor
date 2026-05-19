import path from "node:path"
import fs from "node:fs/promises"
import type { Page } from "@playwright/test"

// Single viewport screenshot. Cheap, deterministic.
export async function snap(page: Page, jpegPath: string): Promise<string> {
  await page.screenshot({ path: jpegPath, fullPage: false, type: "jpeg", quality: 75 })
  return jpegPath
}

// Walk the page top-to-bottom one viewport at a time, taking a screenshot
// at each scroll position. Mirrors what a human user sees as they scroll —
// scroll-triggered animations and lazy-loaded content have a chance to
// settle between scrolls, instead of getting captured mid-render the way
// `fullPage: true` does on a single stitched composite.
//
// Returns the list of screenshot paths in viewport order (top → bottom).
//
// `containerSelector` (optional) scrolls inside a specific scrollable
// element (a modal panel, a sidebar). When set, each screenshot captures
// the page viewport but advances by scrolling within that container,
// so the visible state of the container changes shot-to-shot.
export async function snapViewports(
  page: Page,
  dir: string,
  name: string,
  opts: { maxViewports?: number; containerSelector?: string } = {},
): Promise<string[]> {
  const { maxViewports = 20, containerSelector } = opts
  await fs.mkdir(dir, { recursive: true })

  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
  const vh = viewport.height

  if (containerSelector) {
    return await snapInsideContainer(page, dir, name, vh, maxViewports, containerSelector)
  }

  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)

  const docHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
  ))

  const shots: string[] = []
  let y = 0
  let idx = 0

  while (y < docHeight && idx < maxViewports) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y)
    // Animations + lazy mounts need a beat. 600ms is enough for IO-triggered
    // reveals in practice; longer would slow the suite without payoff.
    await page.waitForTimeout(600)

    const shot = path.join(dir, `${name}-vp${String(idx).padStart(2, "0")}.jpg`)
    await page.screenshot({ path: shot, fullPage: false, type: "jpeg", quality: 75 })
    shots.push(shot)

    y += vh
    idx++
  }

  return shots
}

async function snapInsideContainer(
  page: Page,
  dir: string,
  name: string,
  vh: number,
  maxViewports: number,
  containerSelector: string,
): Promise<string[]> {
  const handle = await page.waitForSelector(containerSelector, { timeout: 5_000 })
  await page.evaluate((el) => el.scrollTo({ top: 0 }), handle)
  await page.waitForTimeout(400)

  const totalHeight: number = await page.evaluate((el) => el.scrollHeight, handle)
  const visibleHeight: number = await page.evaluate((el) => el.clientHeight, handle)
  const step = Math.max(visibleHeight - 80, vh - 80) // small overlap so nothing is cut at the seam

  const shots: string[] = []
  let y = 0
  let idx = 0

  while (idx < maxViewports) {
    await page.evaluate(([el, scrollY]) => (el as HTMLElement).scrollTo({ top: scrollY as number }), [handle, y] as const)
    await page.waitForTimeout(400)

    const shot = path.join(dir, `${name}-vp${String(idx).padStart(2, "0")}.jpg`)
    await page.screenshot({ path: shot, fullPage: false, type: "jpeg", quality: 75 })
    shots.push(shot)

    if (y + visibleHeight >= totalHeight) break
    y += step
    idx++
  }

  return shots
}
