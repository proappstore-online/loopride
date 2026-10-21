import { test, expect } from '@playwright/test'

const geocodeStub = async (route: import('@playwright/test').Route) => {
  const url = new URL(route.request().url())
  const query = url.searchParams.get('q') || ''
  const seed = [...query].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ lat: -33.86 + (seed % 100) * 0.001, lng: 151.2 + ((seed * 7) % 100) * 0.001, displayName: query, address: {}, type: 'point', importance: 0.5 }] }) })
}

test('on-demand rides need an account: no preview, no simulated driver', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Where to/ }).click()
  await expect(page.getByText('Sign in to ride now')).toBeVisible()
  await expect(page.getByRole('button', { name: /Request RideShare/ })).toHaveCount(0)
  await expect(page.getByText(/Jordan|\(sim\)/)).toHaveCount(0)
})

test('signed-out rider can still reserve a ride for later', async ({ context }) => {
  await context.route('**/api.proappstore.online/v1/maps/geocode**', geocodeStub)
  const rider = await context.newPage()
  await rider.goto('/')
  await rider.getByRole('button', { name: /Reserve later/ }).click()
  await rider.getByPlaceholder('Enter pickup').fill('Central Station Sydney')
  await rider.getByPlaceholder('Where are you going?').fill('Sydney Opera House')
  await rider.getByRole('button', { name: 'Reserve ride' }).click()
  await expect(rider).toHaveURL(/\/$/)
  await expect(rider.getByText('Sydney Opera House')).toBeVisible()
})

test('driver home has no simulation controls and asks signed-out visitors to sign in', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Driver', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'RideShare Drive' })).toBeVisible()
  await expect(page.getByText(/Sign in and get approved/)).toBeVisible()
  await expect(page.getByText(/\(sim\)|Accept & start trip/)).toHaveCount(0)
})

test('rider can create a recurring routine without selecting a driver', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Set a routine/ }).click()
  await expect(page.getByText('Build a routine')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true')
})
