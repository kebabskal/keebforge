import polygonClipping from 'polygon-clipping'
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping'
import {
  capSize,
  isKeyMirrored,
  keySize,
  keyWorldXF,
  MCU_THICKNESS,
  SWITCH_LOWER,
  type ControllerSettings,
  type Doc,
  type Key,
  type XForm,
} from './keys'
import { groupMap } from './store'
import { clipper2Ready, clipper2Requested, offsetMulti } from './offsetClipper2'

export type { MultiPolygon, Polygon, Ring }

// ---- Offset backend -------------------------------------------------------

/** Which implementation `dilate`/`erode` use. `legacy` is the union-of-strips
 * approximation below; `clipper2` hands the same job to Clipper2's native
 * offsetter. Both are kept so the swap can be A/B'd on the bench and the
 * fidelity script — see `src/model/offsetClipper2.ts`. */
export type OffsetBackend = 'legacy' | 'clipper2'

// Clipper2 by default, and legacy whenever it is not there — either because
// it was asked for, or because the WASM module failed to load.
let offsetBackendMode: OffsetBackend =
  clipper2Requested() && clipper2Ready() ? 'clipper2' : 'legacy'

export function offsetBackend(): OffsetBackend {
  return offsetBackendMode
}

export function setOffsetBackend(next: OffsetBackend): void {
  if (next === offsetBackendMode) return
  offsetBackendMode = next
  // Every memo below holds geometry built by one backend, and unlike a
  // quality flip this can change hole topology, so they are dropped outright.
  plateCache = null
  solidsCache = null
  shellCache = null
  screwCache = null
}

/** Plate switch cutout size per switch type, mm. */
const CUTOUT: Record<Key['type'], number> = {
  mx: 14,
  choc: 13.8,
}

export const PLATE_THICKNESS = 1.5
export const FOAM_THICKNESS = 3.5
/** Standard 1.6 mm FR-4. */
export const PCB_THICKNESS = 1.6
/** Extra clearance per side around switch housings in the foam, mm. */
export const FOAM_CLEARANCE = 0.5

/** Snap a coordinate to a fine grid before clipping. polygon-clipping's
 * sweep line is not robust against the nearly-coincident vertices that
 * exactly-tangent key placements produce from raw doubles; quantizing to
 * 1/1000 mm removes the degeneracy without affecting output accuracy. */
const snap = (v: number, grid = 1000) => Math.round(v * grid) / grid

function rectPoly(world: XForm, w: number, h: number): Polygon {
  const rad = (world.r * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ring: Ring = (
    [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ] as [number, number][]
  ).map(([x, y]) => [
    snap(world.x + x * cos - y * sin),
    snap(world.y + x * sin + y * cos),
  ])
  ring.push(ring[0])
  return [ring]
}

/** Re-quantize a set of polygons to a coarser grid (retry path for clipping
 * robustness failures). */
function requantize(polys: Polygon[], grid: number): Polygon[] {
  return polys.map((poly) =>
    poly.map((ring) => ring.map(([x, y]) => [snap(x, grid), snap(y, grid)] as Ring[number])),
  )
}

/** polygon-clipping can throw ("Unable to find segment ... in SweepLine
 * tree") on degenerate input despite snapping; retry on coarser grids
 * before giving up. */
function robustClip(
  op: (subject: MultiPolygon, clip?: MultiPolygon) => MultiPolygon,
  subject: MultiPolygon,
  clip?: MultiPolygon,
): MultiPolygon {
  let lastError: unknown
  for (const grid of [1000, 100, 10]) {
    try {
      if (grid === 1000) return op(subject, clip)
      return op(requantize(subject, grid), clip && requantize(clip, grid))
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** Concave gaps narrower than this get filled in generated outlines — splayed
 * columns otherwise leave tapering wedges that end in unprintable knife
 * edges. */
const MIN_FEATURE = 3

// ---- Resolution -----------------------------------------------------------

/** How finely offset arcs are sampled. Every millimetre of generated boundary
 * is a vertex the clipper has to sweep, and its cost climbs faster than
 * linearly, so resolution is the main lever on how long a rebuild takes.
 * `draft` is for outlines being regenerated continuously under a drag; the
 * result is the same shape with visibly coarser fillets. */
export type OutlineQuality = 'fine' | 'draft'

interface QualitySpec {
  /** Largest allowed sagitta when sampling an arc, mm. */
  sagitta: number
  /** Hard cap on the angle a single arc segment may span, radians. `fine`
   * keeps facets under the 3D preview's 30° normal-crease threshold so
   * fillets shade as curves rather than flats. */
  maxStep: number
  /** Vertex-dropping tolerance applied between morphological stages, mm. */
  simplifyEps: number
}

const QUALITY: Record<OutlineQuality, QualitySpec> = {
  fine: { sagitta: 0.02, maxStep: Math.PI / 9, simplifyEps: 0.02 },
  draft: { sagitta: 0.25, maxStep: Math.PI / 4, simplifyEps: 0.1 },
}

let quality: OutlineQuality = 'fine'

export function outlineQuality(): OutlineQuality {
  return quality
}

/** Switching quality invalidates every memo below, since they all cache
 * geometry built at one resolution. Callers should therefore flip this once
 * per gesture, not per edit. */
export function setOutlineQuality(next: OutlineQuality): void {
  quality = next
}

/** Angular step for sampling an arc of radius `r`, from the sagitta budget. */
function arcStep(r: number): number {
  const q = QUALITY[quality]
  if (r <= 1e-9) return q.maxStep
  const cos = 1 - Math.min(q.sagitta, r) / r
  return Math.min(q.maxStep, 2 * Math.acos(Math.max(-1, Math.min(1, cos))))
}

/** Full disc, for the degenerate case where a vertex has no usable incoming
 * edge to measure a turn against. */
function discPoly(cx: number, cy: number, r: number): Polygon {
  const segments = Math.max(6, Math.ceil((2 * Math.PI) / arcStep(r)))
  const ring: Ring = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI
    ring.push([snap(cx + r * Math.cos(a)), snap(cy + r * Math.sin(a))])
  }
  ring.push(ring[0])
  return [ring]
}

/** Only the part of the offset disc that the edge strips actually leave
 * uncovered at a turn: the pie slice between the two edges' normals. A full
 * disc at every corner is what the clipper used to spend most of its time on
 * — all but the slice is buried inside the strips, and on an outline that has
 * already been through one offsetting pass there is a corner every fraction
 * of a millimetre.
 *
 * `MARGIN` swings both straight sides a little past the strips they meet, and
 * the apex is pulled back off the polygon's own vertex, so boundaries cross
 * transversally rather than touching — coincident geometry being exactly what
 * makes this clipper's sweep line fall over, and the reason the straightforward
 * version reached for whole discs to begin with. */
function arcWedge(
  vx: number,
  vy: number,
  r: number,
  aStart: number,
  sweep: number,
): Polygon {
  const MARGIN = 0.06
  const APEX_PULL = 0.05
  const mid = aStart + sweep / 2
  const half = Math.abs(sweep) / 2 + MARGIN
  const a0 = mid - half
  const steps = Math.max(1, Math.ceil((2 * half) / arcStep(r)))
  // The apex lands inside the material when dilating and outside it when
  // eroding — either way in ground the operation already covers, so pulling
  // it back off the boundary cannot change the result.
  const ring: Ring = [
    [snap(vx - Math.cos(mid) * APEX_PULL), snap(vy - Math.sin(mid) * APEX_PULL)],
  ]
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((2 * half) * i) / steps
    ring.push([snap(vx + r * Math.cos(a)), snap(vy + r * Math.sin(a))])
  }
  ring.push(ring[0])
  return [ring]
}

/** One-sided offset band along the polygon boundary: edge strips reaching
 * from just past the boundary out to `r` on the given side, plus wedge discs
 * where the turn direction leaves the strips' side uncovered. Expects
 * polygon-clipping's canonical ring orientation (outers CCW, holes CW), which
 * puts the material on the left of the traversal; the small overshoot keeps
 * the band edges transversal to the boundary instead of coincident (the
 * degenerate case that crashes the clipper's sweep line). */
function offsetBand(mp: MultiPolygon, r: number, side: 'out' | 'in'): Polygon[] {
  const EPS = 0.02
  const lo = side === 'out' ? -EPS : -r
  const hi = side === 'out' ? r : EPS
  const parts: Polygon[] = []
  for (const poly of mp) {
    for (const ring of poly) {
      const n = ring.length - 1
      if (n < 3) continue
      for (let i = 0; i < n; i++) {
        const [x1, y1] = ring[i]
        const [x2, y2] = ring[i + 1]
        const ex = x2 - x1
        const ey = y2 - y1
        const len = Math.hypot(ex, ey)
        if (len < 1e-9) continue
        // Right normal = away from the material.
        const nx = ey / len
        const ny = -ex / len
        parts.push([
          [
            [snap(x1 + nx * lo), snap(y1 + ny * lo)],
            [snap(x2 + nx * lo), snap(y2 + ny * lo)],
            [snap(x2 + nx * hi), snap(y2 + ny * hi)],
            [snap(x1 + nx * hi), snap(y1 + ny * hi)],
            [snap(x1 + nx * lo), snap(y1 + ny * lo)],
          ],
        ])
        // Left turns open a wedge on the right (outward) side and vice versa.
        const p0 = ring[(i + n - 1) % n]
        const px = x1 - p0[0]
        const py = y1 - p0[1]
        const l0 = Math.hypot(px, py)
        const cross = px * ey - py * ex
        const sinT = l0 < 1e-9 ? 1 : cross / (l0 * len)
        if ((side === 'out' ? sinT : -sinT) <= 0.017) continue
        if (l0 < 1e-9) {
          // No incoming edge to measure the turn against; fall back to the
          // whole disc, which covers the wedge whatever direction it opens in.
          parts.push(discPoly(x1, y1, r))
          continue
        }
        // Signed turn from the incoming edge to this one. Dilating leaves the
        // gap between the two outward normals; eroding leaves it between the
        // two inward ones, swept the other way.
        const turn = Math.atan2(cross, px * ex + py * ey)
        parts.push(
          side === 'out'
            ? arcWedge(x1, y1, r, Math.atan2(-px, py), turn)
            : arcWedge(x1, y1, r, Math.atan2(ny, nx) + Math.PI, -turn),
        )
      }
    }
  }
  return parts
}

/** Exact Minkowski offset via Clipper2, wrapped in the same debris drop and
 * inter-stage simplification the legacy path applies.
 *
 * The simplification is not optional. A round join emits arc points at every
 * convex turn, and after one offset every vertex of a fillet *is* a convex
 * turn, so a second offset re-tessellates each of them and the count roughly
 * doubles per stage. Dropping the points that sit within `simplifyEps` of
 * their neighbours' chord keeps a four-stage pipeline flat instead of
 * exponential. */
function offsetC2(mp: MultiPolygon, delta: number): MultiPolygon {
  const q = QUALITY[quality]
  return simplify(dropDebris(offsetMulti(mp, delta, q.sagitta, q.maxStep), 2), q.simplifyEps)
}

/** Approximate Minkowski dilation by a disc of radius r. Micro-holes are
 * dropped immediately: a spurious sealed pocket would otherwise inflate into
 * a disc-sized hole under a following erosion. */
function dilate(mp: MultiPolygon, r: number): MultiPolygon {
  if (mp.length === 0 || r <= 0) return mp
  if (offsetBackendMode === 'clipper2') return offsetC2(mp, r)
  return simplify(
    dropDebris(
      robustClip((s) => polygonClipping.union(s), [...mp, ...offsetBand(mp, r, 'out')]),
      2,
    ),
    QUALITY[quality].simplifyEps,
  )
}

/** Approximate Minkowski erosion by a disc of radius r: subtract the band
 * within r of the boundary. Straight edges are reconstructed exactly (the
 * strip's inner edge), so dilate-then-erode round-trips cleanly. */
export function erode(mp: MultiPolygon, r: number): MultiPolygon {
  if (mp.length === 0 || r <= 0) return mp
  if (offsetBackendMode === 'clipper2') return offsetC2(mp, -r)
  // The band is deliberately *not* simplified: its inner edge reconstructs
  // the eroded contour exactly, and nudging those vertices would leave the
  // difference with boundaries that nearly — but no longer exactly — coincide
  // with the subject's. That is the slowest and most fragile case there is for
  // the sweep line, and it costs more than the vertices saved.
  const band = robustClip((s) => polygonClipping.union(s), offsetBand(mp, r, 'in'))
  return simplify(
    dropDebris(
      robustClip((s, c) => polygonClipping.difference(s, c!), mp, band),
      2,
    ),
    QUALITY[quality].simplifyEps,
  )
}

/** Cheap pre-check: does any pair of non-adjacent boundary edges come within
 * `width` of each other? Polygons without such gaps skip the closing pass
 * entirely. False positives only cost time, never correctness. */
function hasNarrowGap(poly: Polygon, width: number): boolean {
  const edges: [number, number, number, number][] = []
  const ringOf: number[] = []
  poly.forEach((ring, ri) => {
    for (let i = 0; i < ring.length - 1; i++) {
      edges.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]])
      ringOf.push(ri)
    }
  })
  const w2 = width * width
  const segDist2 = (a: (typeof edges)[number], b: (typeof edges)[number]) => {
    const pt = (e: (typeof edges)[number], t: number): [number, number] => [
      e[0] + (e[2] - e[0]) * t,
      e[1] + (e[3] - e[1]) * t,
    ]
    const ptSeg2 = ([px, py]: [number, number], e: (typeof edges)[number]) => {
      const dx = e[2] - e[0]
      const dy = e[3] - e[1]
      const l2 = dx * dx + dy * dy
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - e[0]) * dx + (py - e[1]) * dy) / l2))
      const qx = e[0] + dx * t - px
      const qy = e[1] + dy * t - py
      return qx * qx + qy * qy
    }
    return Math.min(
      ptSeg2(pt(a, 0), b),
      ptSeg2(pt(a, 1), b),
      ptSeg2(pt(b, 0), a),
      ptSeg2(pt(b, 1), a),
    )
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 2; j < edges.length; j++) {
      if (ringOf[i] === ringOf[j] && (j - i <= 1 || (i === 0 && j === edges.length - 1))) {
        continue
      }
      if (segDist2(edges[i], edges[j]) < w2) return true
    }
  }
  return false
}

