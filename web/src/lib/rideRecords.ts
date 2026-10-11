import { app } from './app'
import type { RecurringRide } from '../types'

/**
 * Bridge from the client ride record (localStorage + KV) to the PAS DB domain
 * model (migrations.json + the `save_ride` / `cancel_ride` actions in mcp.json).
 * See docs/domain-model.md for entities, ownership, lifecycles and IDs.
 *
 * Every id is derived from the ride itself, and `save_ride` is an upsert, so
 * replaying the same ride — the sign-in migration of existing local/KV rides,
 * or a retry — never duplicates rows. The full client record is kept in
 * `ride_requests.client_record`, so nothing a legacy ride carried is lost.
 */
export interface SaveRideParams {
  request_id: string
  booking_type: 'now' | 'scheduled' | 'recurring'
  request_status: 'open' | 'matched' | 'paused' | 'completed'
  pickup_label: string
  pickup_lat: number | null
  pickup_lng: number | null
  dropoff_label: string
  dropoff_lat: number | null
  dropoff_lng: number | null
  recurring_days: string | null
  pickup_time: string | null
  scheduled_for: string | null
  vehicle_class: string | null
  requested_at: number | null
  client_record: string
  created_at: number
  driver_id: string | null
  driver_name: string | null
  driver_rating: number | null
  vehicle_id: string | null
  vehicle_plate: string | null
  quote_id: string | null
  fare_cents: number | null
  eta_minutes: number | null
  assignment_id: string | null
  trip_id: string | null
  trip_status: 'en_route' | 'arrived' | 'completed' | null
  trip_event_id: string | null
}

const slug = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-')

export function rideToRecords(ride: RecurringRide): SaveRideParams {
  const driverName = ride.driverName.trim()
  const driverId = driverName ? `drv_${slug(driverName)}` : null
  const plate = ride.driverPlate?.trim()
  const vehicleId = driverId && plate ? `veh_${slug(plate)}` : null
  const tripStatus = ride.status ? (ride.status === 'en-route' ? 'en_route' : ride.status) : null
  const tripId = tripStatus ? `${ride.id}:trip` : null

  return {
    request_id: ride.id,
    // Pre-RideShare Loopride rides were all weekly routines.
    booking_type: ride.bookingType ?? 'recurring',
    request_status:
      ride.status === 'completed' ? 'completed' : ride.paused ? 'paused' : driverId ? 'matched' : 'open',
    pickup_label: ride.pickup,
    pickup_lat: ride.pickupCoord?.lat ?? null,
    pickup_lng: ride.pickupCoord?.lng ?? null,
    dropoff_label: ride.dropoff,
    dropoff_lat: ride.dropoffCoord?.lat ?? null,
    dropoff_lng: ride.dropoffCoord?.lng ?? null,
    recurring_days: ride.days.length > 0 ? ride.days.join(',') : null,
    pickup_time: ride.time || null,
    scheduled_for: ride.scheduledFor ?? null,
    vehicle_class: ride.vehicle ?? null,
    requested_at: ride.requestedAt ?? null,
    client_record: JSON.stringify(ride),
    created_at: ride.createdAt,
    driver_id: driverId,
    driver_name: driverId ? driverName : null,
    driver_rating: driverId ? (ride.driverRating ?? null) : null,
    vehicle_id: vehicleId,
    vehicle_plate: vehicleId ? (plate ?? null) : null,
    quote_id: ride.fareCents != null ? `${ride.id}:quote` : null,
    fare_cents: ride.fareCents ?? null,
    eta_minutes: ride.etaMinutes ?? null,
    assignment_id: driverId ? `${ride.id}:assignment` : null,
    trip_id: tripId,
    trip_status: tripStatus,
    trip_event_id: tripId ? `${tripId}:${tripStatus}` : null,
  }
}

function signedIn(): boolean {
  try {
    return Boolean(app?.auth?.user && app.actions)
  } catch {
    return false
  }
}

/** Persist one ride to the PAS DB. Resolves without writing when signed out. */
export async function persistRide(ride: RecurringRide): Promise<void> {
  if (!signedIn()) return
  await app.actions.call('save_ride', { ...rideToRecords(ride) })
}

/** Persist every ride in order — the idempotent local/KV → DB migration. */
export async function persistRides(rides: RecurringRide[]): Promise<void> {
  for (const ride of rides) await persistRide(ride)
}

/** Soft-cancel a ride request (and any unfinished trip) in the PAS DB. */
export async function cancelRideRecord(id: string): Promise<void> {
  if (!signedIn()) return
  await app.actions.call('cancel_ride', { request_id: id })
}
