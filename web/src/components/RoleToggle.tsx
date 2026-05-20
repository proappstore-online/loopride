import { useLocation } from 'wouter'
import type { Role } from '../types'
import { setRole } from '../lib/mode'

interface RoleToggleProps {
  role: Role
}

export default function RoleToggle({ role }: RoleToggleProps) {
  const [, setLocation] = useLocation()

  const switchTo = (next: Role) => {
    if (next === role) return
    setRole(next)
    setLocation(next === 'driver' ? '/driver' : '/')
  }

  return (
    <div className="inline-flex rounded-full border border-[var(--line)] bg-[var(--paper)] p-1 text-xs font-semibold">
      <button
        onClick={() => switchTo('rider')}
        className={`rounded-full px-3 py-1 transition-colors ${
          role === 'rider' ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)]'
        }`}
      >
        Rider
      </button>
      <button
        onClick={() => switchTo('driver')}
        className={`rounded-full px-3 py-1 transition-colors ${
          role === 'driver' ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)]'
        }`}
      >
        Driver
      </button>
    </div>
  )
}
