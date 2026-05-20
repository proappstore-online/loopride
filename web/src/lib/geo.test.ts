import { describe, expect, it } from 'vitest'
import { interpolate } from './geo'

const a = { lat: 0, lng: 0 }
const b = { lat: 10, lng: 20 }

describe('interpolate', () => {
  it('returns a at t=0', () => {
    expect(interpolate(a, b, 0)).toEqual({ lat: 0, lng: 0 })
  })

  it('returns b at t=1', () => {
    expect(interpolate(a, b, 1)).toEqual({ lat: 10, lng: 20 })
  })

  it('returns midpoint at t=0.5', () => {
    expect(interpolate(a, b, 0.5)).toEqual({ lat: 5, lng: 10 })
  })

  it('clamps t < 0 to 0', () => {
    expect(interpolate(a, b, -0.5)).toEqual({ lat: 0, lng: 0 })
  })

  it('clamps t > 1 to 1', () => {
    expect(interpolate(a, b, 2)).toEqual({ lat: 10, lng: 20 })
  })
})