/** Drop vertices that deviate less than `eps` from the line through their
 * neighbours. Closing leaves micro-edges at corners (disc sampling and
 * quantization artifacts) which would otherwise clamp the corner fillets to
 * nothing.
 *
 * Each vertex is measured against its immediate neighbours, and no two
 * adjacent vertices are dropped in the same pass, so one pass can never move
 * the boundary by more than `eps`. Measuring against the last *kept* vertex
 * instead lets a run of gentle vertices collapse onto one far-away anchor:
 * a long shallow curve reads as within tolerance of the growing chord the
 * whole way along and the pass shortcuts across it. That is a difference of
 * hundreds of square millimetres on a real board, and because the walk starts
 * at whichever vertex the clipper happened to emit first, it hit one half of
 * a mirrored board and not the other. */
function simplifyRing(ring: Ring, eps: number): Ring {
  let pts = [...ring]
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts = pts.slice(0, -1)
  }
  let changed = true
  while (changed && pts.length > 3) {
    changed = false
    const n = pts.length
    const drop = new Set<number>()
    for (let i = 0; i < n; i++) {
      if (drop.has((i - 1 + n) % n)) continue
      const a = pts[(i - 1 + n) % n]
      const b = pts[i]
      const c = pts[(i + 1) % n]
      const ux = c[0] - a[0]
      const uy = c[1] - a[1]
      const len = Math.hypot(ux, uy)
      const dist =
        len < 1e-9
          ? Math.hypot(b[0] - a[0], b[1] - a[1])
          : Math.abs((b[0] - a[0]) * uy - (b[1] - a[1]) * ux) / len
      if (dist < eps) drop.add(i)
    }
    if (drop.size === 0) break
    if (pts.length - drop.size < 3) break
    changed = true
    pts = pts.filter((_, i) => !drop.has(i))
  }
  if (pts.length < 3) return ring
  pts.push(pts[0])
  return pts
}

export function simplify(mp: MultiPolygon, eps: number): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => simplifyRing(ring, eps)))
}

function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return a / 2
}

/** Drop speck polygons and holes below `minArea` — offset approximations
 * leave sub-millimeter debris that is meaningless at fabrication scale. */
function dropDebris(mp: MultiPolygon, minArea: number): MultiPolygon {
  const out: MultiPolygon = []
  for (const poly of mp) {
    if (Math.abs(ringArea(poly[0])) < minArea) continue
    out.push([
      poly[0],
      ...poly.slice(1).filter((ring) => Math.abs(ringArea(ring)) >= minArea),
    ])
  }
  return out
}

interface Vec {
  x: number
  y: number
}

/** A key's world rectangle as a local frame: axes plus a local→world map. */
function keyFrame(world: XForm, w: number, h: number) {
  const rad = (world.r * Math.PI) / 180
  const ux: Vec = { x: Math.cos(rad), y: Math.sin(rad) }
  const uy: Vec = { x: -Math.sin(rad), y: Math.cos(rad) }
  return {
    ux,
    uy,
    w,
    h,
    c: { x: world.x, y: world.y } as Vec,
    at: (lx: number, ly: number): Vec => ({
      x: world.x + ux.x * lx + uy.x * ly,
      y: world.y + ux.y * lx + uy.y * ly,
    }),
  }
}

const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y

/** Where two infinite lines cross, or null if they are parallel. */
function lineCross(p0: Vec, d0: Vec, p1: Vec, d1: Vec): Vec | null {
  const den = d0.x * d1.y - d0.y * d1.x
  if (Math.abs(den) < 1e-9) return null
  const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / den
  return { x: p0.x + d0.x * t, y: p0.y + d0.y * t }
}

/** Close the notch where two neighbouring columns meet at different heights.
 * Splay and stagger leave the shorter column's end edge hanging in mid-air,
 * and the union dips into the slot between the two — the nub. Instead of
 * bridging straight across (which pulls the boundary off the keys), run the
 * shorter column's end edge on until it meets the taller column's facing
 * side and fill only what that encloses, so the outline steps cleanly from
 * one column up to the next.
 *
 * Built per end of each adjacent column pair, and per mirrored copy, since
 * mirroring flips which side of a key faces its neighbour. */
