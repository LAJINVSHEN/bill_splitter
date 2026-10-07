/** Eight hues for a person's initial circle (stored as `color_seed`, 0–359). */
export const HUES: ReadonlyArray<{ name: string; hue: number }> = [
  { name: 'Rose', hue: 350 },
  { name: 'Apricot', hue: 25 },
  { name: 'Lemon', hue: 52 },
  { name: 'Lime', hue: 90 },
  { name: 'Mint', hue: 150 },
  { name: 'Sky', hue: 200 },
  { name: 'Periwinkle', hue: 235 },
  { name: 'Lilac', hue: 280 },
]

/** The swatch closest to a stored seed, so older random seeds still show a selection. */
export function nearestHue(seed: number): number {
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
  let best = HUES[0]?.hue ?? 0
  for (const h of HUES) if (dist(h.hue, seed) < dist(best, seed)) best = h.hue
  return best
}

/** Names: trimmed, inner whitespace collapsed (the API does the same), 1–60 characters. */
export function cleanName(input: string): string {
  return input.trim().replace(/\s+/g, ' ')
}

export function nameError(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (name.length > 60) return 'Keep it under 60 characters.'
  return null
}
