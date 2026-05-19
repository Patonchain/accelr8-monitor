import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Run files in parallel + tests within a file in parallel. Vision API
  // calls dominate wall time, and they're independent across tests.
  fullyParallel: true,
  retries: 1,
  workers: 3,
  reporter: [
    ["list"],
    ["json", { outputFile: "results/results.json" }],
    ["html", { outputFolder: "results/html", open: "never" }],
  ],
  outputDir: "results/artifacts",
  use: {
    viewport: { width: 1440, height: 900 },
    screenshot: { mode: "on", fullPage: false },
    video: "off",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
})