function columnJoinFills(
  doc: Doc,
  worlds: { key: Key; world: XForm; mirrored: boolean }[],
  sizeOf: (key: Key) => { w: number; h: number },
  pad: number,
): Polygon[] {
  const out: Polygon[] = []
  for (const group of doc.groups) {
    if (group.layout.kind !== 'columns') continue
    const byCol = new Map<number, Key[]>()
    for (const key of doc.keys) {
      if (key.groupId !== group.id) continue
      const col = key.col ?? 0
      byCol.set(col, [...(byCol.get(col) ?? []), key])
    }
    const cols = [...byCol.keys()].sort((a, b) => a - b)
    if (cols.length < 2) continue
    for (const mirrored of [false, true]) {
      const byId = new Map(
        worlds.filter((w) => w.mirrored === mirrored).map((w) => [w.key.id, w.world] as const),
      )
      if (byId.size === 0) continue
      for (let i = 0; i + 1 < cols.length; i++) {
        const pair = [byCol.get(cols[i])!, byCol.get(cols[i + 1])!]
        // end = +1 is the columns' local top, -1 their bottom.
        for (const end of [1, -1] as const) {
          const ends = pair.map((col) =>
            col.reduce((best, k) =>
              end > 0
                ? (k.row ?? 0) < (best.row ?? 0)
                  ? k
                  : best
                : (k.row ?? 0) > (best.row ?? 0)
                  ? k
                  : best,
            ),
          )
          const frames = ends.map((k) => {
            const world = byId.get(k.id)
            if (!world) return null
            const size = sizeOf(k)
            return keyFrame(world, size.w + 2 * pad, size.h + 2 * pad)
          })
          if (!frames[0] || !frames[1]) continue
          const [fa, fb] = frames as [ReturnType<typeof keyFrame>, ReturnType<typeof keyFrame>]
          const toB: Vec = { x: fb.c.x - fa.c.x, y: fb.c.y - fa.c.y }
          const span = Math.hypot(toB.x, toB.y)
          if (span < 1e-6) continue
          const dir: Vec = { x: toB.x / span, y: toB.y / span }
          // Local +y survives mirroring, but local +x flips with it, so pick
          // each facing side by which one actually points at the neighbour.
          const sideA = dot(fa.ux, dir) > 0 ? 1 : -1
          const sideB = dot(fb.ux, dir) > 0 ? -1 : 1
          // Whichever end edge sits lower along the shared up axis is the one
          // that gets extended.
          const up: Vec = end > 0 ? fa.uy : { x: -fa.uy.x, y: -fa.uy.y }
          const midA = fa.at(0, (end * fa.h) / 2)
          const midB = fb.at(0, (end * fb.h) / 2)
          const aIsLower = dot(midA, up) <= dot(midB, up)
          const low = aIsLower ? fa : fb
          const tall = aIsLower ? fb : fa
          const lowSide = aIsLower ? sideA : sideB
          const tallSide = aIsLower ? sideB : sideA
          const lowCol = aIsLower ? pair[0] : pair[1]

          const corner = low.at((lowSide * low.w) / 2, (end * low.h) / 2)
          const cross = lineCross(corner, low.ux, tall.at((tallSide * tall.w) / 2, 0), tall.uy)
          if (!cross) continue
          const reach: Vec = { x: cross.x - corner.x, y: cross.y - corner.y }
          const run = Math.hypot(reach.x, reach.y)
          const toTall = aIsLower ? dir : { x: -dir.x, y: -dir.y }
          // The extension has to run from the shorter column toward the
          // taller one. Where it points the other way the shorter column's
          // corner already reaches past its neighbour's side, so there is no
          // notch — filling there would extend the taller column instead.
          if (run < 1e-6 || dot(reach, toTall) <= 0 || run > span) continue

          // Deep enough to land in material the two columns already share.
          let depth = low.h
          for (const k of lowCol) {
            const w = byId.get(k.id)
            if (w) depth = Math.max(depth, Math.hypot(w.x - low.c.x, w.y - low.c.y) + low.h)
          }
          const downLow: Vec = { x: -end * low.uy.x * depth, y: -end * low.uy.y * depth }
          const downTall: Vec = { x: -end * tall.uy.x * depth, y: -end * tall.uy.y * depth }
          const quad: Vec[] = [
            corner,
            cross,
            { x: cross.x + downTall.x, y: cross.y + downTall.y },
            { x: corner.x + downLow.x, y: corner.y + downLow.y },
          ]
          let area = 0
          for (let v = 0; v < quad.length; v++) {
            const p = quad[v]
            const q = quad[(v + 1) % quad.length]
            area += p.x * q.y - q.x * p.y
          }
          const ordered = area < 0 ? [...quad].reverse() : quad
          const ring: Ring = ordered.map((p) => [snap(p.x), snap(p.y)])
          ring.push(ring[0])
          out.push([ring])
        }
      }
    }
  }
  return out
}

/** The annular sector a curved stack sweeps, as one polygon.
 *
 * A curved stack is one arc, and it should read as one: unioning the keys'
 * own footprints instead leaves a scallop at every junction, because two
 * tangent rectangles at different angles meet at a point and fall away from
 * each other either side of it. That is the row of little notches along a
 * thumb cluster's edge, and no amount of gap tuning removes them — they are
 * what a polygon approximation of an arc looks like.
 *
 * So the arc is described directly. The band runs from the inner faces of the
 * keys to their outer corners, across the whole sweep, and unions with the
 * keys' own rectangles to square off the two ends. Its angular reach stops
 * exactly at the end keys' outer corners, so the arc meets the straight end
 * faces without a step.
 *
 * The arc is recovered from the placed keys rather than read off the layout:
 * each key sits tangent, so its across-axis is a radius, and two of them
 * cross at the centre. That way the group can be nested, rotated or mirrored
 * and the band still lands on it. */
function stackArcFills(
  doc: Doc,
  worlds: { key: Key; world: XForm; mirrored: boolean }[],
  sizeOf: (key: Key) => { w: number; h: number },
  pad: number,
): Polygon[] {
  const out: Polygon[] = []
  for (const group of doc.groups) {
    if (group.layout.kind !== 'stack') continue
    if (!group.layout.curve) continue
    const alongX = group.layout.axis === 'x'
    const members = doc.keys
      .filter((k) => k.groupId === group.id)
      .sort((a, b) => (alongX ? a.x - b.x : b.y - a.y))
    if (members.length < 2) continue

    for (const mirrored of [false, true]) {
      const byId = new Map(
        worlds.filter((w) => w.mirrored === mirrored).map((w) => [w.key.id, w.world] as const),
      )
      if (byId.size === 0) continue
      const placed = members.flatMap((key) => {
        const world = byId.get(key.id)
        if (!world) return []
        const size = sizeOf(key)
        const frame = keyFrame(world, size.w, size.h)
        return [{
          c: frame.c,
          // The key's across-axis points along a radius of the arc.
          radial: alongX ? frame.uy : frame.ux,
          along: (alongX ? size.w : size.h) / 2 + pad,
          across: (alongX ? size.h : size.w) / 2 + pad,
        }]
      })
      if (placed.length < 2) continue

      const first = placed[0]
      const last = placed[placed.length - 1]
      const centre = lineCross(first.c, first.radial, last.c, last.radial)
      if (!centre) continue

      const radiusOf = (p: (typeof placed)[number]) =>
        Math.hypot(p.c.x - centre.x, p.c.y - centre.y)
      let inner = Infinity
      let outer = 0
      for (const p of placed) {
        const r = radiusOf(p)
        inner = Math.min(inner, r - p.across)
        outer = Math.max(outer, Math.hypot(r + p.across, p.along))
      }
      // An arc tighter than the keys standing on it has no band to draw.
      if (!(inner > 0.5) || !(outer > inner)) continue

      const angleOf = (p: (typeof placed)[number]) =>
        Math.atan2(p.c.y - centre.y, p.c.x - centre.x)
      // Unwrap against the first key so a sweep across ±π stays monotonic.
      const base = angleOf(first)
      const wrapped = placed.map((p) => {
        let a = angleOf(p) - base
        while (a > Math.PI) a -= 2 * Math.PI
        while (a < -Math.PI) a += 2 * Math.PI
        return a
      })
      // Reach past the outermost keys' centres to where their outer corners
      // sit, and no further: that is where the band's arc has to hand over to
      // the straight end face. Mirroring reverses the sweep, so the ends are
      // found by angle rather than by position in the list.
      let loAt = 0
      let hiAt = 0
      wrapped.forEach((a, i) => {
        if (a < wrapped[loAt]) loAt = i
        if (a > wrapped[hiAt]) hiAt = i
      })
      const overhang = (p: (typeof placed)[number]) =>
        Math.atan2(p.along, radiusOf(p) + p.across)
      const lo = wrapped[loAt] - overhang(placed[loAt])
      const hi = wrapped[hiAt] + overhang(placed[hiAt])
      const sweep = hi - lo
      if (sweep <= 1e-6 || sweep >= 2 * Math.PI) continue

      const ring: Ring = []
      const arc = (radius: number, from: number, to: number) => {
        const steps = Math.max(1, Math.ceil(Math.abs(to - from) / arcStep(radius)))
        for (let i = 0; i <= steps; i++) {
          const a = base + from + ((to - from) * i) / steps
          ring.push([
            snap(centre.x + radius * Math.cos(a)),
            snap(centre.y + radius * Math.sin(a)),
          ])
        }
      }
      arc(outer, lo, hi)
      arc(inner, hi, lo)
      ring.push(ring[0])
      out.push([ring])
    }
  }
  return out
}

/** Union the arc bands onto an outline that has already been despiked.
 *
 * Order matters. `trimSpikes` drops any convex corner standing less than
 * `NUB_HEIGHT` proud of its neighbours' chord, and every vertex of a smoothly
 * tessellated arc does exactly that — it would decimate a 65-vertex band into
 * a nine-sided polygon a good half-millimetre inside its own radius, which is
 * the opposite of drawing the arc directly. Worse, the decimation runs in ring
 * order, so a board and its mirror image lose different vertices and the two
 * halves stop matching. The bands are clean by construction and have nothing
 * to despike, so they go on afterwards. */
function withArcBands(mp: MultiPolygon, bands: Polygon[]): MultiPolygon {
  if (bands.length === 0) return mp
  return robustClip((s) => polygonClipping.union(s), [...mp, ...bands])
}

/** How far a corner must stand proud to count as a feature rather than a
 * sliver, mm. Where two angled pitch areas cross — splayed columns, a curved
 * stack — the union leaves saw teeth a fraction of a millimetre tall (0.33 mm
 * at worst across splay angles up to 30°), while a real key corner stands
 * 13 mm or more out, so there is a wide band to sit in. Trimming a little
 * past the teeth also lets the chords they leave behind collapse, which is
 * what turns a stepped run into a clean one. */
const NUB_HEIGHT = 1

/** Cut protruding slivers off an outline. A convex corner poking less than
 * `maxHeight` past the straight line between its neighbours is dropped and
 * the boundary takes that chord instead — precisely the little triangle
 * between two angled keys.
 *
 * Deliberately one-sided: it only ever removes material, so concave detail
 * survives and the outline still follows the keys. Filling the concave side
 * as well would bridge the valley where splayed columns fan apart, which is
 * real shape rather than an artefact. */
function trimSpikes(mp: MultiPolygon, maxHeight: number): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => trimSpikeRing(ring, maxHeight)))
}

