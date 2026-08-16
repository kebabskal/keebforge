/** Profile outline generation: per-view cost across the stress documents,
 * plus how much of it is spent inside polygon-clipping and how many vertices
 * it is being handed.
 * Run: bun scripts/bench-outline.ts [docNameFilter] */
import polygonClipping from 'polygon-clipping'
import type { Doc } from '../src/model/keys'

// Wrap the clipper before outline.ts binds it, so every call is accounted for.
const stats = { calls: 0, ms: 0, verts: 0 }
let collecting = false
for (const op of ['union', 'difference', 'intersection', 'xor'] as const) {
  const orig = polygonClipping[op] as (...a: never[]) => unknown
  ;(polygonClipping as unknown as Record<string, unknown>)[op] = (...args: never[]) => {
    if (!collecting) return orig(...args)
    let verts = 0
    for (const arg of args) {
      if (!Array.isArray(arg)) continue
      for (const poly of arg as unknown[]) {
        if (!Array.isArray(poly)) continue
        for (const ring of poly) verts += Array.isArray(ring) ? ring.length : 0
      }
    }
    const t = performance.now()
    try {
      return orig(...args)
    } finally {
      stats.calls++
      stats.ms += performance.now() - t
      stats.verts += verts
    }
  }
}

const outline = await import('../src/model/outline')
const {
  bezelShape,
  caseBottomOutline,
  caseShells,
  foamWithCutouts,
  pcbOutline,
  plateOutline,
  plateWithCutouts,
  screwPositions,
} = outline
// Absent when benchmarking a revision from before the quality knob existed,
// so an A/B against the old code still runs (its draft column just repeats
// the fine one).
const setOutlineQuality: (q: 'low' | 'draft') => void =
  (outline as { setOutlineQuality?: (q: 'low' | 'draft') => void }).setOutlineQuality ??
  (() => {})
const { DOCS } = await import('./testDocs')

/** What the 2D editor canvas asks for on every edit. */
const view2d = (doc: Doc) => {
  if (doc.bezel.enabled) bezelShape(doc)
  screwPositions(doc)
  plateOutline(doc)
}

/** What the 3D preview asks for on every rebuild. */
const view3d = (doc: Doc) => {
  plateWithCutouts(doc)
  foamWithCutouts(doc)
  pcbOutline(doc)
  screwPositions(doc)
  caseShells(doc)
  caseBottomOutline(doc)
}

/** Each run builds a pristine doc so the module caches all miss — the cost of
 * one edit, which is what dragging is bound by. */
function bench(make: () => Doc, fn: (doc: Doc) => void, runs = 5) {
  const times: number[] = []
  let clip = { calls: 0, ms: 0, verts: 0 }
  for (let i = 0; i < runs; i++) {
    const doc = make()
    stats.calls = 0
    stats.ms = 0
    stats.verts = 0
    collecting = true
    const t = performance.now()
    fn(doc)
    const dt = performance.now() - t
    collecting = false
    times.push(dt)
    clip = { ...stats }
  }
  times.sort((x, y) => x - y)
  return { ms: times[Math.floor(runs / 2)], clip }
}

const filter = process.argv[2]
const docs = DOCS.filter(([name]) => !filter || name.includes(filter))

console.log(
  'document'.padEnd(17) +
    '2D fine'.padStart(9) +
    '2D draft'.padStart(9) +
    '3D fine'.padStart(9) +
    '  |  clipper(fine)     verts',
)
console.log('-'.repeat(76))
let total2d = 0
let totalDraft = 0
let total3d = 0
for (const [name, make] of docs) {
  setOutlineQuality('low')
  const a = bench(make, view2d)
  const b = bench(make, view3d)
  setOutlineQuality('draft')
  const d = bench(make, view2d)
  setOutlineQuality('low')
  total2d += a.ms
  totalDraft += d.ms
  total3d += b.ms
  console.log(
    name.padEnd(17) +
      a.ms.toFixed(1).padStart(9) +
      d.ms.toFixed(1).padStart(9) +
      b.ms.toFixed(1).padStart(9) +
      '  |  ' +
      `${a.clip.ms.toFixed(1).padStart(8)} ms ${String(a.clip.verts).padStart(8)}`,
  )
}
console.log('-'.repeat(76))
console.log(
  'TOTAL'.padEnd(17) +
    total2d.toFixed(1).padStart(9) +
    totalDraft.toFixed(1).padStart(9) +
    total3d.toFixed(1).padStart(9),
)

// Cache behaviour: re-asking for the same doc must be free, or throttling the
// rebuild would be the only thing keeping the UI alive.
{
  const doc = DOCS[0][1]()
  view2d(doc)
  const t = performance.now()
  for (let i = 0; i < 50; i++) view2d(doc)
  console.log(`\nwarm 2D x50: ${(performance.now() - t).toFixed(2)} ms total`)
}
