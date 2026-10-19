import { test, expect } from '../fixtures';

// RideShare feature flows against the live deploy. Owned by the QA agent:
// each Agent Teams ticket that changes a flow updates or adds a spec here, and
// the Deploy to R2 e2e job must pass before the ticket's deploy completes.

test('rider: "Where to?" opens trip planning and Back returns home', async ({ app, pageErrors }) => {
  await app.getByRole('button', { name: /Where to\?/ }).click();
  await expect(app.getByRole('heading', { name: 'Plan your ride', level: 1 })).toBeVisible();
  await expect(app.getByTestId('pickup-input')).toBeVisible();
  await expect(app.getByTestId('dropoff-input')).toBeVisible();
  await app.getByRole('button', { name: 'Back' }).click();
  await expect(app.getByRole('heading', { name: 'RideShare', level: 1 })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('role toggle: switches to driver mode and back', async ({ app, pageErrors }) => {
  await app.getByRole('button', { name: 'Driver', exact: true }).click();
  await expect(app).toHaveURL(/\/driver$/);
  await expect(app.getByRole('heading', { name: /RideShare\s*Drive/, level: 1 })).toBeVisible();
  await app.getByRole('button', { name: 'Rider', exact: true }).click();
  await expect(app.getByRole('button', { name: /Where to\?/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