function trimSpikeRing(ring: Ring, maxHeight: number): Ring {
  let pts = ring as [number, number][]
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts = pts.slice(0, -1)
  }
  if (pts.length < 4) return ring
  for (let pass = 0; pass < 8 && pts.length > 3; pass++) {
    const drop = new Set<number>()
    const n = pts.length
    for (let i = 0; i < n; i++) {
      // Never collapse two neighbouring corners at once; the next pass can
      // take the second one once the chord has settled.
      if (drop.has((i - 1 + n) % n)) continue
      const p = pts[(i - 1 + n) % n]
      const v = pts[i]
      const q = pts[(i + 1) % n]
      // Canonical winding puts material to the left of the traversal for
      // outer rings and holes alike, so a left turn is a protrusion in both.
      const cross = (v[0] - p[0]) * (q[1] - v[1]) - (v[1] - p[1]) * (q[0] - v[0])
      if (cross <= 0) continue
      const chord = Math.hypot(q[0] - p[0], q[1] - p[1])
      // |cross| / chord is the corner's perpendicular height over the chord.
      if (chord > 1e-9 && cross / chord < maxHeight) drop.add(i)
    }
    if (drop.size === 0) break
    pts = pts.filter((_, i) => !drop.has(i))
  }
  const out: Ring = pts.map(([x, y]) => [snap(x), snap(y)])
  out.push(out[0])
  return out
}

/** Round convex corners with radius r and concave ones with `sc`, while also
 * filling concave gaps narrower than 2*sc: morphological open(r) followed by
 * close(sc), fused into erode(r) → dilate(r + sc) → erode(sc). Unlike
 * per-vertex fillets this gives every corner the exact radius regardless of
 * how short its edges are — short steps become clean S-curves. */
function smoothOutline(mp: MultiPolygon, r: number, sc: number): MultiPolygon {
  if (mp.length === 0) return mp
  try {
    return simplify(erode(dilate(erode(mp, r), r + sc), sc), 0.05)
  } catch (error) {
    console.warn('keebforge: outline smoothing failed, keeping raw outline', error)
    return mp
  }
}

/** Morphological closing: fill concave gaps narrower than 2r without moving
 * the rest of the boundary. Runs per polygon (separate clusters never get
 * bridged) and only on polygons that actually contain a narrow gap. */
function closeGaps(mp: MultiPolygon, r: number): MultiPolygon {
  if (mp.length === 0 || r <= 0) return mp
  const out: MultiPolygon = []
  for (const poly of mp) {
    if (!hasNarrowGap(poly, 2 * r + 0.2)) {
      out.push(poly)
      continue
    }
    try {
      const clean = simplify([poly], 0.02)
      out.push(...dropDebris(simplify(erode(dilate(clean, r), r), 0.05), 1))
    } catch (error) {
      console.warn('keebforge: gap closing failed, keeping raw outline', error)
      out.push(poly)
    }
  }
  return out
}

/** World transforms of all keys, including mirrored copies when enabled.
 * Keys or groups with mirroring turned off contribute no mirrored copy. */
function keyWorlds(doc: Doc): { key: Key; world: XForm; mirrored: boolean }[] {
  const groups = groupMap(doc.groups)
  const result = doc.keys.map((key) => ({
    key,
    world: keyWorldXF(key, groups),
    mirrored: false,
  }))
  if (doc.mirror.enabled) {
    const axis = doc.mirror.axis
    for (const { key, world } of [...result]) {
      if (!isKeyMirrored(key, groups)) continue
      result.push({
        key,
        world: { x: 2 * axis - world.x, y: world.y, r: -world.r },
        mirrored: true,
      })
    }
  }
  return result
}

/** Key worlds grouped per case piece: one list for a mono-block, two (left
 * half, mirrored half) when the case is split. */
function keyWorldSides(doc: Doc): {
  worlds: { key: Key; world: XForm; mirrored: boolean }[]
  half: 'both' | 'left' | 'right'
}[] {
  const worlds = keyWorlds(doc)
  if (!doc.mirror.enabled || doc.mirror.split !== true) {
    return [{ worlds, half: 'both' }]
  }
  return [
    { worlds: worlds.filter((w) => !w.mirrored), half: 'left' as const },
    { worlds: worlds.filter((w) => w.mirrored), half: 'right' as const },
  ].filter((side) => side.worlds.length > 0)
}

interface CaseMargins {
  left: number
  right: number
  top: number
  bottom: number
}

/** Expand a solid outward by per-direction margins (world axes), as the
 * union of the shape with translated copies. Concavities narrower than a
 * margin are handled by the smoothing/closing that follows. */
function expandMargins(mp: MultiPolygon, m: CaseMargins): MultiPolygon {
  const shifts: [number, number][] = []
  if (m.right > 0) shifts.push([m.right, 0])
  if (m.left > 0) shifts.push([-m.left, 0])
  if (m.top > 0) shifts.push([0, m.top])
  if (m.bottom > 0) shifts.push([0, -m.bottom])
  if (shifts.length === 0) return mp
  const parts: Polygon[] = [...mp]
  for (const [dx, dy] of shifts) {
    for (const poly of mp) {
      parts.push(
        poly.map((ring) =>
          ring.map(([x, y]) => [snap(x + dx), snap(y + dy)] as Ring[number]),
        ),
      )
    }
  }
  return robustClip((s) => polygonClipping.union(s), parts)
}

/** Outer plate/foam outline: the union of every key's pitch area padded by
 * `padding` mm on all sides. Disjoint clusters produce multiple polygons.
 * Memoized on the doc slices it reads — plate, foam, 2D badge and 3D preview
 * all ask for the same outline per edit. */
let plateCache: {
  keys: Doc['keys']
  groups: Doc['groups']
  mirror: Doc['mirror']
  plate: Doc['plate']
  result: MultiPolygon
} | null = null

export function plateOutline(doc: Doc): MultiPolygon {
  if (
    plateCache &&
    plateCache.keys === doc.keys &&
    plateCache.groups === doc.groups &&
    plateCache.mirror === doc.mirror &&
    plateCache.plate === doc.plate
  ) {
    return plateCache.result
  }
  const pad = doc.plate.padding
  const result: MultiPolygon = []
  for (const side of keyWorldSides(doc)) {
    const rects: Polygon[] = side.worlds.map(({ key, world }) => {
      const size = keySize(key)
      return rectPoly(world, size.w + 2 * pad, size.h + 2 * pad)
    })
    if (rects.length === 0) continue
    result.push(
      ...closeGaps(
        withArcBands(
          trimSpikes(
            robustClip((s) => polygonClipping.union(s), [
              ...rects,
              ...columnJoinFills(doc, side.worlds, keySize, pad),
            ]),
            NUB_HEIGHT,
          ),
          stackArcFills(doc, side.worlds, keySize, pad),
        ),
        MIN_FEATURE / 2,
      ),
    )
  }
  plateCache = {
    keys: doc.keys,
    groups: doc.groups,
    mirror: doc.mirror,
    plate: doc.plate,
    result,
  }
  return result
}

/** Switch cutout rectangles (one per key, sized per switch type plus optional
 * per-side clearance). */
export function switchCutouts(doc: Doc, clearance = 0): MultiPolygon {
  return keyWorlds(doc).map(({ key, world }) => {
    const size = CUTOUT[key.type] + 2 * clearance
    return rectPoly(world, size, size)
  })
}

/** Bezel ring around the keycaps. The opening always follows the keycap
 * contour padded by `outset`. In `tight` mode the outer edge follows the same
 * contour `width` further out; in `box` mode it is the axis-aligned bounding
 * rectangle of all keycaps padded by `outset + width`, so the rim fills the
 * whole box down to the keys. Corners on both edges are filleted by
 * `radius`. */
interface BezelSolids {
  outer: MultiPolygon
  opening: MultiPolygon
}

let solidsCache: {
  keys: Doc['keys']
  groups: Doc['groups']
  mirror: Doc['mirror']
  bezel: Doc['bezel']
  controller: Doc['controller']
  result: BezelSolids[]
} | null = null

/** Per case piece: the bezel's outer solid and the keycap opening. Cached
 * like plateOutline — the ring (bezelShape) and the bottom outline both
 * derive from these. */
function bezelSolids(doc: Doc): BezelSolids[] {
  if (
    solidsCache &&
    solidsCache.keys === doc.keys &&
    solidsCache.groups === doc.groups &&
    solidsCache.mirror === doc.mirror &&
    solidsCache.bezel === doc.bezel &&
    solidsCache.controller === doc.controller
  ) {
    return solidsCache.result
  }
  const result = bezelSolidsUncached(doc)
  solidsCache = {
    keys: doc.keys,
    groups: doc.groups,
    mirror: doc.mirror,
    bezel: doc.bezel,
    controller: doc.controller,
    result,
  }
  return result
}

/** One case piece of the hollow top shell plus the bottom tray, as
 * extrudable outlines. The plate and foam are sized to the cavity, so
 * nothing interpenetrates: `hull` ⊃ `interior` (wall width in) ⊃ `inner`
 * (ridge width further in).
 *
 * Every member below `hull` is a getter that offsets on first read and then
 * memoizes. The 2D editor draws the case as a single contour and so touches
 * only `hull` and `rim`; computing the cavity, the drop-in fit contour and
 * the tray ridge eagerly meant it paid for the whole 3D part stack on every
 * edit without ever drawing it. */
export interface CaseShell {
  /** Outer footprint with interior islands/holes discarded. */
  hull: MultiPolygon
  /** Cavity contour: hull eroded by the wall width. Kept sharp — this is
   * the top case's inside face. */
  interior: MultiPolygon
  /** Interior with convex corners rounded for drop-in fit: the plate's
   * outline and the tray ridge's outer contour. */
  fit: MultiPolygon
  /** Fit contour minus the tray ridge, also corner-rounded. Foam goes here. */
  inner: MultiPolygon
  /** Wall ring (hull − interior): lid plane up to the plate top. */
  wall: MultiPolygon
  /** Rim ring (hull − keycap opening): above the plate top. */
  rim: MultiPolygon
  /** Tray-ridge ring (interior − inner): part of the BOTTOM — it rises from
   * the lid to the plate's underside, sandwiching the plate between itself
   * and the rim above. */
  ridge: MultiPolygon
}

let shellCache: {
  solids: BezelSolids[]
  ridgeW: number
  result: CaseShell[]
} | null = null

