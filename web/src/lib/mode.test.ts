import { describe, expect, it } from 'vitest'
import { getRole, setRole } from './mode'

describe('mode', () => {
  it('defaults to rider when nothing stored', () => {
    expect(getRole()).toBe('rider')
  })

  it('round-trips driver role through localStorage', () => {
    setRole('driver')
    expect(getRole()).toBe('driver')
    setRole('rider')
    expect(getRole()).toBe('rider')
  })

  it('returns rider for unrecognized stored values', () => {
    localStorage.setItem('loopride.role.v1', 'bogus')
    expect(getRole()).toBe('rider')
  })
})
