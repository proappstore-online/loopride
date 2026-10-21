import { app } from './app'

/**
 * Driver onboarding, vehicle and approval workflow client. Server rules live
 * in the mcp.json actions (see docs/domain-model.md › Driver onboarding):
 * the DB, not this file, decides who may be available for dispatch.
 */
export type ApplicationStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended'
export type VehicleStatus = 'pending' | 'approved' | 'rejected'

export interface DriverApplication {
  status: ApplicationStatus
  fullName: string
  phone: string
  licenceNumber: string
  licenceRegion: string
  licenceExpires: string
  eligibilityConfirmed: boolean
  statusReason: string | null
}

export const EMPTY_APPLICATION: DriverApplication = {
  status: 'draft',
  fullName: '',
  phone: '',
  licenceNumber: '',
  licenceRegion: '',
  licenceExpires: '',
  eligibilityConfirmed: false,
  statusReason: null,
}

export interface DriverVehicle {
  id: string
  plate: string
  make: string
  model: string
  year: number | null
  colour: string
  seats: number | null
  vehicleClass: 'share' | 'comfort' | 'xl' | null
  status: VehicleStatus
  statusReason: string | null
}

interface AppRow {
  status: ApplicationStatus
  full_name: string | null
  phone: string | null
  licence_number: string | null
  licence_region: string | null
  licence_expires: string | null
  eligibility_confirmed: number
  status_reason: string | null
}

interface VehicleRow {
  id: string
  plate: string
  make: string
  model: string
  year: number | null
  colour: string | null
  seats: number | null
  vehicle_class: DriverVehicle['vehicleClass']
  status: VehicleStatus
  status_reason: string | null
}

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

/** What the applicant still has to provide before they can submit. Mirrors the server's submit rule. */
export function missingForSubmit(application: DriverApplication, vehicles: DriverVehicle[]): string[] {
  const missing: string[] = []
  if (!application.fullName.trim()) missing.push('Full name')
  if (!application.phone.trim()) missing.push('Phone')
  if (!application.licenceNumber.trim()) missing.push('Licence number')
  if (!application.licenceRegion.trim()) missing.push('Licence region')
  if (!application.licenceExpires.trim()) missing.push('Licence expiry')
  if (!application.eligibilityConfirmed) missing.push('Eligibility confirmation')
  if (vehicles.length === 0) missing.push('At least one vehicle')
  return missing
}

/** Whether the applicant may still edit (the server enforces this too). */
export const isEditable = (status: ApplicationStatus) => status === 'draft' || status === 'rejected'

export async function loadApplication(): Promise<DriverApplication> {
  const [row] = await call<AppRow[]>('get_my_driver_application')
  if (!row) return EMPTY_APPLICATION
  return {
    status: row.status,
    fullName: row.full_name ?? '',
    phone: row.phone ?? '',
    licenceNumber: row.licence_number ?? '',
    licenceRegion: row.licence_region ?? '',
    licenceExpires: row.licence_expires ?? '',
    eligibilityConfirmed: row.eligibility_confirmed === 1,
    statusReason: row.status_reason,
  }
}

export async function saveApplication(a: DriverApplication): Promise<void> {
  await call('save_driver_application', {
    full_name: a.fullName.trim().slice(0, 80) || null,
    phone: a.phone.trim().slice(0, 30) || null,
    licence_number: a.licenceNumber.trim().slice(0, 40) || null,
    licence_region: a.licenceRegion.trim().slice(0, 40) || null,
    licence_expires: a.licenceExpires.trim() || null,
    eligibility_confirmed: a.eligibilityConfirmed ? 1 : 0,
  })
}

export const submitApplication = () => call('submit_driver_application')

export async function loadVehicles(): Promise<DriverVehicle[]> {
  const rows = await call<VehicleRow[]>('list_my_driver_vehicles')
  return rows.map((r) => ({
    id: r.id,
    plate: r.plate,
    make: r.make,
    model: r.model,
    year: r.year,
    colour: r.colour ?? '',
    seats: r.seats,
    vehicleClass: r.vehicle_class,
    status: r.status,
    statusReason: r.status_reason,
  }))
}

export async function saveVehicle(v: Omit<DriverVehicle, 'status' | 'statusReason'>): Promise<void> {
  await call('save_driver_vehicle', {
    vehicle_id: v.id,
    plate: v.plate.trim().toUpperCase().slice(0, 20),
    make: v.make.trim().slice(0, 40),
    model: v.model.trim().slice(0, 40),
    year: v.year,
    colour: v.colour.trim().slice(0, 30) || null,
    seats: v.seats,
    vehicle_class: v.vehicleClass,
  })
}

export const deleteVehicle = (id: string) => call('delete_driver_vehicle', { vehicle_id: id })

export async function loadAvailability(): Promise<{ available: boolean; vehicleId: string | null }> {
  const [row] = await call<{ available: number; vehicle_id: string | null }[]>('get_my_driver_availability')
  return { available: row?.available === 1, vehicleId: row?.vehicle_id ?? null }
}

export const setAvailability = (available: boolean, vehicleId: string | null) =>
  call('set_driver_availability', { available: available ? 1 : 0, vehicle_id: vehicleId })

// ---- operations (PAS app role "ops") ----

export interface ApplicationSummary {
  user_id: string
  status: ApplicationStatus
  /** First initial only: full details need the ops_pii role and a logged reason. */
  initial: string | null
  phone_masked: string | null
  licence_last4: string | null
  licence_region: string | null
  licence_expires: string | null
  submitted_at: number | null
  vehicle_count: number
}

export type Decision = 'approved' | 'rejected'

/** True when the signed-in user holds the `ops` app role. The platform re-checks it on every ops action. */
export async function hasOpsRole(): Promise<boolean> {
  try {
    return await app.roles.check('ops')
  } catch {
    return false
  }
}

export const listApplications = (status?: ApplicationStatus) =>
  call<ApplicationSummary[]>('list_driver_applications', { status: status ?? null })

export const reviewApplication = (driverUserId: string, decision: Decision, reason?: string) =>
  call('review_driver_application', { driver_user_id: driverUserId, decision, reason: reason?.trim() || null })

/** Which decisions are offered for an application in a given state. Mirrors the server's transition rules. */
export function decisionsFor(status: ApplicationStatus): Decision[] {
  // Suspending and reinstating need a reason code and live in the operations console.
  if (status === 'submitted') return ['approved', 'rejected']
  return []
}