export function caseShells(doc: Doc): CaseShell[] {
  const solids = bezelSolids(doc)
  const ridgeW = doc.bottom.enabled ? Math.max(0, doc.bottom.ridge ?? 0) : 0
  if (shellCache && shellCache.solids === solids && shellCache.ridgeW === ridgeW) {
    return shellCache.result
  }
  const wallW = Math.max(0.8, doc.bezel.width)
  const diff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => {
    if (a.length === 0) return []
    if (b.length === 0) return a
    try {
      return robustClip((s, c) => polygonClipping.difference(s, c!), a, b)
    } catch (error) {
      console.warn('keebforge: case ring generation failed', error)
      return a
    }
  }
  // Fit rounding: morphological open — material is only ever removed, so a
  // rounded part can never clip the sharp cavity it drops into. The wall's
  // own inside face intentionally stays sharp.
  const FIT_R = 1.5
  const round = (mp: MultiPolygon): MultiPolygon => {
    if (mp.length === 0) return mp
    try {
      return simplify(dilate(erode(mp, FIT_R), FIT_R), 0.05)
    } catch (error) {
      console.warn('keebforge: fit rounding failed', error)
      return mp
    }
  }
  /** Run `compute` at most once, on first read. */
  const once = <T,>(compute: () => T): (() => T) => {
    let done = false
    let value: T
    return () => {
      if (!done) {
        value = compute()
        done = true
      }
      return value
    }
  }
  const result: CaseShell[] = solids.map((s) => {
    const hull: MultiPolygon = s.outer.map((poly) => [poly[0]])
    const interior = once(() => {
      try {
        return simplify(erode(hull, wallW), 0.05)
      } catch (error) {
        console.warn('keebforge: case interior generation failed', error)
        return [] as MultiPolygon
      }
    })
    const fit = once(() => round(interior()))
    const inner = once(() => {
      if (ridgeW <= 0 || fit().length === 0) return fit()
      try {
        return round(simplify(erode(fit(), ridgeW), 0.05))
      } catch (error) {
        console.warn('keebforge: tray ridge generation failed', error)
        return fit()
      }
    })
    const wall = once(() => diff(hull, interior()))
    const rim = once(() => diff(hull, s.opening))
    const ridge = once(() => (inner() === fit() ? [] : diff(fit(), inner())))
    return {
      hull,
      get interior() {
        return interior()
      },
      get fit() {
        return fit()
      },
      get inner() {
        return inner()
      },
      get wall() {
        return wall()
      },
      get rim() {
        return rim()
      },
      get ridge() {
        return ridge()
      },
    }
  })
  shellCache = { solids, ridgeW, result }
  return result
}

/** The bezel ring as seen from above (2D badge and DXF): hull − opening. */
export function bezelShape(doc: Doc): MultiPolygon {
  return caseShells(doc).flatMap((s) => s.rim)
}

/** Footprint of the case bottom: the shell hull (no keycap opening), or the
 * plate outline when there is no bezel to follow, optionally eroded inward
 * by the bottom's inset. */
export function caseBottomOutline(doc: Doc): MultiPolygon {
  const outline =
    doc.bezel.enabled && doc.bezel.width > 0
      ? caseShells(doc).flatMap((s) => s.hull)
      : plateOutline(doc)
  const inset = doc.bottom.inset ?? 0
  if (inset <= 0) return outline
  try {
    return simplify(erode(outline, inset), 0.05)
  } catch (error) {
    console.warn('keebforge: bottom inset failed, keeping full outline', error)
    return outline
  }
}

export interface BoxRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Split halves only take their margin on the outward edge. */
function marginsFor(half: 'left' | 'right' | 'both', bezel: Doc['bezel']): CaseMargins {
  return {
    top: bezel.marginTop ?? 0,
    bottom: bezel.marginBottom ?? 0,
    left: half === 'right' ? 0 : bezel.marginLeft ?? 0,
    right: half === 'left' ? 0 : bezel.marginRight ?? 0,
  }
}

/** The rectangle a `box`-mode piece is built from: the keycap bounding box
 * padded by outset + wall width, plus per-side margins. Screw placement
 * anchors on its corners rather than rediscovering them in the outline. */
export function bezelBoxes(doc: Doc): BoxRect[] {
  const bezel = doc.bezel
  if (!bezel.enabled || bezel.width <= 0 || bezel.mode !== 'box') return []
  const pad = bezel.outset + bezel.width
  return keyWorldSides(doc).map((side) => {
    const margins = marginsFor(side.half, bezel)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const { key, world } of side.worlds) {
      const size = capSize(key)
      for (const [x, y] of rectPoly(world, size.w, size.h)[0]) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    return {
      minX: minX - pad - margins.left,
      minY: minY - pad - margins.bottom,
      maxX: maxX + pad + margins.right,
      maxY: maxY + pad + margins.top,
    }
  })
}

/** What the case has to grow around to contain a controller module: the
 * board plus its brackets, pushed out by the wall width so the wall closes
 * around them rather than cutting through.
 *
 * Without this a board placed past the edge of the key field simply has no
 * case over it — the outline is built from the keys, and a controller is not
 * a key. Only the outer solid gets it; putting it in the keycap opening
 * would punch a hole in the bezel instead of bulging it.
 *
 * A PCB-mounted controller needs none of this: it is already under the plate,
 * inside a cavity the keys defined. */
function controllerHullPad(
  doc: Doc,
  half: 'both' | 'left' | 'right',
  wall: number,
): Polygon[] {
  const c = doc.controller
  if (!c?.enabled || c.mode !== 'mcu') return []
  const frames = controllerFrames(doc)
  // Sides come back in the same order controllerFrames does: the board you
  // placed, then its mirror.
  const picked =
    half === 'both' ? frames : half === 'left' ? frames.slice(0, 1) : frames.slice(1)
  if (picked.length === 0) return []
  const pad = c.fit + BRACKET.wall
  const solid = robustClip((s) => polygonClipping.union(s), [
    ...picked.map((f) => rectPoly(f.xf, c.width + 2 * pad, c.length + 2 * pad)),
  ])
  // Past the wall *and* the tray ridge. Clearing only the wall grows the case
  // so that the ridge — which sits inboard of it — lands right back on top of
  // the board, and the collision check then flags a ridge that exists only
  // because the module is there. Measured at 103 mm² of self-inflicted
  // overlap on a default board.
  const ridge = doc.bottom.enabled ? Math.max(0, doc.bottom.ridge ?? 0) : 0
  return dilate(solid, wall + ridge + 0.5)
}

function bezelSolidsUncached(doc: Doc): BezelSolids[] {
  const bezel = doc.bezel
  if (!bezel.enabled || bezel.width <= 0) return []
  // Rounding (and, via its closing phase, wedge-gap filling) happens on the
  // opening and outer solids separately, each with its own radius, so the
  // ring's two edges get exact, independent corner radii. A split case runs
  // the whole pipeline per half (each half gets its own box, notably).
  const sc = MIN_FEATURE / 2
  const prep = (mp: MultiPolygon, radius: number): MultiPolygon => {
    const r = Math.max(0, Math.min(radius, 6))
    return r > 0 ? smoothOutline(mp, r, sc) : closeGaps(mp, sc)
  }
  const result: BezelSolids[] = []
  const boxes = bezelBoxes(doc)
  const sides = keyWorldSides(doc)
  for (const [index, side] of sides.entries()) {
    const capRects = (pad: number): Polygon[] =>
      side.worlds.map(({ key, world }) => {
        const size = capSize(key)
        return rectPoly(world, size.w + 2 * pad, size.h + 2 * pad)
      })
    const margins = marginsFor(side.half, bezel)
    const capUnion = (pad: number, trim: number) =>
      withArcBands(
        trimSpikes(
          robustClip((s) => polygonClipping.union(s), [
            ...capRects(pad),
            ...columnJoinFills(doc, side.worlds, capSize, pad),
          ]),
          trim,
        ),
        stackArcFills(doc, side.worlds, capSize, pad),
      )
    // Trimming the opening eats into the keycap clearance, so it never cuts
    // deeper than half the outset. The outer edge has nothing to clear and
    // takes the full height.
    const opening = prep(
      capUnion(bezel.outset, Math.min(NUB_HEIGHT, bezel.outset / 2)),
      bezel.radiusInner ?? 0,
    )
    let outer: MultiPolygon
    if (bezel.mode === 'tight') {
      outer = prep(
        expandMargins(
          withArcBands(
            capUnion(bezel.outset + bezel.width, NUB_HEIGHT),
            controllerHullPad(doc, side.half, bezel.width),
          ),
          margins,
        ),
        bezel.radiusOuter ?? 0,
      )
    } else {
      const b = boxes[index]
      outer = prep(
        [
          [
            [
              [b.minX, b.minY],
              [b.maxX, b.minY],
              [b.maxX, b.maxY],
              [b.minX, b.maxY],
              [b.minX, b.minY],
            ],
          ],
        ],
        bezel.radiusOuter ?? 0,
      )
    }
    result.push({ outer, opening })
  }
  return result
}

// ---- Mounting -------------------------------------------------------------

/** M2 self-tapping screw dimensions (radii/lengths in mm). The screw passes
 * freely through the lid and cuts its own thread in the wall above, so the
 * two holes are deliberately different sizes: the lid's bore is oversized
 * past the shank, the wall's pilot is undersized so the thread can bite. */
export const SCREW = {
  /** Clearance bore through the bottom lid — wider than the shank, so the
   * screw slides through instead of tapping into it. */
  lidHoleR: 1.25,
  /** Pilot hole in the top-case wall — narrower than the shank, leaving
   * material for the self-tapping thread to cut into. */
  pilotR: 0.8,
  /** Major radius of the countersink seat in the lid's underside. */
  cskR: 2,
  /** Shaft/head radii and lengths for the 3D-preview proxy. */
  shaftR: 0.9,
  headR: 1.9,
  /** Head cone height. The head is a 90° countersunk one, so it rises by
   * exactly the radius it narrows over. */
  headH: 1,
  /** Thread engagement into the wall above the lid's top face. */
  bite: 6,
}

/** Depth of the lid's countersink. The seat is a 90° cone, so it sinks by
 * exactly the radius it opens by — head flush with the underside. */
export const CSK_DEPTH = SCREW.cskR - SCREW.lidHoleR


