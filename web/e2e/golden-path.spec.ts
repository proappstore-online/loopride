import { test, expect } from '@playwright/test'

const geocodeStub = async (route: import('@playwright/test').Route) => {
  const url = new URL(route.request().url())
  const q = url.searchParams.get('q') || ''
  // Deterministic coords keyed off the query so pickup and dropoff differ.
  const seed = [...q].reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const lat = -33.86 + (seed % 100) * 0.001
  const lng = 151.2 + ((seed * 7) % 100) * 0.001
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        {
          lat,
          lng,
          displayName: q,
          address: {},
          type: 'point',
          importance: 0.5,
        },
      ],
    }),
  })
}

test('rider creates a ride, driver streams position, rider sees it live', async ({ context }) => {
  await context.route('**/api.proappstore.online/v1/maps/geocode**', geocodeStub)

  const rider = await context.newPage()
  await rider.goto('/')

  // Rider creates a recurring ride.
  await rider.getByRole('button', { name: '+ New' }).click()
  await rider.getByPlaceholder('123 Home Street').fill('Central Station Sydney')
  await rider.getByPlaceholder('456 School Road').fill('Sydney Opera House')
  await rider.getByPlaceholder('e.g. Alex Smith').fill('Alex')
  await rider.getByRole('button', { name: 'Save ride' }).click()

  // Ride lands on the home list.
  await expect(rider.getByText('Central Station Sydney → Sydney Opera House')).toBeVisible()

  // Open the trip view.
  await rider.getByText('Central Station Sydney → Sydney Opera House').click()
  await expect(rider.getByText('Scheduled')).toBeVisible()
  await expect(rider.getByText('No live feed')).toBeVisible()

  // Driver tab in the same context (shares BroadcastChannel + localStorage).
  const driver = await context.newPage()
  await driver.goto('/')
  await driver.getByRole('button', { name: 'Driver' }).click()
  await expect(driver.getByText('Loopride · Driver')).toBeVisible()
  await driver.getByText('Central Station Sydney → Sydney Opera House').click()

  await driver.getByRole('button', { name: 'Start trip' }).click()
  await expect(driver.getByText(/En route ·/)).toBeVisible()

  // Advance the simulated route position a few steps.
  for (let i = 0; i < 3; i++) {
    await driver.getByRole('button', { name: 'Step +10% (sim)' }).click()
  }

  // Rider should now see the live indicator + en-route status.
  await expect(rider.getByText(/Live · /)).toBeVisible({ timeout: 5000 })
  await expect(rider.getByText('Driver en route')).toBeVisible()

  // Driver marks arrived → rider status flips.
  await driver.getByRole('button', { name: "I've arrived" }).click()
  await expect(rider.getByText('Driver has arrived')).toBeVisible()
})

test('rider empty state offers create-first-ride CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('No rides yet')).toBeVisible()
  await page.getByRole('button', { name: 'Create your first ride' }).click()
  await expect(page.getByPlaceholder('123 Home Street')).toBeVisible()
})

test('day toggle switches aria-pressed on the NewRide form', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New' }).click()
  const mon = page.getByRole('button', { name: 'Mon' })
  await expect(mon).toHaveAttribute('aria-pressed', 'true')
  await mon.click()
  await expect(mon).toHaveAttribute('aria-pressed', 'false')
})

function shareUrl(baseUrl: string, ride: object): string {
  const payload = JSON.stringify(ride)
  const b64 = Buffer.from(payload, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${baseUrl}#ride=${b64}`
}

test('driver opens a share link, ride imports, transport opens', async ({ page, baseURL }) => {
  const ride = {
    id: 'shared-ride-e2e',
    pickup: 'Pickup Street 1',
    pickupCoord: { lat: -33.87, lng: 151.21 },
    dropoff: 'Dropoff Avenue 9',
    dropoffCoord: { lat: -33.86, lng: 151.22 },
    days: ['mon', 'wed', 'fri'],
    time: '07:30',
    driverName: 'Driver Dan',
    paused: false,
    createdAt: 1,
  }
  const url = shareUrl(`${baseURL}/`, ride)
  await page.goto(url)
  await expect(page.getByText('Driving')).toBeVisible()
  await expect(page.getByText('Pickup Street 1 → Dropoff Avenue 9')).toBeVisible()
  // Hash should be cleaned up so reloads don't re-import.
  expect(await page.evaluate(() => window.location.hash)).toBe('')
})
