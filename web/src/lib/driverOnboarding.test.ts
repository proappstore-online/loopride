import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions, roles } = vi.hoisted(() => ({ actions: { call: vi.fn() }, roles: { check: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions, roles } }))

import {
  EMPTY_APPLICATION,
  decisionsFor,
  hasOpsRole,
  isEditable,
  loadApplication,
  missingForSubmit,
  reviewApplication,
  saveApplication,
  saveVehicle,
  setAvailability,
  type DriverVehicle,
} from './driverOnboarding'

beforeEach(() => {
  actions.call.mockReset()
  roles.check.mockReset()
})

const complete = { ...EMPTY_APPLICATION, fullName: 'D', phone: '1', licenceNumber: 'L', licenceRegion: 'R', licenceExpires: '2030-01-01', eligibilityConfirmed: true }
const vehicle = { id: 'v' } as DriverVehicle

describe('driver onboarding client', () => {
  it('lists exactly what is missing before submit', () => {
    expect(missingForSubmit(EMPTY_APPLICATION, [])).toEqual(['Full name', 'Phone', 'Licence number', 'Licence region', 'Licence expiry', 'Eligibility confirmation', 'At least one vehicle'])
    expect(missingForSubmit(complete, [])).toEqual(['At least one vehicle'])
    expect(missingForSubmit(complete, [vehicle])).toEqual([])
  })

  it('only drafts and rejected applications are editable', () => {
    expect(['draft', 'rejected', 'submitted', 'approved', 'suspended'].map((s) => isEditable(s as never))).toEqual([true, true, false, false, false])
  })

  it('offers only valid decisions per state', () => {
    expect(decisionsFor('submitted')).toEqual(['approved', 'rejected'])
    expect(decisionsFor('approved')).toEqual(['suspended'])
    expect(decisionsFor('suspended')).toEqual(['approved'])
    expect(decisionsFor('draft')).toEqual([])
    expect(decisionsFor('rejected')).toEqual([])
  })

  it('maps the stored application, and defaults when none exists', async () => {
    actions.call.mockResolvedValueOnce([])
    expect(await loadApplication()).toEqual(EMPTY_APPLICATION)
    actions.call.mockResolvedValueOnce([{ status: 'rejected', full_name: 'D', phone: null, licence_number: 'L', licence_region: 'R', licence_expires: '2030-01-01', eligibility_confirmed: 1, status_reason: 'blurry' }])
    expect(await loadApplication()).toMatchObject({ status: 'rejected', fullName: 'D', phone: '', eligibilityConfirmed: true, statusReason: 'blurry' })
  })

  it('sends trimmed values, nulls for blanks and 0/1 flags', async () => {
    await saveApplication({ ...complete, fullName: '  D ', phone: ' ', eligibilityConfirmed: false })
    expect(actions.call).toHaveBeenCalledWith('save_driver_application', expect.objectContaining({ full_name: 'D', phone: null, eligibility_confirmed: 0 }))
    await saveVehicle({ id: 'v1', plate: ' ab-1 ', make: 'T', model: 'C', year: null, colour: '', seats: 4, vehicleClass: null })
    expect(actions.call).toHaveBeenCalledWith('save_driver_vehicle', expect.objectContaining({ vehicle_id: 'v1', plate: 'AB-1', colour: null, seats: 4 }))
  })

  it('sends availability and review calls with the server\'s parameter names', async () => {
    await setAvailability(true, 'v1')
    expect(actions.call).toHaveBeenCalledWith('set_driver_availability', { available: 1, vehicle_id: 'v1' })
    await reviewApplication('u1', 'rejected', '  bad photo ')
    expect(actions.call).toHaveBeenCalledWith('review_driver_application', { driver_user_id: 'u1', decision: 'rejected', reason: 'bad photo' })
    await reviewApplication('u1', 'approved')
    expect(actions.call).toHaveBeenLastCalledWith('review_driver_application', { driver_user_id: 'u1', decision: 'approved', reason: null })
  })

  it('treats a failed role lookup as no ops access', async () => {
    roles.check.mockResolvedValueOnce(true)
    expect(await hasOpsRole()).toBe(true)
    roles.check.mockRejectedValueOnce(new Error('offline'))
    expect(await hasOpsRole()).toBe(false)
  })
})
