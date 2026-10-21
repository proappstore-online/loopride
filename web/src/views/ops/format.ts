export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : '—')
export const usd = (cents: number | null | undefined) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`)
