import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions } }))

import { acceptOffer, declineOffer, getDispatchStatus, isTerminal, kmFromSquared, loadOffers, publishLocation, runDispatch } from './dispatch'

beforeEach(() => actions.call.mockReset())

const row = (status: string, extra = {}) => [{ status, attempts: 1, offer_status: null, driver_name: null, plate: null, ...extra }]

describe('dispatch client', () => {
  it('converts squared distances and knows terminal states', () => {
    expect(kmFromSquared(25)).toBe(5)
    expect(kmFromSquared(null)).toBeNull()
    expect(['searching', 'matched', 'no_driver', 'cancelled'].map((s) => isTerminal(s as never))).toEqual([false, true, true, true])
  })

  it('maps status and offers', async () => {
    actions.call.mockResolvedValueOnce(row('matched', { offer_status: 'accepted', driver_name: 'Dana', plate: 'RS-1' }))
    expect(await getDispatchStatus('r1')).toEqual({ state: 'matched', attempts: 1, offerStatus: 'accepted', driverName: 'Dana', plate: 'RS-1' })
    actions.call.mockResolvedValueOnce([])
    expect(await getDispatchStatus('r1')).toBeNull()
    actions.call.mockResolvedValueOnce([{ rider_id: 'u', request_id: 'r1', status: 'offered', distance_km2: 4, expires_at: 9, pickup_label: 'A', dropoff_label: 'B', vehicle_class: null, fare_cents: 900 }])
    expect(await loadOffers()).toEqual([{ riderId: 'u', requestId: 'r1', status: 'offered', km: 2, expiresAt: 9, pickup: 'A', dropoff: 'B', vehicleClass: null, fareCents: 900 }])
  })

  it('sends server parameter names', async () => {
    await acceptOffer({ riderId: 'u', requestId: 'r1' })
    expect(actions.call).toHaveBeenLastCalledWith('accept_offer', { rider_id: 'u', request_id: 'r1' })
    await declineOffer({ riderId: 'u', requestId: 'r1' })
    expect(actions.call).toHaveBeenLastCalledWith('decline_offer', { rider_id: 'u', request_id: 'r1' })
    await publishLocation(1, 2, 5)
    expect(actions.call).toHaveBeenLastCalledWith('update_driver_location', { lat: 1, lng: 2, service_radius_km: 5 })
  })

  it('runDispatch ticks and polls until the search ends', async () => {
    const states = ['searching', 'searching', 'matched']
    actions.call.mockImplementation(async (name: string) => (name === 'get_dispatch_status' ? row(states.shift()!) : undefined))
    const sleep = vi.fn(async () => undefined)
    const seen: string[] = []
    const final = await runDispatch('r1', { sleep, onUpdate: (s) => seen.push(s.state) })
    expect(final?.state).toBe('matched')
    expect(seen).toEqual(['searching', 'searching', 'matched'])
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(actions.call.mock.calls.filter((c) => c[0] === 'dispatch_tick')).toHaveLength(3)
  })

  it('runDispatch stops on abort and when the status disappears', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await runDispatch('r1', { signal: controller.signal })).toBeNull()
    expect(actions.call).not.toHaveBeenCalled()
    actions.call.mockResolvedValue([])
    expect(await runDispatch('r1', { sleep: async () => undefined })).toBeNull()
  })
})
