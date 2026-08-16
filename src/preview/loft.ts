import * as THREE from 'three'
import {
  erode,
  outlineDifference,
  qualityMaxStep,
  simplify,
  type MultiPolygon,
  type Ring,
} from '../model/outline'


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
 * the traversal for outer rings and holes alike.
 *
 * Only sound while `d` stays under the local feature size — a corner arc
 * tighter than the offset folds the ring over itself. taperedSolid validates
 * each offset and falls back to a morphological staircase when that happens;
 * the countersink loft uses this unguarded, its rings being circles
 * comfortably wider than their offsets. */
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
    const miter = Math.min(1 / Math.max(bisector.dot(n1), 1e-3), 2)
    out.push(new THREE.Vector2(cur.x + bisector.x * d * miter, cur.y + bisector.y * d * miter))
  }
  return out
}

/** Clamp a top-edge chamfer so it cannot consume the part. Callers pass the
 * same clamped value to taperedLevels and taperedSolid so the last band
 * level and the chamfer meet at the same height. */
export function clampBevel(bevel: number, thickness: number): number {
  return Math.max(0, Math.min(bevel, thickness / 2 - 0.05))
}

/** Loft levels for a part whose outer face tapers with height. `insetAt`
 * gives the outer pull-in at any world height, so parts stacked along the
 * case continue one unbroken profile. `breaks` are world heights where that
 * profile changes slope — a level is planted at each one falling inside this
 * band, so the break lands exactly where asked even mid-part. A top chamfer
 * (`bevel`, pre-clamped via clampBevel) only shortens the band here — the
 * chamfer surface itself is built by taperedSolid, which takes the same
 * value. */
export function taperedLevels(
  base: number,
  thickness: number,
  insetAt: (worldY: number) => number,
  breaks: number[],
  bevel = 0,
): LoftLevel[] {
  const top = base + thickness - bevel
  const levels: LoftLevel[] = [{ z: 0, outer: insetAt(base), hole: 0 }]
  for (const at of breaks) {
    if (at > base + 1e-6 && at < top - 1e-6) {
      levels.push({ z: at - base, outer: insetAt(at), hole: 0 })
    }
  }
  levels.push({ z: top - base, outer: insetAt(top), hole: 0 })
  return levels
}

/** Collects triangles that already know their own normals.
 *
 * Nothing here infers shading from the mesh. Every surface a lofted part has
 * is one we generated and therefore one whose curvature we know: a wall band
 * is a ruled surface over a ring, a cap is a plane, and the seam between them
 * is a real edge. Emitting the normal alongside the position says so directly.
 *
 * Inferring it instead — measure the angle between neighbouring facets, crease
 * where it exceeds a threshold — cannot work here, because the angles do not
 * separate. On a default board the draft break is 21°, and one arc facet at
 * the coarsest detail level is up to 40° once simplification has thinned it:
 * any threshold that keeps the fillet smooth erases the break line, and any
 * threshold that keeps the break creases the fillet. It only appears to work
 * at high detail, where fine sampling opens a window between the two. */
function pieceCollector() {
  const position: number[] = []
  const normal: number[] = []
  const finish = (pos: number[], nor: number[]) => {
    for (const v of pos) position.push(v)
    for (const v of nor) normal.push(v)
  }
  const concat = (): THREE.BufferGeometry => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
    return geo
  }
  return { finish, concat }
}

/** Outward face normals along a closed ring, and the blended normal at each
 * vertex where the boundary is genuinely curving rather than turning a corner.
 *
 * A ring arrives as bare points: the arc the offsetter sampled and the corner
 * the shape actually has look identical. What tells them apart is not the turn
 * angle on its own but the turn angle *against how finely arcs are sampled at
 * the current level* — an arc facet turns by about the level's step, a corner
 * by tens of degrees more. So the threshold is derived from the step rather
 * than fixed, and the same code keeps fillets smooth at every detail level.
 *
 * The allowance over the step is generous because simplification runs after
 * sampling and thins arcs by up to half their points, doubling the turn at the
 * ones that survive. Real corners in these outlines are 90° or sharper — the
 * hull is rounded by construction — so a wide margin costs nothing. */
function ringNormals(ring: THREE.Vector2[], smoothTurn: number) {
  const n = ring.length
  // Material lies to the left of the traversal, so the outward normal of an
  // edge is to its right.
  const edge: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    edge.push(len > 1e-9 ? new THREE.Vector2(dy / len, -dx / len) : new THREE.Vector2(0, 0))
  }
  // Two normals per vertex: the one the face arriving at it uses, and the one
  // the face leaving it uses. Equal wherever the boundary is smooth.
  const arriving: THREE.Vector2[] = []
  const leaving: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const before = edge[(i - 1 + n) % n]
    const after = edge[i]
    const turn = Math.acos(Math.max(-1, Math.min(1, before.dot(after))))
    if (turn <= smoothTurn) {
      const blend = before.clone().add(after)
      const v = blend.lengthSq() > 1e-12 ? blend.normalize() : after.clone()
      arriving.push(v)
      leaving.push(v.clone())
    } else {
      arriving.push(before.clone())
      leaving.push(after.clone())
    }
  }
  return { arriving, leaving }
}

