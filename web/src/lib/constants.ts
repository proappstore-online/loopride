export const APP_ID = 'loopride'

/** localStorage keys. Prefixed `loopride.` + versioned so we can migrate later. */
export const STORAGE_KEYS = {
  rides: 'loopride.rides.v2',
  role: 'loopride.role.v1',
  ridesOwner: 'loopride.rides.owner.v1',
} as const

/** Keys inside FAS KV (per-user, server-side). */
export const KV_KEYS = {
  rides: 'rides.v1',
} as const

/** BroadcastChannel name for cross-tab driver→rider position pings. */
export const BROADCAST_CHANNEL = 'loopride.driver-position.v1'

/** URL hash prefixes. */
export const HASH = {
  ride: '#ride=',
  session: '#fas_session=',
} as const

/** Custom DOM events used for cross-component refresh. */
export const EVENTS = {
  /** Fired on any local ride list change (saveRide, deleteRide, clearLocalRides) AND on remote-to-local sync. */
  ridesChanged: 'loopride:rides-changed',
} as const

/** Field caps. SEC-4: stops a single ride from burning the per-user 1MB KV quota. */
export const LIMITS = {
  pickupChars: 200,
  dropoffChars: 200,
  driverNameChars: 80,
} as const

/** Driver position freshness window. After this the UI flips to "Last seen". */
export const LIVE_FEED_TIMEOUT_MS = 15_000
