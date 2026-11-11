import { expect, test } from '@playwright/test'

test.afterEach(async ({ request }) => {
  await request.post('/api/commands', { data: { name: 'CLEAR_FAULTS' } })   // leave the vehicle nominal
})

test('cabin leak raises an alarm that a controller can acknowledge', async ({ page }) => {
  page.on('dialog', (d) => d.accept())                // confirm "Send INJECT_FAULT leak?"
  await page.goto('/')
  await expect(page.getByTestId('signal')).toHaveText('SIGNAL')
  await expect(page.getByTestId('param-cabin_kpa')).toContainText('NOMINAL')

  await page.getByRole('button', { name: 'leak' }).click()
  await expect(page.locator('.cmds')).toContainText(/INJECT_FAULT leak\s*verified/, { timeout: 5_000 })

  // 0.4 kPa/s from ~101.3 crosses the 97 kPa yellow limit in about 11 s
  await expect(page.getByTestId('param-cabin_kpa')).toContainText('YELLOW', { timeout: 20_000 })
  const alarm = page.getByTestId('alarm').filter({ hasText: 'Cabin pressure YELLOW' }).first()
  await expect(alarm).toBeVisible()

  await alarm.getByRole('button', { name: 'Ack' }).click()
  await expect(alarm).toHaveClass(/acked/)
})
