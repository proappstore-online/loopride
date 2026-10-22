import axe from 'axe-core'
import { expect } from 'vitest'

/**
 * Run axe (WCAG 2.1 A/AA) over rendered markup. happy-dom has no layout or colour engine, so the
 * colour-contrast and region rules are off here; the Playwright spec (e2e/accessibility.spec.ts)
 * checks both in a real browser.
 */
export async function expectNoA11yViolations(container: Element = document.body) {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(' | ')}`)).toEqual([])
}
