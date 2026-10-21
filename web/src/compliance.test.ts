// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Static guard for the payment architecture decision (docs/adr/0001-*): the browser
// bundle must never collect, hold or transmit card data or payment credentials.
const ROOT = join(__dirname, '..')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') files(full, out)
    } else out.push(full)
  }
  return out
}

const source = files(join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')

describe('payment compliance', () => {
  it('has source to scan', () => {
    expect(source.length).toBeGreaterThan(20)
  })

  it('loads no payment SDK or non-platform script', () => {
    // The only external script is the platform's own (analytics.js on api.proappstore.online).
    const external = [...html.matchAll(/<script[^>]+src=["'](https?:[^"']+)["']/gi)].map((m) => new URL(m[1]).hostname)
    for (const host of external) expect(host).toMatch(/(^|\.)proappstore\.online$/)
    for (const f of source) expect(readFileSync(f, 'utf8'), f).not.toMatch(/js\.stripe\.com|stripe-js|@stripe\/|paypal|braintree|adyen|square(up)?\.com/i)
  })

  it('has no card, bank or credential input, field or key anywhere in the app source', () => {
    for (const f of source) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/autocomplete=["']cc-/i)
      expect(text, f).not.toMatch(/\b(card[_ -]?number|cvc|cvv|iban|routing[_ -]?number|account[_ -]?number)\b/i)
      expect(text, f).not.toMatch(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/)
      expect(text, f).not.toMatch(/whsec_[A-Za-z0-9]+/)
    }
  })

  it('does not use the proxy to reach a payment provider from the browser', () => {
    for (const f of source) expect(readFileSync(f, 'utf8'), f).not.toMatch(/proxy\.fetch\([^)]*(stripe|paypal|payment)/i)
  })

  it('does not gate any feature behind a payment or an in-app purchase (PAS rule 4)', () => {
    for (const f of source) expect(readFileSync(f, 'utf8'), f).not.toMatch(/openCheckout|createPaymentIntent|confirmPayment|payment_method/)
  })
})
