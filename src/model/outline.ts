import polygonClipping from 'polygon-clipping'
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping'
import {
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
 * `padding` mm on all sides. Disjoint clusters produce multiple polygons. */
export function plateOutline(doc: Doc): MultiPolygon {
  const pad = doc.plate.padding
  const rects: Polygon[] = keyWorlds(doc).map(({ key, world }) => {
    const size = keySize(key)
    return rectPoly(world, size.w + 2 * pad, size.h + 2 * pad)
  })
  if (rects.length === 0) return []
  return robustClip((s) => polygonClipping.union(s), rects)
}

/** Switch cutout rectangles (one per key, sized per switch type plus optional
 * per-side clearance). */
export function switchCutouts(doc: Doc, clearance = 0): MultiPolygon {
  return keyWorlds(doc).map(({ key, world }) => {
    const size = CUTOUT[key.type] + 2 * clearance
    return rectPoly(world, size, size)
  })
}

/** Plate (or switch foam) shape: outline minus switch cutouts. Holes appear
 * as extra rings within each polygon. */
export function plateWithCutouts(doc: Doc, clearance = 0): MultiPolygon {
  const outline = plateOutline(doc)
  if (outline.length === 0) return []
  const cutouts = switchCutouts(doc, clearance)
  return robustClip((s, c) => polygonClipping.difference(s, c!), outline, cutouts)
}