/** A prism whose cross-section shifts with height, built in the XY plane and
 * rising along +Z the way an extrusion does. Rings at every level come from
 * offsetRingInward, so its feature-size caveat applies. */
export function loftRings(
  rings: THREE.Vector2[][],
  levels: LoftLevel[],
): THREE.BufferGeometry {
  const slices = levels.map((level) =>
    rings.map((ring, r) => offsetRingInward(ring, r === 0 ? level.outer : level.hole)),
  )
  const { finish, concat } = pieceCollector()

  for (let k = 0; k + 1 < slices.length; k++) {
    loftBand(finish, slices[k], levels[k].z, slices[k + 1], levels[k + 1].z)
  }

  // Caps come from the same offset rings, so they meet the walls exactly.
  // They are triangulated on the un-offset rings and only then mapped to
  // their offset positions, which keeps every cap edge matched to a wall
  // edge whatever the offsets do.
  const faces = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1))
  for (const index of [0, slices.length - 1]) {
    const pts = slices[index].flat()
    const z = levels[index].z
    const capPos: number[] = []
    const capNor: number[] = []
    // Triangulation faces +Z; the bottom cap has to look the other way.
    const order = index === 0 ? [2, 1, 0] : [0, 1, 2]
    const nz = index === 0 ? -1 : 1
    for (const face of faces) {
      for (const o of order) {
        const p = pts[face[o]]
        capPos.push(p.x, p.y, z)
        capNor.push(0, 0, nz)
      }
    }
    finish(capPos, capNor)
  }

  return concat()
}

type Finish = (position: number[], normal: number[]) => void

/** How far the boundary may turn at a vertex and still count as curving
 * rather than cornering, radians. Derived from the level's own arc step, with
 * room for the thinning that simplification does afterwards. */
function smoothTurn(): number {
  return Math.min(Math.PI / 2.2, qualityMaxStep() * 2.6)
}

/** Wall band between two slices with identical ring topology. Wound so the
 * face normal points out of the material: for a ring traversed with material
 * on its left, that is to the right — outer rings and holes alike. Vertical
 * walls are the lo === hi case.
 *
 * The normal follows the surface rather than the triangles. Around the ring it
 * blends across every vertex the boundary merely curves through, so an arc
 * shades as an arc however coarsely it was sampled. Up the band it tilts by
 * the slope the band actually has: a vertex that moves inward by `d` while
 * rising `h` has its normal leaned back by exactly that ratio. Which is also
 * what puts a crease on the draft break for free — the band below it is
 * vertical and the band above it is not, so their normals differ at the seam
 * they share, by the 21° the break really turns through, and no threshold had
 * to be consulted to find that out. */
function loftBand(
  finish: Finish,
  lo: THREE.Vector2[][],
  z0: number,
  hi: THREE.Vector2[][],
  z1: number,
) {
  const pos: number[] = []
  const nor: number[] = []
  const turn = smoothTurn()
  const h = z1 - z0
  for (let r = 0; r < lo.length; r++) {
    const a = lo[r]
    const b = hi[r]
    const { arriving, leaving } = ringNormals(a, turn)
    // Lean per vertex, from how far this vertex actually moved inward.
    const lean = (i: number, flat: THREE.Vector2): [number, number, number] => {
      const d = (a[i].x - b[i].x) * flat.x + (a[i].y - b[i].y) * flat.y
      const len = Math.hypot(h, d) || 1
      return [(flat.x * h) / len, (flat.y * h) / len, d / len]
    }
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length
      // The quad's two corners take the normals of the edge they lie on.
      const ni = lean(i, leaving[i])
      const nj = lean(j, arriving[j])
      pos.push(a[i].x, a[i].y, z0, a[j].x, a[j].y, z0, b[j].x, b[j].y, z1)
      nor.push(...ni, ...nj, ...nj)
      pos.push(a[i].x, a[i].y, z0, b[j].x, b[j].y, z1, b[i].x, b[i].y, z1)
      nor.push(...ni, ...nj, ...ni)
    }
  }
  finish(pos, nor)
}

