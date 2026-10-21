import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import AuthChip from '../components/AuthChip'
import { app } from '../lib/app'
import { useAuth } from '../lib/useAuth'
import { useRideList } from '../lib/useRideList'
import { showToast } from '../lib/toast'
import {
  DEFAULT_PROFILE,
  TRIP_BUCKETS,
  deletePlace,
  eraseRiderData,
  exportAccountData,
  groupHistory,
  loadHistory,
  loadPlaces,
  loadProfile,
  localHistory,
  savePlace,
  saveProfile,
  type HistoryItem,
  type RiderProfile,
  type SavedPlace,
  type TripBucket,
} from '../lib/riderAccount'

const card = 'rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4'
const input = 'w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)]'
const heading = 'mb-3 text-base font-extrabold tracking-[-0.03em] text-[var(--ink)]'

export default function Account() {
  const auth = useAuth()
  const [, setLocation] = useLocation()
  const signedIn = Boolean(auth.user)

  return (
    <div className="mx-auto min-h-[100dvh] max-w-2xl space-y-8 px-4 pb-10 pt-5 sm:px-6">
      <header className="flex items-center justify-between gap-3">
        <button onClick={() => setLocation('/')} className="text-sm font-bold text-[var(--accent)]">← Back</button>
        <h1 className="text-xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">Account</h1>
        <AuthChip loading={auth.loading} user={auth.user} onSignIn={(provider) => app.auth.signIn(provider)} onSignOut={auth.signOut} />
      </header>

      {!auth.loading && !signedIn && (
        <p role="note" className="rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-xs leading-5 text-[var(--ink)]">
          You're using RideShare without an account. You can still request rides, but they are saved only on this
          device and are lost if you clear your browser data. Sign in and the rides on this device are added to your
          account automatically, with no re-entering.
        </p>
      )}

      <TripHistory signedIn={signedIn} loading={auth.loading} />
      {signedIn && (
        <>
          <ProfileForm />
          <SavedPlaces />
          <DataControls deleteAccount={auth.deleteAccount} />
        </>
      )}
    </div>
  )
}

