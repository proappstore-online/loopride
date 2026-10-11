import { test, expect } from '@playwright/test'

const geocodeStub = async (route: import('@playwright/test').Route) => {
  const url = new URL(route.request().url())
  const query = url.searchParams.get('q') || ''
  const seed = [...query].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ lat: -33.86 + (seed % 100) * 0.001, lng: 151.2 + ((seed * 7) % 100) * 0.001, displayName: query, address: {}, type: 'point', importance: 0.5 }] }) })
}

test('rider requests an on-demand ride and sees live driver progress', async ({ context }) => {
  await context.route('**/api.proappstore.online/v1/maps/geocode**', geocodeStub)
  const rider = await context.newPage()
  await rider.goto('/')
  await rider.getByRole('button', { name: /Where to/ }).click()
  await rider.getByPlaceholder('Enter pickup').fill('Central Station Sydney')
  await rider.getByPlaceholder('Where are you going?').fill('Sydney Opera House')
  await rider.getByRole('button', { name: /Request RideShare/ }).click()
  await expect(rider).toHaveURL(/\/trip\//)
  await expect(rider.getByText(/Jordan arrives in/)).toBeVisible()

  const driver = await context.newPage()
  await driver.goto('/')
  await driver.getByRole('button', { name: 'Driver', exact: true }).click()
  await expect(driver.getByRole('heading', { name: 'RideShare Drive' })).toBeVisible()
  await driver.getByText('Sydney Opera House').click()
  await driver.getByRole('button', { name: 'Accept & start trip' }).click()
  for (let step = 0; step < 3; step += 1) await driver.getByRole('button', { name: 'Step +10% (sim)' }).click()
  await expect(rider.getByText(/Live ·/)).toBeVisible({ timeout: 5000 })
  await expect(rider.getByText('Jordan is on the way')).toBeVisible()
})

test('rider can create a recurring routine without selecting a driver', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Set a routine/ }).click()
  await expect(page.getByText('Build a routine')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true')
})
