import * as THREE from 'three'
import { MCU_THICKNESS, type Doc } from '../model/keys'
import {
  BRACKET,
  caseBottomOutline,
  caseDims,
  caseShells,
  controllerBrackets,
  controllerPortCuts,
  controllerPortSpan,
  CSK_DEPTH,
  PLATE_THICKNESS,
  plateWithCutouts,
  SCREW,
  screwPositions,
  simplify,
  subtractDiscs,
  subtractShapes,
  type MultiPolygon,
} from '../model/outline'
import { portBandHeight, topCasePieces } from '../preview/caseSolid'
import {
  clampBevel,
  loftRings,
  ringToVec,
  shapeFromRings,
  taperedLevels,
  taperedSolid,
  type LoftLevel,
} from '../preview/loft'

/** One watertight solid of a printable part: geometry in the extrusion frame
 * (outline XY in mm, rising along +Z) plus the height its base sits at.
 * Slicers treat all solids in one STL as a single object and union parts
 * that touch, so a part can be a stack of solids. */
export interface Solid {
  geo: THREE.BufferGeometry
  z: number
  /** Set when the geometry is known watertight — anything that came out of a
   * boolean is, by construction. Skips the T-junction healing below, which
   * exists for ear-cut caps and costs a pass over every vertex per edge. */
  sound?: boolean
}

/** Collinear seam vertices (touching cutouts merged by the union) survive on
 * the rings but get dropped by the caps' ear-cut triangulation, leaving
 * T-junctions between cap and wall. Removing them up front keeps the solids
 * watertight; at 0.01 mm the shape is unaffected. */
const clean = (mp: MultiPolygon) => simplify(mp, 0.01)

function extruded(mp: MultiPolygon, thickness: number, z: number): Solid[] {
  return clean(mp).map((poly) => {
    const shape = shapeFromRings(poly.map((ring) => ringToVec(ring as [number, number][])))
    return {
      geo: new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: false,
        curveSegments: 6,
      }),
      z,
    }
  })
}

function lofted(mp: MultiPolygon, levels: LoftLevel[], z: number): Solid[] {
  const out: Solid[] = []
  for (const poly of clean(mp)) {
    const rings = poly.map((ring) => ringToVec(ring as [number, number][]))
    if (rings[0].length < 3) continue
    out.push({ geo: loftRings(rings, levels), z })
  }
  return out
}

function taperedLofted(mp: MultiPolygon, levels: LoftLevel[], z: number, bevel: number): Solid[] {
  const out: Solid[] = []
  for (const poly of clean(mp)) {
    const rings = poly.map((ring) => ringToVec(ring as [number, number][]))
    if (rings[0].length < 3) continue
    out.push({ geo: taperedSolid(rings, levels, bevel), z })
  }
  return out
}

/** Top case shell, matching the 3D preview: wall band with blind screw
 * pilots, rim band above, one continuous draft profile across both. The lid
 * plane sits at z = 0, so the part rests upright on the bed opening-up. A
 * split case contributes both halves, side by side. */
export function topCaseSolids(doc: Doc): Solid[] {
  if (!doc.bezel.enabled || doc.bezel.width <= 0) return []
  const dims = caseDims(doc)
  // One watertight solid per shell, cut rather than banded — the same
  // assembly the preview shows, so what prints is what was on screen.
  const pieces = topCasePieces(doc)
  if (pieces) {
    return pieces.map((piece) => ({
      geo: piece.geo,
      z: piece.base - dims.caseBottomY,
      sound: true,
    }))
  }
  const screws = screwPositions(doc)
  const pilotH = Math.min(SCREW.bite, dims.wallH)
  const solids: Solid[] = []
  const tapered = (mp: MultiPolygon, thickness: number, y: number, bevel = 0) => {
    const b = clampBevel(bevel, thickness)
    solids.push(
      ...taperedLofted(
        mp,
        taperedLevels(y, thickness, dims.insetAt, dims.breaks, b),
        y - dims.caseBottomY,
        b,
      ),
    )
  }
  // Same band split as the preview: the pilot holes and the connector
  // opening both start at the tray floor and stop at their own heights, so
  // the wall breaks at each in turn and every band carries the cuts that
  // reach it. Getting this wrong here and not in the preview would print a
  // case with no hole in it.
  const portCuts = controllerPortCuts(doc)
  const portH = portCuts.length > 0 ? portBandHeight(doc) : 0
  const stops = [pilotH, portH, dims.wallH]
    .filter((h) => h > 1e-6 && h <= dims.wallH)
    .sort((a, b) => a - b)
    .filter((h, i, all) => i === 0 || h - all[i - 1] > 1e-6)
  for (const shell of caseShells(doc)) {
    let from = 0
    for (const to of stops) {
      let band = shell.wall
      if (screws.length > 0 && to <= pilotH + 1e-6) {
        band = subtractDiscs(band, screws, SCREW.pilotR)
      }
      if (portH > 0 && to <= portH + 1e-6) band = subtractShapes(band, portCuts)
      tapered(band, to - from, dims.caseBottomY + from)
      from = to
    }
    if (dims.rimH > 0) tapered(shell.rim, dims.rimH, 0, dims.bevel)
  }
  return solids
}