/** Perimeter of a ring, corrected for the length tessellation loses.
 *
 * A chord under-measures the arc it stands in for, and by more at `draft`
 * than at `fine` — 413.53 mm against 411.53 mm on the same outline, half a
 * percent. Screw count is `round(perimeter / spacing)`, and half a percent is
 * plenty to walk that across a rounding boundary: `default(r6)` lands on
 * 7.519 at fine and 7.482 at draft, so a screw appears and disappears as you
 * drag.
 *
 * The correction is exact for a circular arc. A chord spanning turn θ of a
 * circle of radius r measures 2r·sin(θ/2) where the arc is rθ, so scaling by
 * (θ/2)/sin(θ/2) recovers the arc — with no reference to how many chords the
 * tessellator chose to spend on it, which is the whole point.
 *
 * Turns past roughly twice the tessellator's own step are real corners, not
 * arc samples, and are left alone: stretching the edges either side of a
 * square corner by 11% would not be a rounding error, it would be wrong. */
/** Vertex-dropping tolerance for the length the screw count is measured
 * against. Deliberately coarser than `draft`'s own sagitta, so a ring
 * sampled at either quality reduces to nearly the same polyline before it
 * is measured — the arc correction below can only recover what a chord
 * stands in for, and it cannot see that `simplify` dropped different
 * vertices at the two resolutions. */
const COUNT_EPS = 0.4

/** The length the screw count is derived from: reduced to a canonical
 * resolution first, then corrected for arc-vs-chord. Both steps exist to
 * stop `round(length / spacing)` from landing on different sides of a
 * boundary at `fine` and at `draft`. */
function canonicalPerimeter(pts: [number, number][]): number {
  const closed = [...pts, pts[0]] as Ring
  const reduced = simplifyRing(closed, COUNT_EPS)
  return smoothPerimeter(reduced.slice(0, -1) as [number, number][])
}

function smoothPerimeter(pts: [number, number][]): number {
  const n = pts.length
  const cap = Math.min(Math.PI / 3, 2 * QUALITY[quality].maxStep)
  const turns: number[] = []
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i + n - 1) % n]
    const [x, y] = pts[i]
    const [qx, qy] = pts[(i + 1) % n]
    const ax = x - px
    const ay = y - py
    const bx = qx - x
    const by = qy - y
    if (ax * ax + ay * ay < 1e-18 || bx * bx + by * by < 1e-18) {
      turns.push(0)
      continue
    }
    const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))
    turns.push(turn > cap ? 0 : turn)
  }
  let total = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1])
    // Each chord carries half the turn at either end of it.
    const theta = (turns[i] + turns[j]) / 2
    total += theta < 1e-6 ? len : (len * (theta / 2)) / Math.sin(theta / 2)
  }
  return total
}

/** Evenly spaced points along a ring's perimeter, `spacing` mm apart,
 * phase-anchored at the corner farthest from the ring's centroid, so screws
 * land in corners first. Used for `tight` outlines, which have no canonical
 * corners; `box` pieces take their screws from the rectangle they were built
 * from instead.
 *
 * Both halves of that anchor have to be independent of how finely the ring
 * happens to be tessellated, or the whole layout rotates when the outline is
 * rebuilt at a different resolution — which it is, on every drag, since
 * `draft` quality re-samples every arc:
 *
 * - the centroid is the *area* centroid, not the average of the vertices.
 *   A vertex average follows the sample density, so adding points to a
 *   fillet drags it toward that fillet — measured at 2.5 mm between `fine`
 *   and `draft`, which was enough to flip which corner came out farthest and
 *   move every screw on the board.
 * - ties are broken by angle about the centroid rather than by vertex order,
 *   so a near-tie resolves the same way whatever the sampling. */
function sampleRing(ring: Ring, spacing: number): [number, number][] {
  let pts = ring as [number, number][]
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts = pts.slice(0, -1)
  }
  const n = pts.length
  if (n < 3) return []
  const cum = [0]
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    cum.push(cum[i] + Math.hypot(x2 - x1, y2 - y1))
  }
  const total = cum[n]
  // Too small a piece to be worth fastening (or to fit screws at all).
  if (total < 40) return []
  // Area centroid. Degenerate rings (zero enclosed area) fall back to the
  // vertex average, which is all there is to work with.
  let cx = 0
  let cy = 0
  let a2 = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    const cross = x1 * y2 - x2 * y1
    a2 += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  if (Math.abs(a2) > 1e-9) {
    cx /= 3 * a2
    cy /= 3 * a2
  } else {
    cx = 0
    cy = 0
    for (const [x, y] of pts) {
      cx += x / n
      cy += y / n
    }
  }
  const at = (s: number): [number, number] => {
    const t = ((s % total) + total) % total
    let i = 0
    while (i < n - 1 && cum[i + 1] <= t) i++
    const f = (t - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i])
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    return [x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]
  }

  // Anchor where the ring crosses the vertical through its own centroid, at
  // the topmost such crossing — the middle of the far edge. Interpolated
  // along the crossing edge, so it is a point on the *shape* and no vertex
  // has to exist there; re-tessellating cannot move it.
  //
  // Anchoring on a corner instead reads better in principle — screws land in
  // corners first — but there is no way to pick one that survives a rebuild.
  // On a symmetric board the two farthest corners are exactly tied (measured
  // 134.470 against 134.399 mm on `example(tight)`, 0.05% apart), so whichever
  // one wins is decided by sampling noise, and the whole ring rotates when it
  // flips. The crossing has the opposite property: on a mirrored board it sits
  // *on* the axis of symmetry, which is the one place a tie cannot form.
  let start = 0
  let anchor = 0
  let top = -Infinity
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    if (x1 - cx > 0 === x2 - cx > 0) continue
    const f = (cx - x1) / (x2 - x1)
    const y = y1 + (y2 - y1) * f
    if (y <= top) continue
    top = y
    start = i
    anchor = cum[i] + f * (cum[i + 1] - cum[i])
  }
  if (top === -Infinity) {
    // No crossing: the ring does not span its own centroid's abscissa, which
    // takes a degenerate outline. Any repeatable choice will do.
    let best = -1
    for (let i = 0; i < n; i++) {
      const d = (pts[i][0] - cx) ** 2 + (pts[i][1] - cy) ** 2
      if (d > best) {
        best = d
        start = i
      }
    }
    anchor = cum[start]
  }
  // Positions are laid out along `total`, the ring as actually tessellated,
  // since that is the parameterisation `at()` walks. Only the count comes
  // off the corrected length, because only the count has a threshold in it.
  const count = Math.max(2, Math.round(canonicalPerimeter(pts) / spacing))
  const out: [number, number][] = []
  for (let k = 0; k < count; k++) out.push(at(anchor + (k * total) / count))
  return out
}

/** Screws for a box case: one in each corner, with the edges between them
 * subdivided into equal steps no longer than `spacing`. `e` is how far in
 * from the outer face the screw line sits. A corner screw follows the outer
 * fillet — pulled diagonally inward so it stays `e` clear of the rounded
 * edge rather than sitting where the sharp corner would have been. */
function sampleBoxRect(
  box: BoxRect,
  e: number,
  bezel: Doc['bezel'],
  spacing: number,
): [number, number][] {
  const w = box.maxX - box.minX - 2 * e
  const h = box.maxY - box.minY - 2 * e
  // Too small a piece to be worth fastening (or to fit screws at all).
  if (w <= 0 || h <= 0 || 2 * (w + h) < 40) return []
  // `prep` clamps the fillet radius, so match it here.
  const radius = Math.max(0, Math.min(bezel.radiusOuter ?? 0, 6))
  const spineR = Math.max(0, radius - e)
  const off = radius > e ? radius - spineR / Math.SQRT2 : e
  const corners: [number, number][] = [
    [box.minX + off, box.minY + off],
    [box.maxX - off, box.minY + off],
    [box.maxX - off, box.maxY - off],
    [box.minX + off, box.maxY - off],
  ]
  const out: [number, number][] = []
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i]
    const [x1, y1] = corners[(i + 1) % 4]
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / spacing))
    // k starts at 0, so each corner is emitted exactly once.
    for (let k = 0; k < steps; k++) {
      out.push([x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps])
    }
  }
  return out
}

let screwCache: {
  keys: Doc['keys']
  groups: Doc['groups']
  mirror: Doc['mirror']
  bezel: Doc['bezel']
  bottom: Doc['bottom']
  mounting: Doc['mounting']
  result: [number, number][]
} | null = null

/** Deepest a screw can sit inside the hull before its pilot leaves the
 * top-case wall band: material inboard of the wall belongs to the bottom
 * tray, which screws pass through rather than into. */
function deepestScrewLine(bezelWidth: number): number {
  const wallW = Math.max(0.8, bezelWidth)
  return Math.max(wallW - 1.2, wallW / 2)
}

/** Deepest bottom inset that still admits screws. An inset lid pulls its
 * edge inboard while the pilot must stay in the wall band, so past this
 * depth no position satisfies both and the lid cannot be fastened. */
export function maxScrewInset(bezelWidth: number): number {
  return deepestScrewLine(bezelWidth) - SCREW.cskR - 0.5
}

/** Make a screw layout symmetric about the mirror axis. Ring sampling walks
 * each outline from its own anchor, so a mirrored board would otherwise get
 * two independently-phased halves. Keep the left half plus anything sitting
 * on the axis, then reflect it — the right half becomes an exact mirror. */
function mirrorScrews(pts: [number, number][], axis: number): [number, number][] {
  // A sample this close to the axis is *the* centre screw, and becomes one
  // hole sitting on it. The tolerance has to be a real distance rather than
  // a numerical epsilon: at 0.05 mm, a sample landing 0.06 mm off the axis
  // took the other branch and produced a pair of screws 0.12 mm apart —
  // overlapping countersinks, and a layout that flipped between one hole and
  // two on a re-tessellation that moved the sample by a tenth of a
  // millimetre. Two countersinks that do not overlap are two screws; anything
  // closer was always meant to be one.
  const onAxis = SCREW.cskR
  const out: [number, number][] = []
  for (const [x, y] of pts) {
    if (Math.abs(x - axis) <= onAxis) out.push([axis, y])
    else if (x < axis) out.push([x, y], [2 * axis - x, y])
  }
  return out
}

/** Screw positions: evenly spaced along the bezel wall's centerline (the
 * outer solid eroded by half the wall width), per case piece and island.
 * The centerline is at least width/2 clear of both the keycap opening and
 * the outer face, so an M2 pilot always has wall material around it. */
