import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import AuthChip from '../components/AuthChip'
import { app } from '../lib/app'
import { useAuth } from '../lib/useAuth'
import { showToast } from '../lib/toast'
import { SERVICE_RADIUS_OPTIONS_KM, currentPosition, loadLocation, publishLocation } from '../lib/dispatch'
import {
  EMPTY_APPLICATION,
  deleteVehicle,
  isEditable,
  loadApplication,
  loadAvailability,
  loadVehicles,
  missingForSubmit,
  saveApplication,
  saveVehicle,
  setAvailability,
  submitApplication,
  type DriverApplication,
  type DriverVehicle,
} from '../lib/driverOnboarding'

const input = 'w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)]'
const heading = 'mb-3 text-base font-extrabold tracking-[-0.03em] text-[var(--ink)]'
const STATUS_TEXT: Record<DriverApplication['status'], string> = {
  draft: 'Draft. Finish your details and submit.',
  submitted: 'Submitted. We are reviewing your application.',
  approved: 'Approved. You can go available for trips.',
  rejected: 'Not approved. Fix the issue below and resubmit.',
  suspended: 'Suspended. You cannot take trips until this is lifted.',
}

export default function DriverOnboarding() {
  const auth = useAuth()
  const [, setLocation] = useLocation()

  return (
    <div className="mx-auto min-h-[100dvh] max-w-2xl space-y-8 px-4 pb-10 pt-5 sm:px-6">
      <header className="flex items-center justify-between gap-3">
        <button onClick={() => setLocation('/driver')} className="text-sm font-bold text-[var(--accent)]">← Back</button>
        <h1 className="text-xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">Drive with RideShare</h1>
        <AuthChip loading={auth.loading} user={auth.user} onSignIn={(p) => app.auth.signIn(p)} onSignOut={auth.signOut} />
      </header>
      {auth.loading ? null : !auth.user ? (
        <p role="note" className="rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-xs leading-5 text-[var(--ink)]">
          Sign in to apply as a driver. Your licence details are private: only you and our operations team can see them.
        </p>
      ) : (
        <Workflow />
      )}
    </div>
  )
}

function Workflow() {
  const [application, setApplication] = useState<DriverApplication>(EMPTY_APPLICATION)
  const [vehicles, setVehicles] = useState<DriverVehicle[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const [a, v] = await Promise.all([loadApplication(), loadVehicles()])
    setApplication(a)
    setVehicles(v)
    setLoaded(true)
  }, [])
  useEffect(() => {
    refresh().catch(() => setLoaded(true))
  }, [refresh])

  if (!loaded) return null
  const editable = isEditable(application.status)
  return (
    <>
      <p role="status" className="rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-sm font-semibold text-[var(--ink)]">
        {STATUS_TEXT[application.status]}
        {application.statusReason && <span className="mt-1 block text-xs font-normal">Reason: {application.statusReason}</span>}
      </p>
      <ApplicationForm application={application} setApplication={setApplication} vehicles={vehicles} editable={editable} onSubmitted={refresh} />
      <Vehicles vehicles={vehicles} editable={application.status !== 'suspended'} refresh={refresh} />
      {application.status === 'approved' && <Availability vehicles={vehicles} />}
    </>
  )
}

function ApplicationForm({ application, setApplication, vehicles, editable, onSubmitted }: {
  application: DriverApplication
  setApplication: (a: DriverApplication) => void
  vehicles: DriverVehicle[]
  editable: boolean
  onSubmitted: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof DriverApplication>(key: K, value: DriverApplication[K]) => setApplication({ ...application, [key]: value })
  const missing = missingForSubmit(application, vehicles)

  const run = async (submit: boolean) => {
    setBusy(true)
    try {
      await saveApplication(application)
      if (submit) await submitApplication()
      await onSubmitted()
      showToast({ message: submit ? 'Application submitted' : 'Details saved' })
    } catch {
      showToast({ message: "Couldn't save your application" })
    } finally {
      setBusy(false)
    }
  }
  const text = (key: 'fullName' | 'phone' | 'licenceNumber' | 'licenceRegion', label: string) => (
    <label className="block text-xs font-bold text-[var(--ink)]">{label}
      <input className={`${input} mt-1`} value={application[key]} disabled={!editable} onChange={(e) => set(key, e.target.value)} />
    </label>
  )

  return (
    <form aria-label="Driver application" onSubmit={(e) => { e.preventDefault(); void run(false) }} className="space-y-3">
      <h2 className={heading}>Your details</h2>
      {text('fullName', 'Full name')}
      {text('phone', 'Phone')}
      {text('licenceNumber', 'Licence number')}
      {text('licenceRegion', 'Licence region')}
      <label className="block text-xs font-bold text-[var(--ink)]">Licence expiry
        <input type="date" className={`${input} mt-1`} value={application.licenceExpires} disabled={!editable} onChange={(e) => set('licenceExpires', e.target.value)} />
      </label>
      <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
        <input type="checkbox" className="mt-1" checked={application.eligibilityConfirmed} disabled={!editable} onChange={(e) => set('eligibilityConfirmed', e.target.checked)} />
        I confirm I hold a valid licence and am legally eligible to work as a driver here.
      </label>
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy} className="rounded-2xl border border-[var(--line)] px-4 py-2 text-sm font-bold text-[var(--ink)]">Save details</button>
          <button type="button" disabled={busy || missing.length > 0} onClick={() => void run(true)} className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">Submit for review</button>
          {missing.length > 0 && <span className="text-xs text-[var(--muted)]">Still needed: {missing.join(', ')}</span>}
        </div>
      )}
    </form>
  )
}