/** Bottom tray: the lid with countersunk screw seats plus the tray ridge,
 * underside at z = 0. The seat cone opens from the clearance bore to the
 * countersink's major radius at the underside — a shape an extrusion cannot
 * express, so the lid is lofted. A wedge bottom exports as this flat tray;
 * tilt, tenting and support posts are preview-only. */
export function bottomSolids(doc: Doc): Solid[] {
  if (!doc.bottom.enabled) return []
  const dims = caseDims(doc)
  const t = dims.bottomThickness
  const screws = screwPositions(doc)
  const outline = caseBottomOutline(doc)
  let solids: Solid[]
  if (screws.length > 0) {
    const drilled = subtractDiscs(outline, screws, SCREW.cskR)
    const seatDepth = Math.min(CSK_DEPTH, Math.max(0, t - 0.3))
    // Negative hole offsets shrink the openings: from the countersink's
    // major radius down to the clearance bore, then straight up to the top.
    solids = lofted(
      drilled,
      [
        { z: 0, outer: 0, hole: 0 },
        { z: seatDepth, outer: 0, hole: -CSK_DEPTH },
        { z: t, outer: 0, hole: -CSK_DEPTH },
      ],
      0,
    )
  } else {
    solids = extruded(outline, t, 0)
  }
  // The ridge stands between the board and the wall, so the connector passes
  // through it too — split at the opening's height like the wall is.
  const ridge = caseShells(doc).flatMap((s) => s.ridge)
  const ridgePort = Math.min(dims.cavity, controllerPortSpan(doc))
  if (ridgePort > 0) {
    solids.push(...extruded(subtractShapes(ridge, controllerPortCuts(doc)), ridgePort, t))
    if (dims.cavity > ridgePort) {
      solids.push(...extruded(ridge, dims.cavity - ridgePort, t + ridgePort))
    }
  } else {
    solids.push(...extruded(ridge, dims.cavity, t))
  }
  // Corner brackets stand on the tray floor, which is the lid's top face.
  // The board itself is a part you buy, not one you print, so only the
  // brackets go in the export.
  solids.push(
    ...extruded(controllerBrackets(doc), MCU_THICKNESS + BRACKET.rise, t),
  )
  return solids
}

/** Switch plate, resting on the bed at z = 0. */
export function plateSolids(doc: Doc): Solid[] {
  return extruded(plateWithCutouts(doc), PLATE_THICKNESS, 0)
}

type Vec3 = [number, number, number]

/** One solid's triangles, as they are. */
function rawTriangles(geo: THREE.BufferGeometry): Vec3[][] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const index = geo.getIndex()
  const count = index ? index.count : pos.count
  const out: Vec3[][] = []
  for (let i = 0; i + 2 < count; i += 3) {
    const tri: Vec3[] = []
    for (let k = 0; k < 3; k++) {
      const j = index ? index.getX(i + k) : i + k
      tri.push([pos.getX(j), pos.getY(j), pos.getZ(j)])
    }
    out.push(tri)
  }
  return out
}

/** One solid's triangles with T-junctions healed: any edge passing exactly
 * through another vertex of the same solid is split there, so neighbouring
 * facets meet vertex-to-vertex. The caps' ear-cut triangulation otherwise
 * emits edges that skim collinear corners of neighbouring hole rings (switch
 * cutouts in a row line up exactly), which mesh checks flag as open edges. */