export function screwPositions(doc: Doc): [number, number][] {
  // Screws exist to hold the lid on, so no lid means nothing to fasten.
  if (!doc.mounting.enabled || !doc.bezel.enabled || doc.bezel.width <= 0) return []
  if (!doc.bottom.enabled) return []
  // Past this inset the lid's edge has retreated inboard of every position
  // the wall can hold a pilot in — no screw could reach both.
  if (Math.max(0, doc.bottom.inset ?? 0) > maxScrewInset(doc.bezel.width)) return []
  if (
    screwCache &&
    screwCache.keys === doc.keys &&
    screwCache.groups === doc.groups &&
    screwCache.mirror === doc.mirror &&
    screwCache.bezel === doc.bezel &&
    screwCache.bottom === doc.bottom &&
    screwCache.mounting === doc.mounting
  ) {
    return screwCache.result
  }
  let result: [number, number][] = []
  try {
    // Deep enough into the piece that heads clear an inset lid's edge, but
    // the pilot must stay inside the top-case wall band — the ridge further
    // in belongs to the bottom tray, which screws pass through, not into.
    const inset = Math.max(0, doc.bottom.inset ?? 0)
    const e = Math.max(
      1,
      Math.min(
        Math.max(doc.bezel.width / 2, inset + SCREW.cskR + 0.5),
        deepestScrewLine(doc.bezel.width),
      ),
    )
    const spacing = Math.max(20, doc.mounting.spacing)
    const boxes = bezelBoxes(doc)
    if (boxes.length > 0) {
      // A box case is a known rectangle, so its four corners are the screw
      // positions — no need to rediscover them in the generated outline.
      for (const box of boxes) result.push(...sampleBoxRect(box, e, doc.bezel, spacing))
    } else {
      for (const shell of caseShells(doc)) {
        const spine = simplify(erode(shell.hull, e), 0.05)
        for (const poly of spine) result.push(...sampleRing(poly[0], spacing))
      }
    }
    if (doc.mirror.enabled) result = mirrorScrews(result, doc.mirror.axis)
  } catch (error) {
    console.warn('keebforge: screw placement failed', error)
  }
  screwCache = {
    keys: doc.keys,
    groups: doc.groups,
    mirror: doc.mirror,
    bezel: doc.bezel,
    bottom: doc.bottom,
    mounting: doc.mounting,
    result,
  }
  return result
}

/** Robust polygon difference for downstream geometry (chamfer bands). May
 * throw on degenerate input like the clipper it wraps — callers degrade. */
export function outlineDifference(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0) return []
  if (b.length === 0) return a
  return robustClip((s, c) => polygonClipping.difference(s, c!), a, b)
}

/** Vertical dimensions of the case stack and the outer face's draft profile,
 * shared by the 3D preview and the print export so both build the same
 * solids. Heights are world Y (0 = plate top); `insetAt` gives the outer
 * face's pull-in at any world height, and `breaks` the heights where that
 * profile changes slope. */
export interface CaseDims {
  /** Interior depth below the plate (switch bodies, board, sockets). */
  cavity: number
  /** World Y of the case interior's floor — the lid plane. */
  caseBottomY: number
  bottomThickness: number
  /** World Y of the bottom lid's underside — the resting plane. */
  restY: number
  /** Wall band height: lid plane up to the plate top. */
  wallH: number
  /** Rim band height above the plate top. */
  rimH: number
  /** Top-edge chamfer, clamped so it cannot consume the bezel. */
  bevel: number
  insetAt: (worldY: number) => number
  breaks: number[]
}

export function caseDims(doc: Doc): CaseDims {
  const cavity = doc.bottom.enabled
    ? Math.max(FOAM_THICKNESS, doc.bottom.clearance ?? 0)
    : FOAM_THICKNESS
  const caseBottomY = -PLATE_THICKNESS - cavity
  const bottomThickness = doc.bottom.enabled ? Math.max(0.5, doc.bottom.thickness) : 0
  const wallH = PLATE_THICKNESS + cavity
  const rimH = doc.bezel.height > 0 ? doc.bezel.height : 0
  const outerH = wallH + rimH
  // The face stays vertical up to the break, then tapers the rest of the way
  // to the top of the rim.
  const draft = Math.max(0, doc.bezel.draft ?? 0)
  const breakY = caseBottomY + Math.max(0, Math.min(doc.bezel.draftStart ?? 0, outerH))
  const taperH = caseBottomY + outerH - breakY
  return {
    cavity,
    caseBottomY,
    bottomThickness,
    restY: caseBottomY - bottomThickness,
    wallH,
    rimH,
    bevel: Math.min(doc.bezel.bevel ?? 0, doc.bezel.width / 2 - 0.05),
    insetAt: (y: number) =>
      taperH > 1e-6 ? (draft * Math.max(0, y - breakY)) / taperH : 0,
    breaks: [breakY],
  }
}

/** Punch circular holes of radius r at the given centers. Failures degrade
 * to the unpunched outline rather than crashing the preview/export. */
export function subtractDiscs(
  mp: MultiPolygon,
  centers: [number, number][],
  r: number,
): MultiPolygon {
  if (mp.length === 0 || centers.length === 0 || r <= 0) return mp
  try {
    const discs: MultiPolygon = centers.map(([x, y]) => discPoly(x, y, r))
    return robustClip((s, c) => polygonClipping.difference(s, c!), mp, discs)
  } catch (error) {
    console.warn('keebforge: hole punch failed, keeping solid outline', error)
    return mp
  }
}

/** Subtract arbitrary shapes rather than discs — the connector opening is a
 * rectangle, and like the screw holes it only applies to the height band it
 * actually passes through. Failure keeps the solid outline, on the grounds
 * that a case with no hole beats no case at all. */
export function subtractShapes(mp: MultiPolygon, cuts: MultiPolygon): MultiPolygon {
  if (mp.length === 0 || cuts.length === 0) return mp
  try {
    return robustClip((s, c) => polygonClipping.difference(s, c!), mp, cuts)
  } catch (error) {
    console.warn('keebforge: opening cut failed, keeping solid outline', error)
    return mp
  }
}

/** Plate shape: the case cavity's contour (so the plate drops into the
 * shell without clipping), or the padded key outline when there is no case,
 * minus switch cutouts. Holes appear as extra rings within each polygon. */
export function plateWithCutouts(doc: Doc, clearance = 0): MultiPolygon {
  const fit = caseShells(doc).flatMap((s) => s.fit)
  const outline = fit.length > 0 ? fit : plateOutline(doc)
  if (outline.length === 0) return []
  const cutouts = switchCutouts(doc, clearance)
  return robustClip((s, c) => polygonClipping.difference(s, c!), outline, cutouts)
}

/** PCB shape: the foam's footprint — inside the tray ridge, so the board
 * drops past the supporting lip — but solid, since a board is only pierced
 * by switch pins rather than cut away. */
export function pcbOutline(doc: Doc): MultiPolygon {
  const inner = caseShells(doc).flatMap((s) => s.inner)
  return inner.length > 0 ? inner : plateOutline(doc)
}

/** Foam shape: like the plate but inside the supporting lip, with extra
 * clearance around the switch housings. */
export function foamWithCutouts(doc: Doc): MultiPolygon {
  const inner = caseShells(doc).flatMap((s) => s.inner)
  const outline = inner.length > 0 ? inner : plateOutline(doc)
  if (outline.length === 0) return []
  const cutouts = switchCutouts(doc, FOAM_CLEARANCE)
  return robustClip((s, c) => polygonClipping.difference(s, c!), outline, cutouts)
}

// ---- Controller -----------------------------------------------------------

/** Corner brackets that hold a controller module down: four L-shaped walls
 * rising off the tray floor, each hugging one corner of the board from
 * outside. Dimensions in mm. */
export const BRACKET = {
  /** Wall thickness of a bracket leg. */
  wall: 1.6,
  /** How far a bracket runs along the board's long edge. */
  legLong: 7,
  /** How far it runs along the short edge. */
  legShort: 5,
  /** How far the brackets stand above the board's top face. Enough to stop
   * the board lifting, not so much that it cannot be pressed in past them. */
  rise: 1.2,
}

/** How far the connector cut reaches out past the board's port end. It only
 * ever gets subtracted from the wall ring, so overshooting the outside costs
 * nothing — but a board parked well away from the wall will cut the nearest
 * wall it does reach, which is why this is bounded rather than infinite. */
const PORT_REACH = 25

/** Where a controller board sits, in world space. `out` points from the
 * board's center towards its connector end and `side` across it, so board
 * coordinates are (u along out, v along side). */
export interface ControllerFrame {
  xf: XForm
  out: Vec
  side: Vec
  /** Board center to connector end, and to a long edge. */
  halfLength: number
  halfWidth: number
  /** Local (u, v) to world. */
  at: (u: number, v: number) => XForm
}

function frameFor(doc: Doc, xf: XForm): ControllerFrame {
  const rad = (xf.r * Math.PI) / 180
  // r = 0 points the connector end at +y, so `out` is the frame's local +y
  // and `side` its local +x — the same convention rectPoly uses, which lets
  // every piece below be an axis-aligned rectangle in board space.
  const out: Vec = { x: -Math.sin(rad), y: Math.cos(rad) }
  const side: Vec = { x: Math.cos(rad), y: Math.sin(rad) }
  return {
    xf,
    out,
    side,
    halfLength: doc.controller.length / 2,
    halfWidth: doc.controller.width / 2,
    at: (u, v) => ({
      x: xf.x + out.x * u + side.x * v,
      y: xf.y + out.y * u + side.y * v,
      r: xf.r,
    }),
  }
}

/** Every controller on the board: one, or one per half on a split.
 *
 * A mirrored unibody has a single controller — mirroring it would put two
 * boards in one case — but a split is two separate cases, and each needs its
 * own. So the controller follows `split` rather than `enabled`. */
export function controllerFrames(doc: Doc): ControllerFrame[] {
  const c = doc.controller
  if (!c?.enabled) return []
  const own = frameFor(doc, { x: c.x, y: c.y, r: c.r })
  if (!doc.mirror.enabled || !doc.mirror.split) return [own]
  return [own, frameFor(doc, { x: 2 * doc.mirror.axis - c.x, y: c.y, r: -c.r })]
}

/** The board's own footprint — drawn in the editor, and the proxy the 3D
 * preview stands in the case. */
