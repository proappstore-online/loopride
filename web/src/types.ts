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
}

export type Role = 'rider' | 'driver'
