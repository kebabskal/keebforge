/** The offset backend: Clipper2 compiled to WebAssembly, replacing the
 * hand-rolled Minkowski offset in `outline.ts`.
 *
 * The legacy path approximates dilate/erode by emitting an edge strip plus an
 * arc wedge per boundary vertex and unioning the lot through
 * polygon-clipping. That manufactures the vertex count the clipper then has to
 * sweep — the input to the expensive stage is produced by the stage before it
 * — and it needs a pile of epsilon fudges (`MARGIN`, `APEX_PULL`, the
 * requantise-and-retry ladder) purely to keep coincident geometry away from a
 * float sweep line that falls over on it. Clipper2 offsets natively, on an
 * integer grid, in one call.
 *
 * The pure-JS port (`clipper2-js` 1.2.4) is not usable here: its boolean
 * engine is correct, but `ClipperOffset` returns self-intersecting rings —
 * offsetting a 10 mm square by 3 mm gives area 181 where the answer is
 * 248.27, and the ring visibly jumps across the shape. The WASM build is the
 * real Clipper2 and returns 248.03 (the deficit is just chord sampling).
 *
 * The legacy offsetter is still there behind `setOffsetBackend()`, the
 * `KEEBFORGE_OFFSET=legacy` env var and `?offset=legacy`, both as an A/B for
 * the bench and fidelity scripts and as the fallback if this module fails to
 * load. It is roughly 10x slower and measurably rougher: mirror symmetry
 * comes out 0.229 mm off axis against 0.035 mm here. */
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping'

/** Decimal places Clipper2 keeps when it scales millimetres onto its internal
 * integer grid. Three is the 0.001 mm grid the legacy path already snaps
 * every vertex to, so the swap cannot change the effective precision. */
const PRECISION = 3

/** PointD is (x, y, z) — this is the Z-preserving build — so coordinate
 * buffers are strided by three, not two. Reading them as pairs silently
 * produces plausible-looking garbage. */
const STRIDE = 3

/* eslint-disable @typescript-eslint/no-explicit-any -- emscripten module */
type Clipper2Module = any

let mod: Clipper2Module | null = null

/** Load the WASM module. Idempotent; must resolve before the clipper2 backend
 * is selected. */
export async function initClipper2(): Promise<void> {
  if (mod) return
  const factory = (await import('clipper2-wasm/dist/es/clipper2z.js')).default
  mod = await (factory as () => Promise<Clipper2Module>)()
}

export function clipper2Ready(): boolean {
  return mod !== null
}

/** Clipper2 is the offset backend unless something asks for the old one:
 * `KEEBFORGE_OFFSET=legacy` for the bench and fidelity scripts, `?offset=
 * legacy` on the dev server for a visual A/B. */
export function clipper2Requested(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.KEEBFORGE_OFFSET
  if (env) return env !== 'legacy'
  const search = (globalThis as { location?: { search?: string } }).location?.search
  return !search || new URLSearchParams(search).get('offset') !== 'legacy'
}

// Resolved before anything can call into the offsetter, so `offsetMulti` stays
// synchronous and outline.ts needs no async plumbing. A failure here is not
// fatal: `clipper2Ready()` stays false and outline.ts falls back to the legacy
// offsetter, which is slower and rougher but does not need a WASM module to
// have loaded.
if (clipper2Requested()) {
  try {
    await initClipper2()
  } catch (error) {
    console.warn('keebforge: Clipper2 unavailable, falling back to the legacy offsetter', error)
  }
}

/** Millimetre rings to a PathsD the offsetter can take. Built through
 * `assign` on a flat Float64Array rather than per-point `push_back`, so a
 * 20 000-vertex outline crosses the boundary as one copy. */
function toPathsD(mp: MultiPolygon): { paths: Clipper2Module; count: number } {
  const paths = new mod.PathsD()
  let count = 0
  for (const poly of mp) {
    for (const ring of poly) {
      // Rings here are closed (last point repeats the first); Clipper2 paths
      // are implicitly closed, so the repeat is dropped rather than fed in as
      // a zero-length edge.
      const closed =
        ring.length >= 2 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
      const n = closed ? ring.length - 1 : ring.length
      if (n < 3) continue
      const buf = new Float64Array(n * STRIDE)
      for (let i = 0; i < n; i++) {
        buf[i * STRIDE] = ring[i][0]
        buf[i * STRIDE + 1] = ring[i][1]
      }
      const path = new mod.PathD()
      path.assign(buf)
      paths.push_back(path)
      path.delete()
      count++
    }
  }
  return { paths, count }
}