export function TripHistory({ signedIn, loading }: { signedIn: boolean; loading: boolean }) {
  const localRides = useRideList()
  const [remote, setRemote] = useState<HistoryItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<TripBucket>('active')

  useEffect(() => {
    if (!signedIn) return
    let live = true
    loadHistory().then(
      (items) => live && setRemote(items),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [signedIn])

  // Signed in and loaded: the DB is the system of record. Otherwise (anonymous,
  // still loading, or offline) fall back to this device's rides.
  const items = signedIn && remote ? remote : localHistory()
  void localRides // re-render when local rides change
  const groups = groupHistory(items)

  return (
    <section aria-label="Trips">
      <h2 className={heading}>Your trips</h2>
      <div role="tablist" className="mb-3 flex gap-2 overflow-x-auto">
        {TRIP_BUCKETS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-full border px-3 py-1 text-xs font-bold ${tab === id ? 'border-[var(--ink)] bg-[var(--ink)] text-white' : 'border-[var(--line)] text-[var(--ink)]'}`}
          >
            {label} ({groups[id].length})
          </button>
        ))}
      </div>
      {failed && <p className="mb-2 text-xs text-[var(--error)]">Couldn't load your account history. Showing this device only.</p>}
      {loading ? null : groups[tab].length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--line)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          No {tab} trips.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups[tab].map((item) => (
            <li key={item.id} className={card}>
              <p className="truncate text-sm font-bold text-[var(--ink)]">{item.dropoff}</p>
              <p className="truncate text-xs text-[var(--muted)]">From {item.pickup}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {new Date(item.when).toLocaleDateString()}
                {item.fareCents != null && ` · $${(item.fareCents / 100).toFixed(2)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProfileForm() {
  const [profile, setProfile] = useState<RiderProfile>(DEFAULT_PROFILE)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    loadProfile().then((p) => live && setProfile(p), () => undefined)
    return () => {
      live = false
    }
  }, [])

  const set = <K extends keyof RiderProfile>(key: K, value: RiderProfile[K]) => setProfile((p) => ({ ...p, [key]: value }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await saveProfile(profile)
      showToast({ message: 'Profile saved' })
    } catch {
      showToast({ message: "Couldn't save your profile" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Profile">
      <h2 className={heading}>Profile and contact preferences</h2>
      <label className="block text-xs font-bold text-[var(--ink)]">Name
        <input className={`${input} mt-1`} value={profile.displayName} maxLength={80} onChange={(e) => set('displayName', e.target.value)} />
      </label>
      <label className="block text-xs font-bold text-[var(--ink)]">Phone
        <input className={`${input} mt-1`} type="tel" value={profile.phone} maxLength={30} onChange={(e) => set('phone', e.target.value)} />
      </label>
      {([['notifyTripUpdates', 'Trip updates (driver assigned, arriving)'], ['notifyEmail', 'Email receipts'], ['notifySms', 'Text messages']] as const).map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-sm text-[var(--ink)]">
          <input type="checkbox" checked={profile[key]} onChange={(e) => set(key, e.target.checked)} /> {label}
        </label>
      ))}
      <button disabled={saving} className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">Save profile</button>
    </form>
  )
}

function SavedPlaces() {
  const [places, setPlaces] = useState<SavedPlace[]>([])
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')

  const refresh = useCallback(() => loadPlaces().then(setPlaces, () => undefined), [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim() || !address.trim()) return
    await savePlace({ id: crypto.randomUUID(), label, address, lat: null, lng: null })
    setLabel('')
    setAddress('')
    await refresh()
  }
  const remove = async (id: string) => {
    await deletePlace(id)
    await refresh()
  }

  return (
    <section aria-label="Saved places">
      <h2 className={heading}>Saved places</h2>
      <ul className="mb-3 space-y-2">
        {places.map((p) => (
          <li key={p.id} className={`${card} flex items-center justify-between gap-3`}>
            <span className="min-w-0"><span className="block text-sm font-bold text-[var(--ink)]">{p.label}</span><span className="block truncate text-xs text-[var(--muted)]">{p.address}</span></span>
            <button onClick={() => remove(p.id)} aria-label={`Remove ${p.label}`} className="text-xs font-bold text-[var(--error)]">Remove</button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <input className={input} aria-label="Place name" placeholder="Home" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        <input className={input} aria-label="Place address" placeholder="Address" value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />
        <button className="rounded-2xl border border-[var(--line)] px-4 py-2 text-sm font-bold text-[var(--ink)]">Add place</button>
      </form>
    </section>
  )
}

function DataControls({ deleteAccount }: { deleteAccount: () => Promise<void> }) {
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const download = async () => {
    try {
      const data = await exportAccountData()
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'rideshare-account-data.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      showToast({ message: "Couldn't export your data" })
    }
  }
  const erase = async () => {
    setBusy(true)
    try {
      await eraseRiderData()
      await deleteAccount()
    } catch {
      showToast({ message: "Couldn't delete your account. Nothing further was changed." })
      setBusy(false)
    }
  }

  return (
    <section aria-label="Your data" className={card}>
      <h2 className={heading}>Your data</h2>
      <button onClick={download} className="rounded-2xl border border-[var(--line)] px-4 py-2 text-sm font-bold text-[var(--ink)]">Export my data (JSON)</button>
      <p className="mt-5 text-xs leading-5 text-[var(--muted)]">
        Deleting your account permanently erases your profile, saved places, ride requests, trips and trip history,
        then removes your sign-in. This cannot be undone.
      </p>
      <label className="mt-2 block text-xs font-bold text-[var(--ink)]">Type DELETE to confirm
        <input className={`${input} mt-1`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button disabled={confirm !== 'DELETE' || busy} onClick={erase} className="mt-3 rounded-2xl bg-[var(--error)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">Delete my account</button>
    </section>
  )
}
