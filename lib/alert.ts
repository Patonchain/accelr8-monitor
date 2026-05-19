import { Resend } from "resend"
import fs from "node:fs/promises"
import path from "node:path"

const resend = new Resend(process.env.RESEND_API_KEY)

export interface SuiteResult {
  name: string
  passed: number
  failed: number
  failures: { test: string; error: string; screenshot?: string }[]
  visionIssues: { page: string; severity: string; description: string; screenshot?: string }[]
}

interface SendOpts {
  to: string
  from: string
  results: SuiteResult[]
}

export async function sendDailyAlert({ to, from, results }: SendOpts): Promise<void> {
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0)
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0)
  const totalVisionIssues = results.reduce((sum, r) => sum + r.visionIssues.length, 0)
  const hasProblems = totalFailed > 0 || totalVisionIssues > 0

  const subject = hasProblems
    ? `[Accelr8 monitor] ${totalFailed} failed, ${totalVisionIssues} visual issues`
    : `[Accelr8 monitor] all green (${totalPassed} passed)`

  const attachments: { filename: string; content: string }[] = []
  const seen = new Set<string>()
  for (const r of results) {
    for (const f of r.failures) if (f.screenshot) await addAttachment(attachments, seen, f.screenshot)
    for (const v of r.visionIssues) if (v.screenshot) await addAttachment(attachments, seen, v.screenshot)
  }

  const html = renderHtml({ results, hasProblems, totalPassed, totalFailed, totalVisionIssues })

  await resend.emails.send({
    from,
    to,
    subject,
    html,
    attachments: attachments.length > 0 ? attachments : undefined,
  })
}

async function addAttachment(
  attachments: { filename: string; content: string }[],
  seen: Set<string>,
  filePath: string,
): Promise<void> {
  if (seen.has(filePath)) return
  seen.add(filePath)
  try {
    const data = await fs.readFile(filePath)
    attachments.push({ filename: path.basename(filePath), content: data.toString("base64") })
  } catch {
    // skip missing files silently — the html section already names them
  }
}

function renderHtml(opts: {
  results: SuiteResult[]
  hasProblems: boolean
  totalPassed: number
  totalFailed: number
  totalVisionIssues: number
}): string {
  const { results, hasProblems, totalPassed, totalFailed, totalVisionIssues } = opts
  const headline = hasProblems
    ? `<h1 style="color:#b91c1c">${totalFailed} failed · ${totalVisionIssues} visual issues · ${totalPassed} passed</h1>`
    : `<h1 style="color:#166534">All green: ${totalPassed} passed</h1>`

  const sections = results
    .map((r) => {
      const failureRows = r.failures
        .map(
          (f) => `
        <tr>
          <td style="padding:6px 12px;vertical-align:top">${escape(f.test)}</td>
          <td style="padding:6px 12px;vertical-align:top;font-family:monospace;font-size:12px;color:#7f1d1d">${escape(f.error)}</td>
          <td style="padding:6px 12px;vertical-align:top">${f.screenshot ? escape(path.basename(f.screenshot)) : ""}</td>
        </tr>`,
        )
        .join("")
      const visionRows = r.visionIssues
        .map(
          (v) => `
        <tr>
          <td style="padding:6px 12px;vertical-align:top">${escape(v.page)}</td>
          <td style="padding:6px 12px;vertical-align:top"><span style="color:${v.severity === "error" ? "#b91c1c" : "#a16207"}">${escape(v.severity)}</span> · ${escape(v.description)}</td>
          <td style="padding:6px 12px;vertical-align:top">${v.screenshot ? escape(path.basename(v.screenshot)) : ""}</td>
        </tr>`,
        )
        .join("")
      return `
      <h2 style="margin-top:24px">${escape(r.name)} · ${r.passed} passed, ${r.failed} failed</h2>
      ${r.failures.length > 0 ? `<h3>Test failures</h3><table style="border-collapse:collapse;width:100%">${failureRows}</table>` : ""}
      ${r.visionIssues.length > 0 ? `<h3>Visual issues</h3><table style="border-collapse:collapse;width:100%">${visionRows}</table>` : ""}
    `
    })
    .join("")

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:720px;margin:0 auto;padding:16px">
    ${headline}
    <p style="color:#555">Daily Accelr8 monitor run. Screenshots attached.</p>
    ${sections}
  </div>`
}

function escape(s: string | undefined | null): string {
  if (s == null) return ""
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
