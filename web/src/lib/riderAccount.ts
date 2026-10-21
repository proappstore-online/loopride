import { app } from './app'
import { KV_KEYS } from './constants'
import { clearLocalRides, listRides } from '../storage'
import type { RecurringRide } from '../types'

/**
 * Rider account: profile, contact preferences, saved places, trip history,
 * data export and deletion. All server state is in the PAS DB behind caller-
 * scoped actions (mcp.json). See docs/domain-model.md › Rider account.
 *
 * Anonymous riders (no sign-in) can still request rides; those live only in
 * this browser's localStorage and are never sent to the DB. Signing in
 * uploads them (syncRides → save_ride), which is the account-upgrade path.
 */
export interface RiderProfile {
  displayName: string
  phone: string
  notifyEmail: boolean
  notifySms: boolean
  notifyTripUpdates: boolean
}

export const DEFAULT_PROFILE: RiderProfile = {
  displayName: '',
  phone: '',
  notifyEmail: false,
  notifySms: false,
  notifyTripUpdates: true,
}

export interface SavedPlace {
  id: string
  label: string
  address: string
  lat: number | null
  lng: number | null
}

export type TripBucket = 'active' | 'scheduled' | 'completed' | 'cancelled'
export const TRIP_BUCKETS: { id: TripBucket; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
]

export interface HistoryItem {
  id: string
  bookingType: 'now' | 'scheduled' | 'recurring'
  bucket: TripBucket
  pickup: string
  dropoff: string
  fareCents: number | null
  when: number
}

interface HistoryRow {
  id: string
  booking_type: 'now' | 'scheduled' | 'recurring'
  status: 'open' | 'matched' | 'paused' | 'completed' | 'cancelled'
  pickup_label: string
  dropoff_label: string
  trip_status: string | null
  fare_cents: number | null
  updated_at: number
}

/** Which tab a DB ride request belongs in. */
export function bucketForRow(row: Pick<HistoryRow, 'booking_type' | 'status' | 'trip_status'>): TripBucket {
  if (row.status === 'cancelled' || row.trip_status === 'cancelled') return 'cancelled'
  if (row.status === 'completed' || row.trip_status === 'completed') return 'completed'
  if (row.trip_status === 'en_route' || row.trip_status === 'arrived') return 'active'
  return row.booking_type === 'now' ? 'active' : 'scheduled'
}

/** Same grouping for a local (offline / anonymous) ride. Cancelled rides are deleted locally, so none appear. */
export function bucketForLocalRide(ride: RecurringRide): TripBucket {
  if (ride.status === 'completed') return 'completed'
  if (ride.status === 'en-route' || ride.status === 'arrived') return 'active'
  // Pre-RideShare records have no bookingType and were all weekly routines.
  return (ride.bookingType ?? 'recurring') === 'now' ? 'active' : 'scheduled'
}

export function localHistory(): HistoryItem[] {
  return listRides().map((ride) => ({
    id: ride.id,
    bookingType: ride.bookingType ?? 'recurring',
    bucket: bucketForLocalRide(ride),
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    fareCents: ride.fareCents ?? null,
    when: ride.createdAt,
  }))
}

export async function loadHistory(): Promise<HistoryItem[]> {
  const rows = await app.actions.call<HistoryRow[]>('list_trip_history', { limit: 200 })
  return rows.map((row) => ({
    id: row.id,
    bookingType: row.booking_type,
    bucket: bucketForRow(row),
    pickup: row.pickup_label,
    dropoff: row.dropoff_label,
    fareCents: row.fare_cents,
    when: row.updated_at,
  }))
}

export function groupHistory(items: HistoryItem[]): Record<TripBucket, HistoryItem[]> {
  const groups: Record<TripBucket, HistoryItem[]> = { active: [], scheduled: [], completed: [], cancelled: [] }
  for (const item of items) groups[item.bucket].push(item)
  return groups
}

interface ProfileRow {
  display_name: string | null
  phone: string | null
  notify_email: number
  notify_sms: number
  notify_trip_updates: number
}

export async function loadProfile(): Promise<RiderProfile> {
  const [row] = await app.actions.call<ProfileRow[]>('get_rider_profile', {})
  if (!row) return DEFAULT_PROFILE
  return {
    displayName: row.display_name ?? '',
    phone: row.phone ?? '',
    notifyEmail: row.notify_email === 1,
    notifySms: row.notify_sms === 1,
    notifyTripUpdates: row.notify_trip_updates === 1,
  }
}

export async function saveProfile(profile: RiderProfile): Promise<void> {
  await app.actions.call('save_rider_profile', {
    display_name: profile.displayName.trim().slice(0, 80) || null,
    phone: profile.phone.trim().slice(0, 30) || null,
    notify_email: profile.notifyEmail ? 1 : 0,
    notify_sms: profile.notifySms ? 1 : 0,
    notify_trip_updates: profile.notifyTripUpdates ? 1 : 0,
  })
}

export async function loadPlaces(): Promise<SavedPlace[]> {
  return app.actions.call<SavedPlace[]>('list_saved_places', {})
}

export async function savePlace(place: SavedPlace): Promise<void> {
  await app.actions.call('save_place', {
    place_id: place.id,
    label: place.label.trim().slice(0, 40),
    address: place.address.trim().slice(0, 200),
    lat: place.lat,
    lng: place.lng,
  })
}

export async function deletePlace(id: string): Promise<void> {
  await app.actions.call('delete_place', { place_id: id })
}

/** Everything the DB holds about the rider, as one JSON-serialisable document. */
export async function exportAccountData(): Promise<Record<string, unknown>> {
  const [profile, places, rideRequests, trips, tripTransitions] = await Promise.all([
    app.actions.call('get_rider_profile', {}),
    app.actions.call('list_saved_places', {}),
    app.actions.call('export_ride_requests', {}),
    app.actions.call('export_trips', {}),
    app.actions.call('export_trip_transitions', {}),
  ])
  return {
    exportedAt: new Date().toISOString(),
    userId: app.auth.user?.id ?? null,
    profile,
    savedPlaces: places,
    rideRequests,
    trips,
    tripTransitions,
  }
}

/** Erase the rider's DB rows, synced KV copy and local cache. Does not delete the platform login. */
export async function eraseRiderData(): Promise<void> {
  // Two actions: the platform limits one batch to 25 statements. Both are idempotent, so a failure part-way is safe to retry.
  await app.actions.call('delete_my_rider_data', {})
  await app.actions.call('delete_my_driver_data', {})
  await app.kv.delete(KV_KEYS.rides)
  clearLocalRides()
}