const BLANK = { plate: '', make: '', model: '', year: '', colour: '', seats: '' }

function Vehicles({ vehicles, editable, refresh }: { vehicles: DriverVehicle[]; editable: boolean; refresh: () => Promise<void> }) {
  const [form, setForm] = useState(BLANK)
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.plate.trim() || !form.make.trim() || !form.model.trim()) return
    try {
      await saveVehicle({
        id: crypto.randomUUID(),
        plate: form.plate,
        make: form.make,
        model: form.model,
        year: form.year ? Number(form.year) : null,
        colour: form.colour,
        seats: form.seats ? Number(form.seats) : null,
        vehicleClass: null,
      })
      setForm(BLANK)
      await refresh()
    } catch {
      showToast({ message: "Couldn't save the vehicle" })
    }
  }
  const field = (key: keyof typeof BLANK, label: string, type = 'text') => (
    <input className={input} aria-label={label} placeholder={label} type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
  )

  return (
    <section aria-label="Vehicles">
      <h2 className={heading}>Your vehicles</h2>
      <ul className="mb-3 space-y-2">
        {vehicles.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4">
            <span className="min-w-0 text-sm text-[var(--ink)]">
              <span className="block font-bold">{v.plate} · {v.make} {v.model}</span>
              <span className="block text-xs text-[var(--muted)]">
                {v.status === 'pending' ? 'Awaiting review' : v.status === 'approved' ? 'Approved' : `Rejected: ${v.statusReason ?? ''}`}
              </span>
            </span>
            {editable && <button onClick={() => deleteVehicle(v.id).then(refresh)} aria-label={`Remove ${v.plate}`} className="text-xs font-bold text-[var(--error)]">Remove</button>}
          </li>
        ))}
      </ul>
      {editable && (
        <form onSubmit={add} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {field('plate', 'Plate')}
          {field('make', 'Make')}
          {field('model', 'Model')}
          {field('year', 'Year', 'number')}
          {field('colour', 'Colour')}
          {field('seats', 'Seats', 'number')}
          <button className="col-span-2 rounded-2xl border border-[var(--line)] px-4 py-2 text-sm font-bold text-[var(--ink)] sm:col-span-3">Add vehicle</button>
        </form>
      )}
    </section>
  )
}

const LOCATION_REFRESH_MS = 60_000

function Availability({ vehicles }: { vehicles: DriverVehicle[] }) {
  const approved = vehicles.filter((v) => v.status === 'approved')
  const [state, setState] = useState<{ available: boolean; vehicleId: string | null } | null>(null)
  const [radiusKm, setRadiusKm] = useState<number>(5)

  useEffect(() => {
    loadAvailability().then(setState, () => undefined)
    loadLocation().then((l) => l && setRadiusKm(l.radiusKm), () => undefined)
  }, [])

  const publish = useCallback(async (): Promise<boolean> => {
    const position = await currentPosition()
    if (!position) return false
    try {
      await publishLocation(position.lat, position.lng, radiusKm)
      return true
    } catch {
      return false
    }
  }, [radiusKm])

  // Dispatch ignores stale locations, so keep publishing while online.
  const online = state?.available === true
  useEffect(() => {
    if (!online) return
    const timer = setInterval(() => void publish(), LOCATION_REFRESH_MS)
    return () => clearInterval(timer)
  }, [online, publish])

  const toggle = async () => {
    if (!state) return
    const vehicleId = state.vehicleId ?? approved[0]?.id ?? null
    try {
      if (!state.available && !(await publish())) {
        showToast({ message: 'Allow location access so nearby riders can be matched to you.' })
        return
      }
      await setAvailability(!state.available, vehicleId)
      const next = await loadAvailability()
      setState(next)
      if (!state.available && !next.available) showToast({ message: "You can't go available right now. Check your licence expiry and vehicle approval." })
    } catch {
      showToast({ message: "Couldn't update your availability" })
    }
  }

  return (
    <section aria-label="Availability" className="rounded-2xl border border-[var(--line)] p-4">
      <h2 className={heading}>Availability</h2>
      {approved.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">You need an approved vehicle before you can go available.</p>
      ) : (
        <div className="space-y-3">
          <label className="block text-xs font-bold text-[var(--ink)]">Service area
            <select className={`${input} mt-1`} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))}>
              {SERVICE_RADIUS_OPTIONS_KM.map((km) => <option key={km} value={km}>Within {km} km of my location</option>)}
            </select>
          </label>
          <button onClick={toggle} className="rounded-2xl bg-[var(--ink)] px-5 py-2 text-sm font-semibold text-white">
            {state?.available ? 'Go offline' : 'Go available'}
          </button>
        </div>
      )}
    </section>
  )
}
