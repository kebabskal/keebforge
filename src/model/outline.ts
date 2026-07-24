import polygonClipping from 'polygon-clipping'
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping'
import {
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
  ).map(([x, y]) => [world.x + x * cos - y * sin, world.y + x * sin + y * cos])
  ring.push(ring[0])
  return [ring]
}

/** World transforms of all keys, including mirrored copies when enabled. */
function keyWorlds(doc: Doc): { key: Key; world: XForm }[] {
  const groups = groupMap(doc.groups)
  const result = doc.keys.map((key) => ({ key, world: keyWorldXF(key, groups) }))
  if (doc.mirror.enabled) {
    const axis = doc.mirror.axis
    for (const { key, world } of [...result]) {
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
  return polygonClipping.union(rects)
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
  return polygonClipping.difference(outline, cutouts)
}
