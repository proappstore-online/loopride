import { test, expect, hasSession } from '../fixtures';

// Live smoke against the deployed app. tsc + a green build can't tell you the
// app boots — this opens it in a real browser and checks the rider home mounts
// without crashing. QA agents add per-feature specs alongside this file; they
// run against the same live deploy with the same signed-in fixture.
test('rider home boots without crashing', async ({ app, pageErrors }) => {
  await expect(app.getByRole('heading', { name: 'RideShare', level: 1 })).toBeVisible();
  await expect(app.getByRole('button', { name: /Where to\?/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('signed-out: offers sign-in', async ({ app }) => {
  test.skip(hasSession, 'fixture session configured — covered by the signed-in test');
  await expect(app.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

test('signed-in: lands past the sign-in prompt', async ({ app }) => {
  test.skip(!hasSession, 'no E2E fixture session configured (set PAS_E2E_SESSION_TOKEN)');
  await expect(app.getByRole('heading', { name: 'RideShare', level: 1 })).toBeVisible();
  await expect(app.getByRole('button', { name: /^Sign in with/ })).toHaveCount(0);
});
