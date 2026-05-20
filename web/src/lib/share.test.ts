import { describe, expect, it, beforeEach } from 'vitest'
import { clearShareHash, decodeShareHash, encodeShareUrl } from './share'
import type { RecurringRide } from '../types'

const ride: RecurringRide = {
  id: 'ride-share',
  pickup: 'Central Station',
  pickupCoord: { lat: -33.8688, lng: 151.2093 },
  dropoff: 'Sydney Opera House',
  dropoffCoord: { lat: -33.857, lng: 151.215 },
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: 1234,
}

describe('share', () => {
  beforeEach(() => {
    history.replaceState(null, '', window.location.pathname)
  })

  it('encode → decode round-trips the ride exactly', () => {
    const url = encodeShareUrl(ride, 'http://example.test/')
    expect(url.startsWith('http://example.test/#ride=')).toBe(true)
    const hash = '#' + url.split('#')[1]
    expect(decodeShareHash(hash)).toEqual(ride)
  })

  it('decode rejects empty hash', () => {
    expect(decodeShareHash('')).toBeNull()
    expect(decodeShareHash('#other=foo')).toBeNull()
  })

  it('decode rejects malformed base64', () => {
    expect(decodeShareHash('#ride=not_valid_base64@@@')).toBeNull()
  })

  it('decode rejects valid base64 that is not a ride', () => {
    const garbage = btoa(JSON.stringify({ foo: 'bar' }))
    expect(decodeShareHash('#ride=' + garbage)).toBeNull()
  })

  it('round-trips UTF-8 characters in addresses (emoji + accents)', () => {
    const utf8Ride = { ...ride, pickup: '東京タワー 🗼', dropoff: 'Café — Zürich' }
    const url = encodeShareUrl(utf8Ride, 'http://example.test/')
    const hash = '#' + url.split('#')[1]
    expect(decodeShareHash(hash)).toEqual(utf8Ride)
  })

  it('clearShareHash removes only the #ride= hash', () => {
    history.replaceState(null, '', window.location.pathname + '#ride=abc')
    clearShareHash()
    expect(window.location.hash).toBe('')
  })

  it('clearShareHash leaves non-ride hashes intact', () => {
    history.replaceState(null, '', window.location.pathname + '#fas_session=xyz')
    clearShareHash()
    expect(window.location.hash).toBe('#fas_session=xyz')
  })
})
