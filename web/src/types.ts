export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export const DAYS: { id: DayOfWeek; label: string }[] = [
  { id: 'mon', label: 'Mon' },
  { id: 'tue', label: 'Tue' },
  { id: 'wed', label: 'Wed' },
  { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' },
  { id: 'sat', label: 'Sat' },
  { id: 'sun', label: 'Sun' },
]

export interface LatLng {
  lat: number
  lng: number
}

export interface RecurringRide {
  id: string
  pickup: string
  pickupCoord: LatLng | null
  dropoff: string
  dropoffCoord: LatLng | null
  days: DayOfWeek[]
  time: string
  driverName: string
  paused: boolean
  createdAt: number
  /**
   * Cached driving polyline from /v1/maps/route. GeoJSON LineString
   * coordinates ([lng, lat] order). Optional — populated at ride creation
   * when the route fetch succeeds, fetched lazily otherwise.
   */
  routePolyline?: [number, number][]
  /** RideShare supports both immediate and planned trips. Old Loopride records
   * simply omit this and remain valid scheduled rides after migration. */
  bookingType?: 'now' | 'scheduled' | 'recurring'
  vehicle?: 'share' | 'comfort' | 'xl'
  fareCents?: number
  etaMinutes?: number
  requestedAt?: number
  scheduledFor?: string
  /** Assigned automatically by the marketplace rather than chosen by rider. */
  driverPlate?: string
  driverRating?: number
  /** Locally persisted progress for an active on-demand ride. */
  status?: 'en-route' | 'arrived' | 'completed'
}

/** The public product language. Kept as an alias while old saved rides migrate. */
export type Ride = RecurringRide

export const VEHICLES = [
  { id: 'share', label: 'RideShare', description: 'Affordable everyday rides', multiplier: 1 },
  { id: 'comfort', label: 'Comfort', description: 'Newer cars, extra legroom', multiplier: 1.45 },
  { id: 'xl', label: 'RideShare XL', description: 'Room for up to 6', multiplier: 1.9 },
] as const

export type VehicleType = (typeof VEHICLES)[number]['id']

export type Role = 'rider' | 'driver'
