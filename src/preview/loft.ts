import * as THREE from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

/** Rings come from polygon-clipping with a duplicated closing point, and
 * exactly-tangent placements can leave coincident neighbours. Both produce
 * zero-length edges, which turn corner bisectors (and ExtrudeGeometry's bevel
 * offset) into NaNs and cull the whole mesh. */
export function ringToVec(ring: [number, number][]): THREE.Vector2[] {
  const pts: THREE.Vector2[] = []
  for (const [x, y] of ring) {
    const last = pts[pts.length - 1]
    if (!last || Math.abs(last.x - x) > 1e-6 || Math.abs(last.y - y) > 1e-6) {
      pts.push(new THREE.Vector2(x, y))
    }
  }
  while (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop()
  return pts
}

export function shapeFromRings(rings: THREE.Vector2[][]): THREE.Shape {
  const shape = new THREE.Shape(rings[0])
  for (let i = 1; i < rings.length; i++) shape.holes.push(new THREE.Path(rings[i]))
  return shape
}

/** One horizontal slice of a lofted part. Offsets push a boundary *into* the
 * material, so on the outer ring they shrink the part and on a hole ring they
 * widen the opening. */
export interface LoftLevel {
  /** Height above the part's base, mm. */
  z: number
  outer: number
  hole: number
}

/** Move every vertex of a closed ring into the material it bounds by `d`,
 * along its corner bisector. Vertex count is preserved, so rings at adjacent
 * levels correspond one-to-one and can be lofted together. Relies on
 * polygon-clipping's canonical winding, which keeps material to the left of
 * the traversal for outer rings and holes alike. */
export function offsetRingInward(ring: THREE.Vector2[], d: number): THREE.Vector2[] {
  const n = ring.length
  if (Math.abs(d) < 1e-9 || n < 3) return ring
  const out: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]
    const cur = ring[i]
    const next = ring[(i + 1) % n]
    const e1 = new THREE.Vector2(cur.x - prev.x, cur.y - prev.y)
    const e2 = new THREE.Vector2(next.x - cur.x, next.y - cur.y)
    if (e1.lengthSq() < 1e-12 || e2.lengthSq() < 1e-12) {
      out.push(cur.clone())
      continue
    }
    e1.normalize()
    e2.normalize()
    const n1 = new THREE.Vector2(-e1.y, e1.x)
    const n2 = new THREE.Vector2(-e2.y, e2.x)
    const bisector = n1.clone().add(n2)
    if (bisector.lengthSq() < 1e-12) {
      out.push(cur.clone())
      continue
    }
    bisector.normalize()
    // Travelling along the bisector overshoots the face offset by
    // 1/cos(half angle). Capped so a near-cusp corner can't shoot off.
    const miter = Math.min(1 / Math.max(bisector.dot(n1), 1e-3), 4)
    out.push(new THREE.Vector2(cur.x + bisector.x * d * miter, cur.y + bisector.y * d * miter))
  }
  return out
}

/** A prism whose cross-section shifts with height, built in the XY plane and
 * rising along +Z the way an extrusion does. Draft taper, the break where the
 * taper starts, and the top chamfer are all just levels. ExtrudeGeometry
 * cannot express any of them: its bevel is symmetric across both caps, so it
 * can only pinch a part equally at each end. */
export function loftRings(
  rings: THREE.Vector2[][],
  levels: LoftLevel[],
  creaseAngle = Math.PI / 6,
): THREE.BufferGeometry {
  const slices = levels.map((level) =>
    rings.map((ring, r) => offsetRingInward(ring, r === 0 ? level.outer : level.hole)),
  )

  // Each band and each cap is normalled on its own, then concatenated. Every
  // boundary between them is a real edge — the break where the draft starts,
  // the chamfer, the cap rims — and smoothing has to stop there. Creasing the
  // whole part in one pass instead lets a vertex average its wall face with
  // the cap face sitting on it, which tips the top and bottom rows of every
  // band ~45° off and reads as banding down the side of the case.
  const pieces: THREE.BufferGeometry[] = []
  const finish = (position: number[], crease: boolean) => {
    if (position.length === 0) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    g.computeVertexNormals()
    if (!crease) {
      pieces.push(g)
      return
    }
    // Within a band, neighbouring facets still smooth, so outline arcs read
    // as curves rather than facets.
    const creased = toCreasedNormals(g, creaseAngle)
    g.dispose()
    pieces.push(creased)
  }

  for (let k = 0; k + 1 < slices.length; k++) {
    const z0 = levels[k].z
    const z1 = levels[k + 1].z
    const band: number[] = []
    const push = (p: THREE.Vector2, z: number) => band.push(p.x, p.y, z)
    for (let r = 0; r < rings.length; r++) {
      const lo = slices[k][r]
      const hi = slices[k + 1][r]
      for (let i = 0; i < lo.length; i++) {
        const j = (i + 1) % lo.length
        // Wound so the face normal points out of the material: for a ring
        // traversed with material on its left, that is to the right.
        push(lo[i], z0)
        push(lo[j], z0)
        push(hi[j], z1)
        push(lo[i], z0)
        push(hi[j], z1)
        push(hi[i], z1)
      }
    }
    finish(band, true)
  }

  // Caps come from the same offset rings, so they meet the walls exactly.
  for (const index of [0, slices.length - 1]) {
    const cap = new THREE.ShapeGeometry(shapeFromRings(slices[index]))
    const flat = cap.toNonIndexed()
    cap.dispose()
    const p = flat.getAttribute('position')
    const z = levels[index].z
    const capPos: number[] = []
    // ShapeGeometry faces +Z; the bottom cap has to look the other way.
    const order = index === 0 ? [2, 1, 0] : [0, 1, 2]
    for (let i = 0; i + 2 < p.count; i += 3) {
      for (const o of order) capPos.push(p.getX(i + o), p.getY(i + o), z)
    }
    flat.dispose()
    // A cap is planar, so face normals are already the right answer.
    finish(capPos, false)
  }

  const position: number[] = []
  const normal: number[] = []
  for (const piece of pieces) {
    const p = piece.getAttribute('position')
    const n = piece.getAttribute('normal')
    for (let i = 0; i < p.count; i++) {
      position.push(p.getX(i), p.getY(i), p.getZ(i))
      normal.push(n.getX(i), n.getY(i), n.getZ(i))
    }
    piece.dispose()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
  return geo
}
