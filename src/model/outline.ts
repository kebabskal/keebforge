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
 * radius (~0.7 mm chords), with a floor of 18 segments (20° per facet) so
 * even tiny-radius arcs stay under the 3D preview's 30° normal-crease
 * threshold and shade smoothly. */
function discPoly(cx: number, cy: number, r: number): Polygon {
  const segments = Math.min(36, Math.max(18, Math.ceil((2 * Math.PI * r) / 0.7)))
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
        robustClip((s) => polygonClipping.union(s), rects),
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
    solidsCache.bezel === doc.bezel
  ) {
    return solidsCache.result
  }
  const result = bezelSolidsUncached(doc)
  solidsCache = {
    keys: doc.keys,
    groups: doc.groups,
    mirror: doc.mirror,
    bezel: doc.bezel,
    result,
  }
  return result
}

/** One case piece of the hollow top shell plus the bottom tray, as
 * extrudable outlines. The plate and foam are sized to the cavity, so
 * nothing interpenetrates: `hull` ⊃ `interior` (wall width in) ⊃ `inner`
 * (ridge width further in). */
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
  const result: CaseShell[] = solids.map((s) => {
    const hull: MultiPolygon = s.outer.map((poly) => [poly[0]])
    let interior: MultiPolygon = []
    try {
      interior = simplify(erode(hull, wallW), 0.05)
    } catch (error) {
      console.warn('keebforge: case interior generation failed', error)
    }
    const fit = round(interior)
    let inner = fit
    if (ridgeW > 0 && fit.length > 0) {
      try {
        inner = round(simplify(erode(fit, ridgeW), 0.05))
      } catch (error) {
        console.warn('keebforge: tray ridge generation failed', error)
      }
    }
    return {
      hull,
      interior,
      fit,
      inner,
      wall: diff(hull, interior),
      rim: diff(hull, s.opening),
      ridge: inner === fit ? [] : diff(fit, inner),
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
    const opening = prep(
      robustClip((s) => polygonClipping.union(s), capRects(bezel.outset)),
      bezel.radiusInner ?? 0,
    )
    let outer: MultiPolygon
    if (bezel.mode === 'tight') {
      outer = prep(
        expandMargins(
          robustClip((s) => polygonClipping.union(s), capRects(bezel.outset + bezel.width)),
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

/** Evenly spaced points along a ring's perimeter, `spacing` mm apart,
 * phase-anchored at the vertex farthest from the ring centroid (a corner,
 * so screws land in corners first and the layout is stable under edits).
 * Used for `tight` outlines, which have no canonical corners; `box` pieces
 * take their screws from the rectangle they were built from instead. */
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
  let cx = 0
  let cy = 0
  for (const [x, y] of pts) {
    cx += x / n
    cy += y / n
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

  let start = 0
  let best = -1
  for (let i = 0; i < n; i++) {
    const d = (pts[i][0] - cx) ** 2 + (pts[i][1] - cy) ** 2
    if (d > best) {
      best = d
      start = i
    }
  }
  const count = Math.max(2, Math.round(total / spacing))
  const out: [number, number][] = []
  for (let k = 0; k < count; k++) out.push(at(cum[start] + (k * total) / count))
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
  const onAxis = 0.05
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

/** Foam shape: like the plate but inside the supporting lip, with extra
 * clearance around the switch housings. */
export function foamWithCutouts(doc: Doc): MultiPolygon {
  const inner = caseShells(doc).flatMap((s) => s.inner)
  const outline = inner.length > 0 ? inner : plateOutline(doc)
  if (outline.length === 0) return []
  const cutouts = switchCutouts(doc, FOAM_CLEARANCE)
  return robustClip((s, c) => polygonClipping.difference(s, c!), outline, cutouts)
}