/** Flat region triangulated at height z. Faces up unless `down`. */
function flatRegion(finish: Finish, region: MultiPolygon, z: number, down = false) {
  const pos: number[] = []
  const nor: number[] = []
  const nz = down ? -1 : 1
  for (const poly of region) {
    const contour = ringToVec(poly[0] as [number, number][])
    if (contour.length < 3) continue
    const holes = poly.slice(1).map((ring) => ringToVec(ring as [number, number][]))
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
    const pts = [contour, ...holes].flat()
    for (const face of faces) {
      for (const o of down ? [2, 1, 0] : [0, 1, 2]) {
        const p = pts[face[o]]
        pos.push(p.x, p.y, z)
        nor.push(0, 0, nz)
      }
    }
  }
  finish(pos, nor)
}

/** True if any two non-adjacent edges of the ring set cross or overlap — the
 * signature of an offset that folded. Also rejects rings whose orientation
 * flipped outright (an offset past the ring's own size). Sweep over edges
 * sorted by min-x keeps the pair test near-linear on real outlines. */
function ringsFold(offset: THREE.Vector2[][], original: THREE.Vector2[][]): boolean {
  for (let r = 0; r < offset.length; r++) {
    const area = (ring: THREE.Vector2[]) => {
      let a = 0
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length
        a += ring[i].x * ring[j].y - ring[j].x * ring[i].y
      }
      return a / 2
    }
    const a0 = area(original[r])
    const a1 = area(offset[r])
    if (Math.abs(a0) > 1e-9 && a1 * a0 <= 0) return true
  }
  interface Edge {
    ax: number
    ay: number
    bx: number
    by: number
    ring: number
    idx: number
    n: number
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
  const edges: Edge[] = []
  offset.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      edges.push({
        ax: a.x, ay: a.y, bx: b.x, by: b.y,
        ring: r, idx: i, n: ring.length,
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
      })
    }
  })
  edges.sort((p, q) => p.minX - q.minX)
  const EPS = 1e-9
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) =>
    (px - ox) * (qy - oy) - (py - oy) * (qx - ox)
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    for (let k = i + 1; k < edges.length; k++) {
      const f = edges[k]
      if (f.minX > e.maxX) break
      if (f.minY > e.maxY || f.maxY < e.minY) continue
      if (e.ring === f.ring) {
        const d = Math.abs(e.idx - f.idx)
        if (d <= 1 || d === e.n - 1) continue
      }
      const d1 = cross(e.ax, e.ay, e.bx, e.by, f.ax, f.ay)
      const d2 = cross(e.ax, e.ay, e.bx, e.by, f.bx, f.by)
      const d3 = cross(f.ax, f.ay, f.bx, f.by, e.ax, e.ay)
      const d4 = cross(f.ax, f.ay, f.bx, f.by, e.bx, e.by)
      if (
        ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
        ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
      ) {
        return true
      }
    }
  }
  return false
}

const closeRing = (ring: THREE.Vector2[]): Ring => {
  const r: Ring = ring.map((v) => [v.x, v.y] as Ring[number])
  r.push(r[0])
  return r
}

/** How fine the staircase fallback steps: treads and rises both stay near a
 * typical print layer, so the stepped face is invisible in the print. The
 * preview passes stepScale 2 for half the clipping work per rebuild. */
const STEP_RISE = 0.5
const STEP_TREAD = 0.3

/** A drafted prism, built exactly where possible and robustly everywhere.
 *
 * Each tapered segment first tries the smooth loft: bisector-offset rings
 * bridged by ruled walls. That is the exact surface, but it folds over
 * itself wherever the inset exceeds a local feature — a corner arc tighter
 * than the offset, two scallop lobes closer than twice the draft — and the
 * fold is a self-intersection slicers reject. So every offset is validated
 * (ringsFold), and a folding segment falls back to a morphological
 * staircase: thin vertical extrusions of contours successively *eroded*
 * with polygon clipping — the same machinery the outlines are generated
 * with, where lobes merge instead of crossing — with flat treads between
 * steps. Holes rise vertically; the top chamfer offsets holes too, so the
 * opening chamfers with the rim. */
