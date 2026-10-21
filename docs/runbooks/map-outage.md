# Runbook: map outage

Use when `maps_error_rate` is firing, "Errors reported by the app" shows `geocode_failed` or
`route_failed`, or riders say addresses cannot be found or prices will not load.

Geocoding and routing come from the PAS Maps API through the SDK (`app.maps`). They need a signed-in
session. Map tiles come directly from OpenStreetMap's tile servers.

## What riders and drivers experience

| Part | When it fails |
|---|---|
| Address suggestions | the list is empty; typing still works |
| "Get quotes" | "We couldn't find one of those addresses" (geocoding) or "We could not price this trip" (routing). **Nobody can request a ride**: a quote needs a routed distance |
| Live map | the route is a dashed straight line labelled "straight-line estimate"; the driver dot still moves |
| ETA | a straight-line estimate at about 25 km/h, labelled "approximate" |
| Trips already booked | unaffected; the trip lifecycle, matching and tracking do not use maps |
| Tiles | the map background is blank; the pins and route still draw |

## 1. Confirm and scope

1. Health → "Errors reported by the app" (maps): check the HTTP status.
   - `401`: sessions are not reaching the Maps API (a regression in how the app calls it). Check the latest deploy and SDK version; this is a bug, [roll back](rollback.md).
   - `429`: the platform is rate limiting the Maps API; slow down is automatic (requests are debounced) but the platform may be under load.
   - `5xx` or no status: the Maps API or its upstream (Nominatim, OSRM) is down.
2. Open the app signed in and try an address yourself.
3. Check `https://api.proappstore.online/health`. If the platform is down, everything is failing; this is a platform incident.

## 2. Contain

A map outage means nobody can get a quote, so every new request fails in the same confusing way.
Pause dispatch (Health → Dispatch switch, reason `incident`) so riders see "New ride requests are paused"
instead of address errors. Trips already booked carry on.

## 3. There is no manual workaround for pricing

Fares come from a routed distance; there is no override, deliberately (the server rejects any distance
shorter than 90% of the straight line, and a price a person typed in would break the receipt guarantees).
Do not try to book rides on behalf of riders. If the outage is long, the owner decides whether to publish
an announcement.

## 4. Recover

1. Wait for the platform or upstream, or roll back the change that broke the call.
2. Confirm `maps_error_rate` clears, an address finds results, and a quote prices.
3. Resume dispatch.
4. Quotes created during the outage do not exist; nothing to clean up.
