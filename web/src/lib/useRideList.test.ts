import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { RecurringRide } from '../types'
import { EVENTS, STORAGE_KEYS } from './constants'

const { listRides } = vi.hoisted(() => ({ listRides: vi.fn() }))
vi.mock('../storage', () => ({ listRides }))

import { useRideList } from './useRideList'

const ride = (id: string): RecurringRide => ({
  id,
  pickup: 'A',
  pickupCoord: null,
  dropoff: 'B',
  dropoffCoord: null,
  days: ['mon'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: 1,
})

const fireStorage = (key: string | null) =>
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key }))
  })

beforeEach(() => {
  listRides.mockReset()
  listRides.mockReturnValue([ride('a')])
})

describe('useRideList', () => {
  it('refreshes when another tab writes the rides key', () => {
    const { result } = renderHook(() => useRideList())
    expect(result.current.map((r) => r.id)).toEqual(['a'])

    listRides.mockReturnValue([ride('a'), ride('b')])
    fireStorage(STORAGE_KEYS.rides)

    expect(result.current.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useRideList())
    const before = result.current
    const calls = listRides.mock.calls.length

    listRides.mockReturnValue([ride('z')])
    fireStorage(STORAGE_KEYS.role)
    fireStorage('some.other.key')

    expect(listRides.mock.calls.length).toBe(calls)
    expect(result.current).toBe(before)
  })

  it('refreshes when another tab clears localStorage (key === null)', () => {
    const { result } = renderHook(() => useRideList())

    listRides.mockReturnValue([])
    fireStorage(null)

    expect(result.current).toEqual([])
  })

  it('still refreshes on the same-tab ridesChanged event', () => {
    const { result } = renderHook(() => useRideList())

    listRides.mockReturnValue([ride('c')])
    act(() => {
      window.dispatchEvent(new Event(EVENTS.ridesChanged))
    })

    expect(result.current.map((r) => r.id)).toEqual(['c'])
  })

  it('removes both listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useRideList())
    unmount()

    expect(remove).toHaveBeenCalledWith('storage', expect.any(Function))
    expect(remove).toHaveBeenCalledWith(EVENTS.ridesChanged, expect.any(Function))

    const calls = listRides.mock.calls.length
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.rides }))
    expect(listRides.mock.calls.length).toBe(calls)
    remove.mockRestore()
  })
})
