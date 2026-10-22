/** The part of a geocoder display name worth showing first: the street for a numbered address, else the place name. */
export function shortNameFor(displayName: string): string {
  const parts = displayName.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1 && /^\d+[a-z]?$/i.test(parts[0])) return `${parts[0]} ${parts[1]}`
  return parts[0] || displayName
}
