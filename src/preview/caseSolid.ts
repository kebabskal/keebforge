/** The top case as one solid, assembled with booleans.
 *
 * The shell used to be emitted as a stack of bands — one per height where a
 * cut started or stopped — because a cut was a plan-view shape and a band was
 * the only way to give it a top and a bottom. That worked and cost twice: the
 * bands are separate meshes, so one continuous drafted face arrived at the
 * renderer as three surfaces that disagreed at their seams, and anything
 * shaped in a vertical plane could not be cut at all.
 *
 * Here the wall and the rim are built as solids, unioned, and then cut: screw
 * pilots by cylinders, the connector opening by its own profile swept through
 * the wall. One watertight solid comes out, normalled in one pass, so the
 * taper reads as one surface and the opening is the shape it is supposed to
 * be rather than a rectangle with pieces added back.
 *
 * A shell whose taper folds still falls back to bands: `taperedSolid` answers
 * a folding offset with a morphological staircase, whose cancelling coincident
 * caps are not a solid and cannot be handed to a boolean. Those cases keep the
 * behaviour they had before this module existed. */
import * as THREE from 'three'
import type { Manifold } from 'manifold-3d'
import { MCU_THICKNESS, type Doc } from '../model/keys'
import {
  caseDims,
  caseShells,
  controllerPortOpenings,
  qualitySegments,
  SCREW,
  screwPositions,
  type CaseShell,
  type MultiPolygon,
  type PortOpening,
} from '../model/outline'
import { csg, geometryOf, manifoldReady, solidOf, unionAll, withNormals } from './csg'
import { clampBevel, ringToVec, taperedLevels, taperedSolid } from './loft'

/** One case piece, ready to place: geometry in the extrusion frame (outline
 * XY, rising along +Z) and the world height its base sits at. */
export interface CasePiece {
  geo: THREE.BufferGeometry
  /** World Y of z = 0. */
  base: number
  /** The shell's footprint, for the caller's placement bookkeeping. */
  ring: [number, number][]
}

/** A band of a shell as a solid, or null if its taper had to staircase. */
function bandSolid(
  mp: MultiPolygon,
  base: number,
  thickness: number,
  doc: Doc,
  bevel: number,
  stepScale: number,
  zOffset: number,
): Manifold[] | null {
  if (thickness <= 1e-6) return []
  const dims = caseDims(doc)
  const b = clampBevel(bevel, thickness)
  const levels = taperedLevels(base, thickness, dims.insetAt, dims.breaks, b)
  const out: Manifold[] = []
  for (const poly of mp) {
    const rings = poly.map((ring) => ringToVec(ring as [number, number][]))
    if (rings[0].length < 3) continue
    const geo = taperedSolid(rings, levels, b, stepScale)
    const solid = solidOf(geo)
    geo.dispose()
    if (!solid) {
      for (const s of out) s.delete()
      return null
    }
    out.push(zOffset === 0 ? solid : solid.translate([0, 0, zOffset]))
  }
  return out
}

/** Blind pilot holes: only as deep as the screw bites, so the wall still
 * reads solid from inside the case. */
function pilotCutters(doc: Doc, depth: number): Manifold[] {
  const { Manifold: M } = csg()
  const seg = qualitySegments()
  return screwPositions(doc).map(([x, y]) =>
    // Overshoot the floor so the cut's own bottom face never lands exactly on
    // the solid's, which is a coplanar boolean for no reason.
    withNormals(
      M.cylinder(depth + 1, SCREW.pilotR, SCREW.pilotR, seg).translate([x, y, -1]),
    ),
  )
}

/** The connector opening: the profile swept out through the wall, plus the
 * square passage the board itself needs behind it. */
function portCutter(open: PortOpening, base: number): Manifold {
  const { Manifold: M } = csg()
  const profile = M.extrude([open.profile], open.reach)
  const slot = M.extrude(
    [[
      [-open.slotHalf, 0],
      [open.slotHalf, 0],
      [open.slotHalf, open.slotHeight],
      [-open.slotHalf, open.slotHeight],
    ] as [number, number][]],
    open.reach,
  ).translate([0, 0, -open.reach])
  // The cut is authored looking at the opening: x across it, y up, z outward
  // along the board. Mirrored in x — the profile is symmetric, and a basis
  // built from (side, up, out) as-is is left-handed, which would turn the
  // solid inside out.
  //
  // Normalled before it is placed, so the arched corners of the opening shade
  // as arcs and the flats around them stay flat. The angle is trustworthy on a
  // shape this simple: the profile's own facets are far below it and every
  // other edge on the prism is a right angle.
  return withNormals(
    M.union(profile, slot).transform([
      -open.sideX, -open.sideY, 0, 0,
      0, 0, 1, 0,
      open.outX, open.outY, 0, 0,
      open.x, open.y, open.z - base, 1,
    ]),
  )
}

/** Every shell of the top case, each as one solid, in the extrusion frame
 * (z = 0 at the lid plane). Returns null if any shell could not be built that
 * way, so the caller can fall back wholesale rather than mixing two kinds of
 * case in one preview. Callers own the solids and must delete them. */
export function topCaseManifolds(doc: Doc, stepScale = 1): Manifold[] | null {
  if (!manifoldReady()) return null
  if (!doc.bezel.enabled || doc.bezel.width <= 0) return null
  const dims = caseDims(doc)
  const shells = caseShells(doc)
  if (shells.length === 0) return null
  const pilotH = Math.min(SCREW.bite, dims.wallH)
  const openings = controllerPortOpenings(doc)
  const solids: Manifold[] = []
  for (const shell of shells as CaseShell[]) {
    const wall = bandSolid(shell.wall, dims.caseBottomY, dims.wallH, doc, 0, stepScale, 0)
    const rim =
      wall &&
      bandSolid(shell.rim, 0, dims.rimH, doc, dims.bevel, stepScale, dims.wallH)
    if (!wall || !rim) {
      for (const s of [...(wall ?? []), ...(rim ?? []), ...solids]) s.delete()
      return null
    }
    let solid = unionAll([...wall, ...rim])
    if (!solid) continue
    const cutters = [
      ...pilotCutters(doc, pilotH),
      ...openings.map((o) => portCutter(o, dims.caseBottomY)),
    ]
    if (cutters.length > 0) {
      const cut = csg().Manifold.union(cutters)
      for (const c of cutters) c.delete()
      const next = solid.subtract(cut)
      solid.delete()
      cut.delete()
      solid = next
    }
    solids.push(solid)
  }
  return solids
}

/** The same solids as renderable geometry, one piece per shell. */
export function topCasePieces(doc: Doc, stepScale = 1): CasePiece[] | null {
  const solids = topCaseManifolds(doc, stepScale)
  if (!solids) return null
  const base = caseDims(doc).caseBottomY
  const shells = caseShells(doc)
  const pieces = solids.map((solid, i) => {
    const piece: CasePiece = {
      geo: geometryOf(solid),
      base,
      ring: (shells[i]?.hull[0]?.[0] ?? []) as [number, number][],
    }
    solid.delete()
    return piece
  })
  return pieces
}

/** How far up the wall the connector opening reaches — the height the banded
 * fallback has to split at, since it can only cut in plan view. */
export function portBandHeight(doc: Doc): number {
  const dims = caseDims(doc)
  return controllerPortOpenings(doc).length > 0
    ? Math.min(dims.wallH, MCU_THICKNESS + doc.controller.portHeight)
    : 0
}
