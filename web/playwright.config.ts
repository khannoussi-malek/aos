import { defineConfig } from '@playwright/test'

// Runs against the real stack: start it first with `docker compose up -d` (console on :8090).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:8090' },
})