export function taperedSolid(
  rings: THREE.Vector2[][],
  levels: LoftLevel[],
  bevel = 0,
  stepScale = 1,
): THREE.BufferGeometry {
  const { finish, concat } = pieceCollector()
  const holes = rings.slice(1)
  const holesMp: MultiPolygon = holes.map((r) => [closeRing(r)])

  // Erosion sprinkles disc-sampled vertices along every concave stretch;
  // simplifying the result keeps repeated offsets from compounding them.
  const safeErode = (mp: MultiPolygon, r: number): MultiPolygon | null => {
    try {
      const out = simplify(erode(mp, r), 0.02)
      return out.length > 0 ? out : null
    } catch (error) {
      console.warn('keebforge: taper erosion failed, keeping straight face', error)
      return null
    }
  }
  const safeDiff = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => {
    try {
      return outlineDifference(a, b)
    } catch (error) {
      console.warn('keebforge: taper clipping failed, keeping unclipped face', error)
      return a
    }
  }
  const mpOf = (outers: THREE.Vector2[][]): MultiPolygon => outers.map((r) => [closeRing(r)])
  const vecsOf = (mp: MultiPolygon): THREE.Vector2[][] =>
    mp.flatMap((poly) => poly.map((ring) => ringToVec(ring as [number, number][])))

  /** Staircase from `from` up to z1, eroding `total` in all: vertical wall
   * up to each step boundary, then a smaller cross-section above it. Every
   * step erodes from the base with a growing radius rather than chaining
   * erosions — the result is the same (erosion composes) but vertex counts
   * stay flat. Returns the top cross-section.
   *
   * Each erosion interface is emitted as a full up-facing cap of the section
   * below plus a full down-facing cap of the section above. Where the two
   * coincide the faces cancel; the exposed tread ring survives. Clipping the
   * tread ring out directly would tie the mesh to another clipper run whose
   * output vertices need not match the contours' — this way every face
   * reuses the contour rings verbatim and the joints are exact by
   * construction. The chamfer passes cross-sections with the holes folded in
   * (`holed`), so erosion widens them and their walls ride along; segment
   * drafts erode the outer contour alone, with hole walls emitted full-height
   * by the caller — the caps' hole edges pair with each other. */
  const staircase = (
    from: MultiPolygon,
    z0: number,
    z1: number,
    total: number,
    holed: boolean,
  ): MultiPolygon => {
    const steps = Math.max(
      1,
      Math.ceil((z1 - z0) / (STEP_RISE * stepScale)),
      Math.ceil(total / (STEP_TREAD * stepScale)),
    )
    const capRegion = (mp: MultiPolygon) => (holed ? mp : safeDiff(mp, holesMp))
    let cur = from
    for (let s = 0; s < steps; s++) {
      const zA = z0 + ((z1 - z0) * s) / steps
      const zB = z0 + ((z1 - z0) * (s + 1)) / steps
      const walls = vecsOf(cur)
      loftBand(finish, walls, zA, walls, zB)
      const next = safeErode(from, (total * (s + 1)) / steps)
      if (!next) {
        // No material left (or clipping failed): wall up the rest and stop.
        if (s + 1 < steps) loftBand(finish, walls, zB, walls, z1)
        return cur
      }
      flatRegion(finish, capRegion(cur), zB)
      flatRegion(finish, capRegion(next), zB, true)
      cur = next
    }
    return cur
  }

  // The outer contour walks up the levels. Its own base inset may start
  // above zero when the part continues a draft begun by the part below it;
  // erosion (not a bisector offset) keeps that base identical to the top of
  // the part underneath, which used erosion for the same stretch.
  let outers: THREE.Vector2[][] = [rings[0]]
  if (levels[0].outer > 1e-6) {
    const eroded = safeErode(mpOf(outers), levels[0].outer)
    if (eroded) outers = vecsOf(eroded)
  }

  flatRegion(finish, safeDiff(mpOf(outers), holesMp), levels[0].z, true)

  for (let k = 0; k + 1 < levels.length; k++) {
    const z0 = levels[k].z
    const z1 = levels[k + 1].z
    const delta = levels[k + 1].outer - levels[k].outer
    if (delta > 1e-6) {
      const cand = outers.map((r) => offsetRingInward(r, delta))
      if (!ringsFold([...cand, ...holes], [...outers, ...holes])) {
        loftBand(finish, outers, z0, cand, z1)
        outers = cand
      } else {
        outers = vecsOf(staircase(mpOf(outers), z0, z1, delta, false))
      }
    } else {
      loftBand(finish, outers, z0, outers, z1)
    }
    loftBand(finish, holes, z0, holes, z1)
  }

  // Top: chamfered (outer pulled in, holes widened), or a flat cap when
  // there is no bevel or no room for one.
  const zTop = levels[levels.length - 1].z
  if (bevel > 1e-6) {
    // Positive offsets move every ring into the material: the outer edge
    // pulls in and the openings widen, which is what a chamfer does to both.
    const all = [...outers, ...holes]
    const cand = all.map((r) => offsetRingInward(r, bevel))
    if (outers.length === 1 && !ringsFold(cand, all)) {
      loftBand(finish, all, zTop, cand, zTop + bevel)
      flatRegion(finish, [cand.map(closeRing)], zTop + bevel)
      return concat()
    }
    const part = safeDiff(mpOf(outers), holesMp)
    const top = staircase(part, zTop, zTop + bevel, bevel, true)
    flatRegion(finish, top, zTop + bevel)
    return concat()
  }
  flatRegion(finish, safeDiff(mpOf(outers), holesMp), zTop)
  return concat()
}