/** Copy a solution out of the WASM heap as flat coordinate buffers, then
 * release every handle — the views alias heap memory that the next call is
 * free to reuse. */
function drainPathsD(solution: Clipper2Module): Float64Array[] {
  const out: Float64Array[] = []
  const n = solution.size()
  for (let i = 0; i < n; i++) {
    const path = solution.get(i)
    out.push(new Float64Array(path.view()))
    path.delete()
  }
  solution.delete()
  return out
}

function signedArea(flat: Float64Array): number {
  let s = 0
  const n = flat.length / STRIDE
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += flat[i * STRIDE] * flat[j * STRIDE + 1] - flat[j * STRIDE] * flat[i * STRIDE + 1]
  }
  return s / 2
}

function toRing(flat: Float64Array): Ring {
  const ring: Ring = []
  for (let i = 0; i < flat.length; i += STRIDE) ring.push([flat[i], flat[i + 1]])
  ring.push(ring[0])
  return ring
}

/** Crossing-number test. Only ever asked about a vertex of some *other* path,
 * so the on-boundary case cannot arise between an outer and a hole the
 * offsetter produced. */
function contains(flat: Float64Array, x: number, y: number): boolean {
  let inside = false
  const n = flat.length / STRIDE
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = flat[i * STRIDE]
    const ay = flat[i * STRIDE + 1]
    const bx = flat[j * STRIDE]
    const by = flat[j * STRIDE + 1]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/** Rebuild polygon-clipping's nesting from Clipper2's flat path list.
 *
 * Clipper2 orients its output the way polygon-clipping does — outers
 * positive, holes negative — so the sign of the area is the classification.
 * Each hole joins the smallest outer containing it; an island inside a hole
 * is itself an outer and so stays a polygon of its own, which is exactly how
 * a MultiPolygon represents it. */
function toMulti(flats: Float64Array[]): MultiPolygon {
  const outers: { flat: Float64Array; area: number; poly: Polygon }[] = []
  const holes: Float64Array[] = []
  for (const flat of flats) {
    if (flat.length < 3 * STRIDE) continue
    const area = signedArea(flat)
    if (area > 0) outers.push({ flat, area, poly: [toRing(flat)] })
    else if (area < 0) holes.push(flat)
  }
  if (holes.length > 0) {
    // Smallest first, so the first containing outer found is the tightest.
    outers.sort((a, b) => a.area - b.area)
    for (const hole of holes) {
      const owner = outers.find((o) => contains(o.flat, hole[0], hole[1]))
      if (owner) owner.poly.push(toRing(hole))
    }
  }
  return outers.map((o) => o.poly)
}

/** Offset every ring of `mp` by `delta` mm — positive dilates, negative
 * erodes — with round joins.
 *
 * `sagitta` and `maxStep` carry the same meaning as in outline.ts: the
 * largest allowed deviation between an arc and the chord standing in for it,
 * and a hard cap on the angle one chord may span. Clipper2's arc tolerance is
 * the sagitta directly; `maxStep` is what it has no notion of, and folding it
 * into the tolerance enforces the facet cap the 3D preview's crease threshold
 * depends on. */
export function offsetMulti(
  mp: MultiPolygon,
  delta: number,
  sagitta: number,
  maxStep: number,
): MultiPolygon {
  if (!mod) throw new Error('clipper2 offset backend used before initClipper2() resolved')
  if (mp.length === 0 || delta === 0) return mp

  const { paths, count } = toPathsD(mp)
  if (count === 0) {
    paths.delete()
    return []
  }

  const facetCap = Math.abs(delta) * (1 - Math.cos(maxStep / 2))
  const tolerance = Math.min(sagitta, facetCap)

  const solution = mod.InflatePathsD(
    paths,
    delta,
    mod.JoinType.Round,
    mod.EndType.Polygon,
    2 /* miter limit, unused for round joins */,
    PRECISION,
    tolerance,
  )
  paths.delete()
  return toMulti(drainPathsD(solution))
}

/** Union through Clipper2 rather than polygon-clipping. Not wired into the
 * pipeline yet — kept here so the boolean seam can be A/B'd separately from
 * the offset seam. */
export function unionMulti(mp: MultiPolygon): MultiPolygon {
  if (!mod) throw new Error('clipper2 offset backend used before initClipper2() resolved')
  if (mp.length === 0) return mp
  const { paths, count } = toPathsD(mp)
  if (count === 0) {
    paths.delete()
    return []
  }
  const solution = mod.UnionSelfD(paths, mod.FillRule.NonZero, PRECISION)
  paths.delete()
  return toMulti(drainPathsD(solution))
}
