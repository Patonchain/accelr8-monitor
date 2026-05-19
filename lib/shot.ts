import type { Page } from "@playwright/test"

// Anthropic accepts up to ~5MB base64 → ~3.75MB binary. Long fullPage PNGs
// blow past that on content-heavy pages. JPEG quality 75 typically lands
// in the 200-800KB range even for very tall pages.
export async function snap(page: Page, jpegPath: string): Promise<string> {
  await page.screenshot({ path: jpegPath, fullPage: true, type: "jpeg", quality: 75 })
  return jpegPath
}
