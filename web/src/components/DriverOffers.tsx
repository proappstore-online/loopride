import { useCallback, useEffect, useState } from 'react'
import { acceptOffer, declineOffer, loadOffers, type Offer } from '../lib/dispatch'
import { showToast } from '../lib/toast'

const POLL_MS = 5000

/** A driver's live dispatch offer (accept/decline) or accepted assignment. Renders nothing when there is none. */
export default function DriverOffers() {
  const [offers, setOffers] = useState<Offer[]>([])
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(() => loadOffers().then(setOffers, () => undefined), [])
  useEffect(() => {
    void refresh()
    const poll = setInterval(refresh, POLL_MS)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [refresh])

  const respond = async (offer: Offer, accept: boolean) => {
    try {
      await (accept ? acceptOffer(offer) : declineOffer(offer))
      if (accept) {
        const fresh = await loadOffers()
        setOffers(fresh)
        if (!fresh.some((o) => o.requestId === offer.requestId && o.status === 'accepted')) showToast({ message: 'That request is no longer available' })
        return
      }
      await refresh()
    } catch {
      showToast({ message: "Couldn't update the request" })
    }
  }

  const live = offers.filter((o) => o.status === 'accepted' || o.expiresAt > now)
  if (live.length === 0) return null
  return (
    <ul aria-label="Trip offers" className="mb-6 space-y-3">
      {live.map((o) => (
        <li key={`${o.riderId}:${o.requestId}`} className="rounded-2xl border-2 border-[var(--accent)] bg-[var(--paper)] p-4">
          <p className="text-sm font-bold text-[var(--ink)]">{o.pickup} → {o.dropoff}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {o.km != null && `${o.km.toFixed(1)} km away`}
            {o.fareCents != null && ` · $${(o.fareCents / 100).toFixed(2)}`}
            {o.status === 'offered' && ` · ${Math.max(0, Math.ceil((o.expiresAt - now) / 1000))}s to respond`}
          </p>
          {o.status === 'offered' ? (
            <div className="mt-3 flex gap-2">
              <button onClick={() => respond(o, true)} className="rounded-xl bg-[var(--accent)] px-4 py-1.5 text-xs font-bold text-white">Accept</button>
              <button onClick={() => respond(o, false)} className="rounded-xl border border-[var(--line)] px-4 py-1.5 text-xs font-bold text-[var(--ink)]">Decline</button>
            </div>
          ) : (
            <p className="mt-2 text-xs font-bold text-[var(--accent)]">Assigned to you. Open the trip to start.</p>
          )}
        </li>
      ))}
    </ul>
  )
}