function healedTriangles(geo: THREE.BufferGeometry): Vec3[][] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const index = geo.getIndex()
  const count = index ? index.count : pos.count
  const at = (i: number) => (index ? index.getX(i) : i)
  const keyOf = (p: Vec3) =>
    `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`
  const verts: Vec3[] = []
  const seen = new Set<string>()
  const queue: { tri: Vec3[]; depth: number }[] = []
  for (let i = 0; i + 2 < count; i += 3) {
    const tri: Vec3[] = []
    for (let k = 0; k < 3; k++) {
      const j = at(i + k)
      const p: Vec3 = [pos.getX(j), pos.getY(j), pos.getZ(j)]
      tri.push(p)
      const key = keyOf(p)
      if (!seen.has(key)) {
        seen.add(key)
        verts.push(p)
      }
    }
    queue.push({ tri, depth: 0 })
  }

  const out: Vec3[][] = []
  const EPS = 1e-6
  next: while (queue.length > 0) {
    const { tri, depth } = queue.pop()!
    if (depth < 8) {
      for (let e = 0; e < 3; e++) {
        const a = tri[e]
        const b = tri[(e + 1) % 3]
        const c = tri[(e + 2) % 3]
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const dz = b[2] - a[2]
        const l2 = dx * dx + dy * dy + dz * dz
        if (l2 < EPS * EPS) continue
        const hits: { p: Vec3; t: number }[] = []
        for (const p of verts) {
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / l2
          if (t <= EPS || t >= 1 - EPS) continue
          const qx = a[0] + dx * t - p[0]
          const qy = a[1] + dy * t - p[1]
          const qz = a[2] + dz * t - p[2]
          if (qx * qx + qy * qy + qz * qz > EPS * EPS) continue
          const ck = keyOf(p)
          if (ck === keyOf(c)) continue
          hits.push({ p, t })
        }
        if (hits.length > 0) {
          hits.sort((h1, h2) => h1.t - h2.t)
          let prev = a
          for (const { p } of hits) {
            queue.push({ tri: [prev, p, c], depth: depth + 1 })
            prev = p
          }
          queue.push({ tri: [prev, b, c], depth: depth + 1 })
          continue next
        }
      }
    }
    out.push(tri)
  }
  return out
}

/** Serialize solids as a binary STL, in millimeters, Z up. */
export function toSTL(solids: Solid[]): ArrayBuffer {
  // Twelve floats per facet: normal, then the three vertices.
  const facets: number[] = []
  for (const { geo, z, sound } of solids) {
    for (const tri of sound ? rawTriangles(geo) : healedTriangles(geo)) {
      const v = [
        tri[0][0], tri[0][1], tri[0][2] + z,
        tri[1][0], tri[1][1], tri[1][2] + z,
        tri[2][0], tri[2][1], tri[2][2] + z,
      ]
      const ux = v[3] - v[0]
      const uy = v[4] - v[1]
      const uz = v[5] - v[2]
      const wx = v[6] - v[0]
      const wy = v[7] - v[1]
      const wz = v[8] - v[2]
      const nx = uy * wz - uz * wy
      const ny = uz * wx - ux * wz
      const nz = ux * wy - uy * wx
      const len = Math.hypot(nx, ny, nz)
      // Rings carry duplicated closing points and exactly-tangent vertices;
      // the zero-area facets they triangulate into are dropped here.
      if (len < 1e-7) continue
      facets.push(nx / len, ny / len, nz / len, ...v)
    }
  }
  const n = facets.length / 12
  const buffer = new ArrayBuffer(84 + n * 50)
  const view = new DataView(buffer)
  const header = 'keebforge binary STL (mm)'
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i))
  view.setUint32(80, n, true)
  let o = 84
  for (let i = 0; i < facets.length; i += 12) {
    for (let k = 0; k < 12; k++) {
      view.setFloat32(o, facets[i + k], true)
      o += 4
    }
    view.setUint16(o, 0, true)
    o += 2
  }
  return buffer
}

export function downloadSTL(filename: string, solids: Solid[]) {
  const blob = new Blob([toSTL(solids)], { type: 'model/stl' })
  for (const { geo } of solids) geo.dispose()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
