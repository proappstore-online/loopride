import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions } }))

import { acceptQuote, isEligible, isExpired, requestQuotes, secondsLeft, surgeLabel, type Quote, type QuoteRoute } from './quotes'

const route: QuoteRoute = { pickup: { label: 'A', coord: { lat: 1, lng: 2 } }, dropoff: { label: 'B', coord: { lat: 3, lng: 4 } }, distanceMeters: 5000.4, durationSeconds: 599.6 }
const quote = { id: 'q1', vehicle: 'share', expiresAt: 10_000, nearbyDrivers: 2 } as Quote

beforeEach(() => actions.call.mockReset())

describe('quote helpers', () => {
  it('derives eligibility, expiry and countdown', () => {
    expect(isEligible({ nearbyDrivers: 0 })).toBe(false)
    expect(isEligible({ nearbyDrivers: 1 })).toBe(true)
    expect(isExpired({ expiresAt: 100 }, 100)).toBe(true)
    expect(isExpired({ expiresAt: 101 }, 100)).toBe(false)
    expect(secondsLeft({ expiresAt: 1500 }, 0)).toBe(2)
    expect(secondsLeft({ expiresAt: 100 }, 500)).toBe(0)
  })

  it('labels surge only above 1x', () => {
    expect(surgeLabel(1000)).toBeNull()
    expect(surgeLabel(1250)).toBe('1.25×')
    expect(surgeLabel(1500)).toBe('1.5×')
    expect(surgeLabel(2000)).toBe('2×')
  })
})

describe('requestQuotes', () => {
  it('prices all three tiers with the routed trip and returns only this request\'s quotes', async () => {
    const created: Record<string, unknown>[] = []
    actions.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === 'create_quote') {
        created.push(params)
        return undefined
      }
      const mine = created.map((p) => ({ id: p.quote_id, vehicle_class: p.vehicle_class, distance_m: 5000, duration_s: 600, base_cents: 200, distance_cents: 1, time_cents: 2, booking_fee_cents: 150, min_adjust_cents: 0, surge_milli: 1000, total_cents: 1000, nearby_drivers: 1, expires_at: 9 }))
      return [...mine, { ...mine[0], id: 'stale-from-earlier-route' }]
    })
    const quotes = await requestQuotes(route)
    expect(created.map((p) => p.vehicle_class).sort()).toEqual(['comfort', 'share', 'xl'])
    expect(created[0]).toMatchObject({ pickup_label: 'A', pickup_lat: 1, dropoff_lng: 4, distance_m: 5000, duration_s: 600 })
    expect(new Set(created.map((p) => p.quote_id)).size).toBe(3)
    expect(quotes).toHaveLength(3)
    expect(quotes.map((q) => q.id)).not.toContain('stale-from-earlier-route')
    expect(quotes[0]).toMatchObject({ baseCents: 200, bookingFeeCents: 150, totalCents: 1000, nearbyDrivers: 1, expiresAt: 9 })
  })
})

describe('acceptQuote', () => {
  const outcome = (row: unknown) =>
    actions.call.mockImplementation(async (name: string) => (name === 'get_quote' ? (row ? [row] : []) : undefined))

  it('sends the quote with the route being viewed and the ride record', async () => {
    outcome({ status: 'accepted', ride_id: 'ride-1' })
    const result = await acceptQuote(quote, route, 'ride-1', { id: 'ride-1' })
    expect(result).toEqual({ ok: true, rideId: 'ride-1' })
    expect(actions.call).toHaveBeenCalledWith('accept_quote', { quote_id: 'q1', ride_id: 'ride-1', client_record: '{"id":"ride-1"}', pickup_lat: 1, pickup_lng: 2, dropoff_lat: 3, dropoff_lng: 4, distance_m: 5000 })
  })

  it.each([
    [{ status: 'expired', ride_id: null }, 'expired'],
    [{ status: 'superseded', ride_id: null }, 'changed'],
    [{ status: 'pending', ride_id: null }, 'unavailable'],
    [{ status: 'accepted', ride_id: 'someone-elses' }, 'unavailable'],
    [null, 'unavailable'],
  ])('maps %j to %s', async (row, reason) => {
    outcome(row)
    expect(await acceptQuote(quote, route, 'ride-1', {})).toEqual({ ok: false, reason })
  })
})
