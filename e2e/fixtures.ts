import { test as base, expect, type Page } from '@playwright/test';

// A fixture session token for a throwaway E2E user, injected by the CI e2e job
// (PAS_E2E_SESSION_TOKEN). It is a normal, revocable platform session — NOT a
// bypass: the app signs in via the SDK's real OAuth-callback path below.
const SESSION_TOKEN = process.env.E2E_SESSION_TOKEN || '';
export const hasSession = SESSION_TOKEN.length > 0;

// Navigate with a few retries so a just-provisioned custom domain that is still
// warming up (Cloudflare first-deploy propagation) does not read as a failure.
async function gotoWithRetry(page: Page, path: string) {
  let lastErr: unknown;
  // ~60s budget: a brand-new app's custom domain can still be warming up
  // (Cloudflare first-deploy DNS/route propagation) for the first deploy.
  for (let i = 0; i < 10; i++) {
    try {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (res && res.status() < 500) return;
      lastErr = new Error('HTTP ' + (res ? res.status() : 'no response'));
    } catch (e) {
      lastErr = e;
    }
    await page.waitForTimeout(6000);
  }
  throw lastErr;
}

// 'app' fixture: a Page already past the sign-in wall when a fixture session is
// configured. The SDK's auth.init() reads the session from the URL hash, calls
// /v1/auth/me, persists the session, and clears the hash — the SAME path a real
// GitHub/Google OAuth callback uses. Without a token, returns an un-authed page
// (the sign-in screen) so unauthenticated smokes still run.
export const test = base.extend<{ app: Page; pageErrors: string[] }>({
  pageErrors: async ({}, use) => { await use([]); },
  app: async ({ page, pageErrors }, use) => {
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const target = hasSession ? '/#pas_session=' + encodeURIComponent(SESSION_TOKEN) : '/';
    await gotoWithRetry(page, target);
    // Bounded: the app keeps connections open (live tracking), so the page may
    // never reach networkidle. Specs assert on real elements, which auto-wait.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await use(page);
  },
});

export { expect };
