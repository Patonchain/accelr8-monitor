import Anthropic from "@anthropic-ai/sdk"
import fs from "node:fs/promises"

const VISION_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY)
const anthropic = VISION_ENABLED ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null

export interface VisionIssue {
  severity: "error" | "warning"
  description: string
}

export interface VisionResult {
  ok: boolean
  issues: VisionIssue[]
  rawResponse: string
}

const SYSTEM_PROMPT = `You are reviewing screenshots from a daily automated monitor of accelr8 web surfaces. \
You receive one screenshot at a time plus a short context label naming the page.

Your job: flag VISIBLE problems that a human visitor would notice immediately. Examples of issues to flag:
- HTTP error pages (404, 500, "Application error")
- Visible "undefined", "null", "[object Object]", raw error text in the UI
- Layouts that are clearly broken (overlapping elements, content cut off, hero collapsed, content missing)
- Images failing to load (broken-image icon, empty boxes where images should be)
- Console-style error overlays visible on the page
- Blank/white pages where content should be

Do NOT flag:
- Normal content changes (a different room title, new copy, design tweaks)
- Acceptable empty states (empty inbox, no results found)
- Loading spinners (the next screenshot would catch a hang)
- Style preferences

Return ONLY a JSON object with this shape:
{ "ok": boolean, "issues": [{ "severity": "error" | "warning", "description": "short, specific" }] }

If everything looks fine, return { "ok": true, "issues": [] }.`

export async function visionCheck(
  screenshotPath: string,
  pageLabel: string,
): Promise<VisionResult> {
  if (!anthropic) {
    return { ok: true, issues: [], rawResponse: "(vision disabled — no ANTHROPIC_API_KEY)" }
  }
  const data = await fs.readFile(screenshotPath)
  const base64 = data.toString("base64")

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: base64 },
          },
          { type: "text", text: `Page: ${pageLabel}\n\nReturn the JSON verdict.` },
        ],
      },
    ],
  })

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { ok: true, issues: [], rawResponse: text }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { ok: boolean; issues: VisionIssue[] }
    return { ...parsed, rawResponse: text }
  } catch {
    return { ok: true, issues: [], rawResponse: text }
  }
}