export function controllerBoards(doc: Doc): MultiPolygon {
  return controllerFrames(doc).map((f) =>
    rectPoly(f.xf, doc.controller.width, doc.controller.length),
  )
}

/** Plan-view cut for the connector opening, to be subtracted from the wall
 * ring over the opening's height band. Reaches from just inside the board's
 * port end out through the wall. */
export function controllerPortCuts(doc: Doc): MultiPolygon {
  const c = doc.controller
  const inset = 3
  const depth = inset + PORT_REACH
  return controllerFrames(doc).map((f) =>
    rectPoly(f.at(f.halfLength - inset + depth / 2, 0), c.portWidth, depth),
  )
}

/** Plan-view footprint of the corner brackets.
 *
 * Each corner gets two rectangles that the union merges into an L: one along
 * the board's long edge and one across its short edge. At the connector end
 * the short-edge leg is cut back so it cannot grow across the port — a
 * bracket that reaches into the opening is a bracket you discover after
 * printing. */
export function controllerBrackets(doc: Doc): MultiPolygon {
  const c = doc.controller
  if (c.mode !== 'mcu') return []
  const t = BRACKET.wall
  const parts: Polygon[] = []
  for (const f of controllerFrames(doc)) {
    const a = f.halfLength + c.fit
    const b = f.halfWidth + c.fit
    for (const su of [1, -1] as const) {
      for (const sv of [1, -1] as const) {
        // Along the long edge, sitting just outside it. The long edges run
        // along `out`, which is the frame's local y, so the leg's length is
        // the rectangle's height and its wall thickness the width.
        parts.push(
          rectPoly(f.at(su * (a - BRACKET.legLong / 2), sv * (b + t / 2)), t, BRACKET.legLong),
        )
        // Across the short edge. At the connector end it has to stop clear of
        // the opening, and if that leaves nothing worth printing it is
        // dropped — the case wall is right there to stop the board anyway.
        const legShort =
          su > 0
            ? Math.min(BRACKET.legShort, b - c.portWidth / 2 - 0.5)
            : BRACKET.legShort
        if (legShort <= 0.5) continue
        parts.push(
          rectPoly(
            f.at(su * (a + t / 2), sv * (b + (t - legShort) / 2)),
            legShort + t,
            t,
          ),
        )
      }
    }
  }
  if (parts.length === 0) return []
  return robustClip((s) => polygonClipping.union(s), parts)
}

/** Does the connector opening actually break through the case wall?
 *
 * Placing the board is fiddly — a millimetre too far out and the cut only
 * nicks the wall's corner, a few too far in and it stops short of the outer
 * face — and neither reads as wrong until the part is printed. Answered with
 * two point-in-polygon tests rather than by clipping, since the inspector
 * asks on every render: the port end has to sit inside the case, and the far
 * end of its reach outside it. */
export function controllerPortReaches(doc: Doc): boolean {
  const frames = controllerFrames(doc)
  if (frames.length === 0) return false
  const shells = caseShells(doc)
  if (shells.length === 0) return false
  const inside = (mp: MultiPolygon, p: XForm) =>
    mp.some((poly) =>
      poly.every((ring, i) => {
        let hit = false
        for (let a = 0, b = ring.length - 2; a < ring.length - 1; b = a++) {
          const [xi, yi] = ring[a]
          const [xj, yj] = ring[b]
          if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
            hit = !hit
          }
        }
        // Outer ring has to contain the point, holes have to not.
        return i === 0 ? hit : !hit
      }),
    )
  return frames.every((f) => {
    const port = f.at(f.halfLength - 0.5, 0)
    const beyond = f.at(f.halfLength + PORT_REACH, 0)
    return shells.some(
      (s) => inside(s.hull, port) && !inside(s.hull, beyond),
    )
  })
}

/** Is (x, y) on the controller board? Only the board you placed — on a split
 * the mirrored copy follows it, so dragging that one would fight itself. */
export function controllerHit(c: ControllerSettings, x: number, y: number): boolean {
  if (!c.enabled) return false
  const rad = (c.r * Math.PI) / 180
  const dx = x - c.x
  const dy = y - c.y
  // Into board space: u along the connector axis, v across it.
  const u = -Math.sin(rad) * dx + Math.cos(rad) * dy
  const v = Math.cos(rad) * dx + Math.sin(rad) * dy
  return Math.abs(u) <= c.length / 2 && Math.abs(v) <= c.width / 2
}

/** Where a controller would sit if it were pushed flat against a wall:
 * centered on the wall face, connector end touching it, turned to face out
 * through it. `distance` is how far the board's port end is from that face
 * now, so a caller can decide whether the snap is close enough to want. */
export interface WallAnchor {
  x: number
  y: number
  r: number
  distance: number
}

/** Nearest inside wall face to the board's port end.
 *
 * The whole job of placing a controller is getting its connector through a
 * wall, and eyeballing that to within a millimetre is exactly the kind of
 * thing a drag should do for you. Searched against the case interior, which
 * is the face the board actually sits behind. */
/** One straight run of the floor's boundary. */
export interface WallSegment {
  ax: number
  ay: number
  bx: number
  by: number
}

/** How far the outermost part of the board stands from its center: the
 * bracket on its end, not the board's own edge, plus a fifth of a millimetre
 * so a snapped board is not exactly tangent to everything around it. */
export function controllerReach(doc: Doc): number {
  const c = doc.controller
  if (!c) return 0
  return c.length / 2 + (c.mode === 'mcu' ? c.fit + BRACKET.wall : 0) + 0.2
}

/** The floor's boundary as plain segments.
 *
 * `inner`, not `interior`: the tray ridge stands on the floor between the
 * two, so a board pushed flat against the cavity wall would be sitting on top
 * of it. `inner` is the floor the board can actually reach, and the two are
 * the same contour when there is no ridge.
 *
 * Handed out as raw segments because the caller is a drag loop. Asking for
 * the case on every pointer move costs two full rebuilds — the snapshot being
 * snapped against and the live document being redrawn evict each other from a
 * cache that holds one entry — which measured 240 ms a move on the legacy
 * offset backend and simply froze the drag. Pulled out once, the search that
 * follows is arithmetic. */
export function innerWallSegments(doc: Doc): WallSegment[] {
  const out: WallSegment[] = []
  for (const shell of caseShells(doc)) {
    for (const poly of shell.inner) {
      // Outer ring only: a hole's faces look into the material, not out of it.
      const ring = poly[0]
      for (let i = 0; i < ring.length - 1; i++) {
        out.push({ ax: ring[i][0], ay: ring[i][1], bx: ring[i + 1][0], by: ring[i + 1][1] })
      }
    }
  }
  return out
}

/** Nearest wall face to a point, as the placement that puts a controller's
 * connector end flat against it, facing out. `distance` is how far the point
 * is from that face now, so a caller can decide whether to take the snap. */
export function anchorOnWall(
  segments: WallSegment[],
  x: number,
  y: number,
  reach: number,
): WallAnchor | null {
  let best: WallAnchor | null = null
  for (const { ax, ay, bx, by } of segments) {
    const ex = bx - ax
    const ey = by - ay
    const len2 = ex * ex + ey * ey
    if (len2 < 1e-12) continue
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2))
    const px = ax + ex * t
    const py = ay + ey * t
    const distance = Math.hypot(x - px, y - py)
    if (best && distance >= best.distance) continue
    // Inner outer rings run counter-clockwise with the cavity on the left, so
    // the wall faces right of travel.
    const len = Math.sqrt(len2)
    const nx = ey / len
    const ny = -ex / len
    best = {
      x: px - nx * reach,
      y: py - ny * reach,
      // `out` is the frame's local +y, so its heading is atan2(-x, y).
      r: (Math.atan2(-nx, ny) * 180) / Math.PI,
      distance,
    }
  }
  return best
}

/** Does the module run into anything it shares the cavity with?
 *
 * The test has to know about height, not just plan position. The board lies
 * on the tray floor and the brackets stand 2.8 mm off it, while a switch body
 * hangs down only as far as its own depth below the plate — on a default MX
 * board those miss each other by nearly 2 mm, and calling that a collision
 * would flag every placement on the board. So switches count as obstacles
 * only when they actually reach down past the brackets.
 *
 * The tray ridge always counts: it runs from the lid right up to the plate's
 * underside, so it blocks the full height of the cavity. */
export function controllerOverlaps(doc: Doc): boolean {
  const c = doc.controller
  if (!c?.enabled || c.mode !== 'mcu') return false
  const footprint = robustClip((s) => polygonClipping.union(s), [
    ...controllerBoards(doc),
    ...controllerBrackets(doc),
  ])
  if (footprint.length === 0) return false
  const bracketTop = caseDims(doc).caseBottomY + MCU_THICKNESS + BRACKET.rise
  // Switch bodies hang below y = 0, the plate's top face.
  const deepest = doc.keys.reduce((m, k) => Math.max(m, SWITCH_LOWER[k.type]), 0)
  const obstacles: MultiPolygon = [
    ...(-deepest < bracketTop ? switchCutouts(doc) : []),
    ...caseShells(doc).flatMap((s) => s.ridge),
  ]
  if (obstacles.length === 0) return false
  try {
    const hit = robustClip(
      (s, cl) => polygonClipping.intersection(s, cl!),
      footprint,
      obstacles,
    )
    // By area, not by emptiness. Snapping puts the brackets flat against the
    // wall, and the clipper answers an exactly-tangent pair with a zero-area
    // sliver rather than nothing at all — which would report every snapped
    // placement as a collision.
    let overlap = 0
    for (const poly of hit) {
      for (const [i, ring] of poly.entries()) {
        let s = 0
        for (let k = 0; k < ring.length - 1; k++) {
          s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
        }
        overlap += (i === 0 ? 1 : -1) * Math.abs(s / 2)
      }
    }
    return overlap > 0.5
  } catch {
    return false
  }
}

/** How far up the connector opening reaches from the tray floor: the board's
 * own thickness plus the opening itself. Both the case wall and the tray
 * ridge have to be split at this height, since the connector passes through
 * each of them on its way out. */
export function controllerPortSpan(doc: Doc): number {
  return doc.controller && controllerPortCuts(doc).length > 0
    ? MCU_THICKNESS + doc.controller.portHeight
    : 0
}
