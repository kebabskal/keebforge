import polygonClipping from 'polygon-clipping'
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping'
import {
  capSize,
  isKeyMirrored,
  keySize,
  keyWorldXF,
  type Doc,
  type Key,
  type XForm,
} from './keys'
import { groupMap } from './store'

export type { MultiPolygon, Polygon, Ring }

/** Plate switch cutout size per switch type, mm. */
const CUTOUT: Record<Key['type'], number> = {
  mx: 14,
  choc: 13.8,
}

export const PLATE_THICKNESS = 1.5
export const FOAM_THICKNESS = 3.5
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

/** Disc approximation for Minkowski offsetting. Resolution scales with the
 * radius (~0.7 mm chords) so offset arcs stay visually round. */
function discPoly(cx: number, cy: number, r: number): Polygon {
  const segments = Math.min(36, Math.max(8, Math.ceil((2 * Math.PI * r) / 0.7)))
  const ring: Ring = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI
    ring.push([snap(cx + r * Math.cos(a)), snap(cy + r * Math.sin(a))])
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
        const len = Math.hypot(x2 - x1, y2 - y1)
        if (len < 1e-9) continue
        // Right normal = away from the material.
        const nx = (y2 - y1) / len
        const ny = -(x2 - x1) / len
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
        const l0 = Math.hypot(x1 - p0[0], y1 - p0[1])
        const cross = (x1 - p0[0]) * (y2 - y1) - (y1 - p0[1]) * (x2 - x1)
        const sinT = l0 < 1e-9 ? 1 : cross / (l0 * len)
        if ((side === 'out' ? sinT : -sinT) > 0.017) {
          parts.push(discPoly(x1, y1, r))
        }
      }
    }
  }
  return parts
}

/** Approximate Minkowski dilation by a disc of radius r. Micro-holes are
 * dropped immediately: a spurious sealed pocket would otherwise inflate into
 * a disc-sized hole under a following erosion. */
function dilate(mp: MultiPolygon, r: number): MultiPolygon {
  if (mp.length === 0 || r <= 0) return mp
  return dropDebris(
    robustClip((s) => polygonClipping.union(s), [...mp, ...offsetBand(mp, r, 'out')]),
    2,
  )
}

/** Approximate Minkowski erosion by a disc of radius r: subtract the band
 * within r of the boundary. Straight edges are reconstructed exactly (the
 * strip's inner edge), so dilate-then-erode round-trips cleanly. */
function erode(mp: MultiPolygon, r: number): MultiPolygon {
  if (mp.length === 0 || r <= 0) return mp
  const band = robustClip((s) => polygonClipping.union(s), offsetBand(mp, r, 'in'))
  return dropDebris(
    robustClip((s, c) => polygonClipping.difference(s, c!), mp, band),
    2,
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
 * nothing. */
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
    const kept: Ring = []
    for (let i = 0; i < pts.length; i++) {
      const a = kept.length > 0 ? kept[kept.length - 1] : pts[pts.length - 1]
      const b = pts[i]
      const c = pts[(i + 1) % pts.length]
      const ux = c[0] - a[0]
      const uy = c[1] - a[1]
      const len = Math.hypot(ux, uy)
      const dist =
        len < 1e-9
          ? Math.hypot(b[0] - a[0], b[1] - a[1])
          : Math.abs((b[0] - a[0]) * uy - (b[1] - a[1]) * ux) / len
      if (dist < eps) {
        changed = true
        continue
      }
      kept.push(b)
    }
    pts = kept
  }
  if (pts.length < 3) return ring
  pts.push(pts[0])
  return pts
}

function simplify(mp: MultiPolygon, eps: number): MultiPolygon {
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
function keyWorlds(doc: Doc): { key: Key; world: XForm }[] {
  const groups = groupMap(doc.groups)
  const result = doc.keys.map((key) => ({ key, world: keyWorldXF(key, groups) }))
  if (doc.mirror.enabled) {
    const axis = doc.mirror.axis
    for (const { key, world } of [...result]) {
      if (!isKeyMirrored(key, groups)) continue
      result.push({
        key,
        world: { x: 2 * axis - world.x, y: world.y, r: -world.r },
      })
    }
  }
  return result
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
  const rects: Polygon[] = keyWorlds(doc).map(({ key, world }) => {
    const size = keySize(key)
    return rectPoly(world, size.w + 2 * pad, size.h + 2 * pad)
  })
  const result =
    rects.length === 0
      ? []
      : closeGaps(
          robustClip((s) => polygonClipping.union(s), rects),
          MIN_FEATURE / 2,
        )
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
let bezelCache: {
  keys: Doc['keys']
  groups: Doc['groups']
  mirror: Doc['mirror']
  bezel: Doc['bezel']
  result: MultiPolygon
} | null = null

export function bezelShape(doc: Doc): MultiPolygon {
  if (
    bezelCache &&
    bezelCache.keys === doc.keys &&
    bezelCache.groups === doc.groups &&
    bezelCache.mirror === doc.mirror &&
    bezelCache.bezel === doc.bezel
  ) {
    return bezelCache.result
  }
  const result = bezelShapeUncached(doc)
  bezelCache = {
    keys: doc.keys,
    groups: doc.groups,
    mirror: doc.mirror,
    bezel: doc.bezel,
    result,
  }
  return result
}

function bezelShapeUncached(doc: Doc): MultiPolygon {
  const bezel = doc.bezel
  if (!bezel.enabled || bezel.width <= 0) return []
  const worlds = keyWorlds(doc)
  if (worlds.length === 0) return []
  const capRects = (pad: number): Polygon[] =>
    worlds.map(({ key, world }) => {
      const size = capSize(key)
      return rectPoly(world, size.w + 2 * pad, size.h + 2 * pad)
    })
  // Rounding (and, via its closing phase, wedge-gap filling) happens on the
  // opening and outer solids separately, each with its own radius, so the
  // ring's two edges get exact, independent corner radii.
  const sc = MIN_FEATURE / 2
  const prep = (mp: MultiPolygon, radius: number): MultiPolygon => {
    const r = Math.max(0, Math.min(radius, 6))
    return r > 0 ? smoothOutline(mp, r, sc) : closeGaps(mp, sc)
  }
  const opening = prep(
    robustClip((s) => polygonClipping.union(s), capRects(bezel.outset)),
    bezel.radiusInner ?? 0,
  )
  let outer: MultiPolygon
  if (bezel.mode === 'tight') {
    outer = prep(
      robustClip((s) => polygonClipping.union(s), capRects(bezel.outset + bezel.width)),
      bezel.radiusOuter ?? 0,
    )
  } else {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const rect of capRects(0)) {
      for (const [x, y] of rect[0]) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    const pad = bezel.outset + bezel.width
    outer = prep(
      [
        [
          [
            [minX - pad, minY - pad],
            [maxX + pad, minY - pad],
            [maxX + pad, maxY + pad],
            [minX - pad, maxY + pad],
            [minX - pad, minY - pad],
          ],
        ],
      ],
      bezel.radiusOuter ?? 0,
    )
  }
  return robustClip((s, c) => polygonClipping.difference(s, c!), outer, opening)
}

/** Plate (or switch foam) shape: outline minus switch cutouts. Holes appear
 * as extra rings within each polygon. */
export function plateWithCutouts(doc: Doc, clearance = 0): MultiPolygon {
  const outline = plateOutline(doc)
  if (outline.length === 0) return []
  const cutouts = switchCutouts(doc, clearance)
  return robustClip((s, c) => polygonClipping.difference(s, c!), outline, cutouts)
}
