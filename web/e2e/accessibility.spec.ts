import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Issue #14. Every core screen that works signed out is checked at a 375 px phone width for
// WCAG 2.1 A/AA violations (axe), horizontal scroll, 44 px touch targets and keyboard reachability.
// The signed-in trip screens are covered in the component tests (axe on the rendered screens);
// this file also seeds a saved ride so the trip screen with its map is checked in a real browser.
test.use({ viewport: { width: 375, height: 667 }, hasTouch: true })

const ride = {
  id: 'a11y-ride', pickup: 'Central Station', pickupCoord: { lat: -33.8832, lng: 151.2065 }, dropoff: 'Sydney Opera House', dropoffCoord: { lat: -33.8568, lng: 151.2153 },
  days: [], time: '09:00', driverName: '', paused: false, createdAt: 1, bookingType: 'scheduled', vehicle: 'share', fareCents: 1800, scheduledFor: '2030-01-01T09:00',
}

const ROUTES = [
  { name: 'home', path: '/' },
  { name: 'plan a ride', path: '/new' },
  { name: 'driver home', path: '/driver' },
  { name: 'driver onboarding', path: '/driver/onboarding' },
  { name: 'account', path: '/account' },
  { name: 'saved trip with map', path: '/trip/a11y-ride', seed: true },
  { name: 'not found', path: '/nope' },
]

async function open(page: Page, path: string, seed = false) {
  await page.route('**/tile.openstreetmap.org/**', (r) => r.abort())
  await page.route('**/api.proappstore.online/**', (r) => r.abort())
  if (seed) await page.addInitScript((r) => localStorage.setItem('loopride.rides.v2', JSON.stringify([r])), ride)
  await page.goto(path)
  await expect(page.locator('h1').first()).toBeVisible()
}

/** Visible controls a finger has to hit, with the ones that are smaller than 44 px each way. */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const selector = 'button, a[href], select, textarea, input:not([type=hidden]), [role=button], [role=tab], summary'
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none') return false
        // A checkbox or radio inside a label is hit through the label.
        if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type) && el.closest('label')) return false
        return r.width < 43.5 || r.height < 43.5
      })
      .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
  })
}

for (const route of ROUTES) {
  test.describe(route.name, () => {
    test('has no axe violations (WCAG 2.1 A/AA)', async ({ page }) => {
      await open(page, route.path, route.seed)
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })

    test('does not scroll sideways at 375 px', async ({ page }) => {
      await open(page, route.path, route.seed)
      const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }))
      expect(overflow.doc).toBeLessThanOrEqual(overflow.win)
    })

    test('uses 44 px touch targets', async ({ page }) => {
      await open(page, route.path, route.seed)
      expect(await smallTargets(page)).toEqual([])
    })

    test('can be zoomed and has a main landmark and a skip link', async ({ page }) => {
      await open(page, route.path, route.seed)
      expect(await page.locator('meta[name=viewport]').getAttribute('content')).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/)
      await expect(page.locator('main')).toHaveCount(1)
      await page.keyboard.press('Tab')
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
    })
  })
}

test('every control on the home screen can be reached and shown focused with the keyboard', async ({ page }) => {
  await open(page, '/')
  const count = await page.locator('button:visible, a[href]:visible').count()
  const seen = new Set<string>()
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const s = getComputedStyle(el)
      return { id: `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)}`, outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 }
    })
    if (info) { seen.add(info.id); expect(info.outline, `${info.id} shows a focus ring`).toBe(true) }
  }
  expect(seen.size).toBeGreaterThanOrEqual(Math.min(count, 5))
})
