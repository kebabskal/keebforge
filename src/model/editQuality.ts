import { outlineQuality, setOutlineQuality } from './outline'

/** Performance mode. Both views regenerate from the same outlines, so the
 * resolution to build them at has to be one decision rather than two
 * competing ones — this module owns it.
 *
 * While edits keep arriving (a drag, a slider, a held arrow key) outlines are
 * generated at draft resolution: the same shapes with coarser fillets, which
 * on a typical board is several times cheaper. Once the edits stop, one
 * full-quality pass runs and replaces them. So the board is only ever coarse
 * while it is actually moving, and what you stop on is always the real thing.
 *
 * Persisted per browser rather than in the document — it changes nothing
 * about the board, only how it is drawn mid-gesture. */

const STORAGE_KEY = 'keebforge.fastedit'

/** How long edits have to stop for before the full-quality pass runs. Long
 * enough to sit out the gap between two drag frames or two arrow-key repeats,
 * short enough that letting go feels like it settles immediately. */
const SETTLE_MS = 260

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

let enabled = load()
let settleTimer: ReturnType<typeof setTimeout> | undefined
const settlers = new Set<() => void>()

export function fastEditing(): boolean {
  return enabled
}

export function setFastEditing(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // best-effort persistence
  }
  // Turning it off mid-drag should put the full-quality board back rather
  // than wait for the gesture to end.
  if (!on) settle()
}

/** Called by a view when it sees the document change. Drops generation into
 * draft for the duration of the burst and schedules the settle. */
export function noteEdit(): void {
  if (!enabled) return
  setOutlineQuality('draft')
  clearTimeout(settleTimer)
  settleTimer = setTimeout(settle, SETTLE_MS)
}

/** Register a view's rebuild, to run once when editing settles. */
export function onSettled(rebuild: () => void): () => void {
  settlers.add(rebuild)
  return () => {
    settlers.delete(rebuild)
  }
}

function settle(): void {
  clearTimeout(settleTimer)
  settleTimer = undefined
  if (outlineQuality() === 'fine') return
  setOutlineQuality('fine')
  for (const rebuild of settlers) rebuild()
}
