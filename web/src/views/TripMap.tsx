import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LatLng } from '../types'

interface TripMapProps {
  pickup: LatLng | null
  dropoff: LatLng | null
  driver: LatLng | null
}

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster' as const,
      source: 'osm',
    },
  ],
}

function makeDot(color: string, ring = false): HTMLElement {
  const el = document.createElement('div')
  el.style.width = '18px'
  el.style.height = '18px'
  el.style.borderRadius = '50%'
  el.style.background = color
  el.style.border = '3px solid white'
  el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)'
  if (ring) {
    el.style.boxShadow = `0 2px 6px rgba(0,0,0,0.25), 0 0 0 6px ${color}33`
  }
  return el
}

export default function TripMap({ pickup, dropoff, driver }: TripMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const pickupMarker = useRef<Marker | null>(null)
  const dropoffMarker = useRef<Marker | null>(null)
  const driverMarker = useRef<Marker | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const center: [number, number] = pickup
      ? [pickup.lng, pickup.lat]
      : dropoff
        ? [dropoff.lng, dropoff.lat]
        : [151.2093, -33.8688]
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center,
      zoom: 12,
      attributionControl: { compact: true },
    })

    mapRef.current.on('load', () => {
      if (pickup && dropoff && mapRef.current) {
        mapRef.current.addSource('route', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [pickup.lng, pickup.lat],
                [dropoff.lng, dropoff.lat],
              ],
            },
          },
        })
        mapRef.current.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          paint: {
            'line-color': '#7c3aed',
            'line-width': 4,
            'line-opacity': 0.7,
            'line-dasharray': [2, 1.5],
          },
        })
      }
    })

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (pickup) {
      if (!pickupMarker.current) {
        pickupMarker.current = new maplibregl.Marker({ element: makeDot('#2f8f57') })
          .setLngLat([pickup.lng, pickup.lat])
          .addTo(map)
      } else {
        pickupMarker.current.setLngLat([pickup.lng, pickup.lat])
      }
    }
    if (dropoff) {
      if (!dropoffMarker.current) {
        dropoffMarker.current = new maplibregl.Marker({ element: makeDot('#c74f43') })
          .setLngLat([dropoff.lng, dropoff.lat])
          .addTo(map)
      } else {
        dropoffMarker.current.setLngLat([dropoff.lng, dropoff.lat])
      }
    }

    if (pickup && dropoff) {
      const bounds = new maplibregl.LngLatBounds()
      bounds.extend([pickup.lng, pickup.lat])
      bounds.extend([dropoff.lng, dropoff.lat])
      map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 14 })
    }
  }, [pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!driver) {
      driverMarker.current?.remove()
      driverMarker.current = null
      return
    }
    if (!driverMarker.current) {
      driverMarker.current = new maplibregl.Marker({ element: makeDot('#7c3aed', true) })
        .setLngLat([driver.lng, driver.lat])
        .addTo(map)
    } else {
      driverMarker.current.setLngLat([driver.lng, driver.lat])
    }
  }, [driver?.lat, driver?.lng])

  if (!pickup || !dropoff) {
    return (
      <div className="flex h-64 items-center justify-center rounded-3xl border border-[var(--line)] bg-[var(--accent-soft)] text-xs text-[var(--muted)]">
        Location coordinates missing — recreate the ride to enable the map.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="h-72 w-full overflow-hidden rounded-3xl border border-[var(--line)]"
    />
  )
}
