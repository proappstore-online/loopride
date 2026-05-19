import type { Role } from '../types'

const KEY = 'loopride.role.v1'

export function getRole(): Role {
  return localStorage.getItem(KEY) === 'driver' ? 'driver' : 'rider'
}

export function setRole(role: Role): void {
  localStorage.setItem(KEY, role)
}
