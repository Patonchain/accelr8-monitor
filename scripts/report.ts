import fs from "node:fs/promises"
import { sendDailyAlert, type SuiteResult } from "../lib/alert.js"

interface PwTest {
  title: string
  results: { status: string; error?: { message: string }; attachments?: { name: string; path?: string }[] }[]
}
interface PwSpec {
  file: string
  tests: PwTest[]
}
interface PwSuite {
  title: string
  suites?: PwSuite[]
  specs?: PwSpec[]
}
interface PwReport {
  suites: PwSuite[]
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, "utf-8")
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function flattenSuites(suite: PwSuite): PwSpec[] {
  const out: PwSpec[] = []
  if (suite.specs) out.push(...suite.specs)
  for (const child of suite.suites ?? []) out.push(...flattenSuites(child))
  return out
}

function buildSuiteResults(report: PwReport): Record<string, SuiteResult> {
  const buckets: Record<string, SuiteResult> = {}
  for (const top of report.suites) {
    for (const spec of flattenSuites(top)) {
      const bucketName = spec.file.replace(/^tests\//, "").replace(/\.spec\.ts$/, "")
      buckets[bucketName] ??= { name: bucketName, passed: 0, failed: 0, failures: [], visionIssues: [] }
      for (const t of spec.tests) {
        for (const r of t.results) {
          if (r.status === "passed") buckets[bucketName].passed++
          else if (r.status === "failed" || r.status === "timedOut") {
            buckets[bucketName].failed++
            const shot = r.attachments?.find((a) => a.name === "screenshot")?.path
            buckets[bucketName].failures.push({
              test: t.title,
              error: (r.error?.message ?? "(no error message)").slice(0, 500),
              screenshot: shot,
            })
          }
        }
      }
    }
  }
  return buckets
}

async function attachVisionIssues(buckets: Record<string, SuiteResult>): Promise<void> {
  for (const name of Object.keys(buckets)) {
    const visionPath = `results/${name}-vision.json`
    const issues = await readJson<{ page: string; severity: string; description: string; screenshot: string }[]>(visionPath)
    if (issues) buckets[name].visionIssues = issues
  }
}

async function main(): Promise<void> {
  const report = await readJson<PwReport>("results/results.json")
  if (!report) {
    console.error("No results/results.json — did playwright run?")
    process.exit(1)
  }
  const buckets = buildSuiteResults(report)
  await attachVisionIssues(buckets)

  const to = process.env.ALERT_TO_EMAIL ?? "pat@joinaccelr8.com"
  const from = process.env.ALERT_FROM_EMAIL ?? "Accelr8 Monitor <monitor@joinaccelr8.com>"
  await sendDailyAlert({ to, from, results: Object.values(buckets) })
  console.log("Daily alert sent.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
