import * as THREE from 'three'

/** Keycap profiles: DSA for MX, LDSA for choc. Uniform spherical-top caps;
 * `taper` is the total base-to-top inset, `dish` the depth of the spherical
 * top (inverted for convex spacebar/modifier caps). */
export const CAP_PROFILE = {
  mx: { height: 7.4, taper: 5.4, dish: 1.0, cornerR: 1.7, topCornerR: 3.5 },
  choc: { height: 4.2, taper: 4.4, dish: 0.7, cornerR: 1.5, topCornerR: 3.0 },
} as const

/** Rounded-rect outline in the xz-plane with a fixed point count. */
function roundedRectOutline(w: number, h: number, r: number): [number, number][] {
  const N_CORNER = 10
  const rr = Math.min(r, Math.min(w, h) / 2 - 0.05)
  const corners: [number, number, number][] = [
    [w / 2 - rr, -(h / 2 - rr), -90],
    [w / 2 - rr, h / 2 - rr, 0],
    [-(w / 2 - rr), h / 2 - rr, 90],
    [-(w / 2 - rr), -(h / 2 - rr), 180],
  ]
  const pts: [number, number][] = []
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= N_CORNER; i++) {
      const a = ((a0 + (90 * i) / N_CORNER) * Math.PI) / 180
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
    }
  }
  return pts
}

/** DSA/LDSA-style keycap: rounded-square base tapering to a smaller, rounder
 * top, finished with a spherical dish (or crown, when convex). Base sits at
 * y=0, +y up. */
export function capGeo(
  w: number,
  h: number,
  p: { height: number; taper: number; dish: number; cornerR: number; topCornerR: number },
  convex: boolean,
): THREE.BufferGeometry {
  const topW = Math.max(w - p.taper, 3)
  const topH = Math.max(h - p.taper, 3)
  const base = roundedRectOutline(w, h, p.cornerR)
  const top = roundedRectOutline(topW, topH, p.topCornerR)
  const n = base.length
  const dishZ = (s: number) => (convex ? 1 : -1) * p.dish * (1 - s * s)

  const pos: number[] = []
  const pushRing = (pts: [number, number][], scale: number, y: number) => {
    for (const [x, z] of pts) pos.push(x * scale, y, z * scale)
  }
  // Dish rings cluster near the rim, where the surface bends fastest.
  const DISH_S = [0.97, 0.9, 0.8, 0.68, 0.55, 0.42, 0.28, 0.14]
  pushRing(base, 1, 0)
  pushRing(top, 1, p.height)
  for (const s of DISH_S) pushRing(top, s, p.height + dishZ(s))
  const center = pos.length / 3
  pos.push(0, p.height + dishZ(0), 0)

  const idx: number[] = []
  const ringCount = 2 + DISH_S.length
  for (let ring = 0; ring < ringCount - 1; ring++) {
    for (let i = 0; i < n; i++) {
      const a = ring * n + i
      const b = ring * n + ((i + 1) % n)
      const c = (ring + 1) * n + i
      const d = (ring + 1) * n + ((i + 1) % n)
      idx.push(a, c, b, b, c, d)
    }
  }
  const last = (ringCount - 1) * n
  for (let i = 0; i < n; i++) {
    idx.push(last + i, center, last + ((i + 1) % n))
  }
  // Closed bottom: shadow mapping rasterizes back faces, and an open shell
  // has none from an overhead light, so open caps cast no shadow. The disk
  // gets its own copy of the base ring — sharing vertices with the side wall
  // would average the wall normals toward -y and shade the bottom edge dark.
  const bottomStart = pos.length / 3
  for (const [x, z] of base) pos.push(x, 0, z)
  const bottomCenter = pos.length / 3
  pos.push(0, 0, 0)
  for (let i = 0; i < n; i++) {
    idx.push(bottomStart + i, bottomStart + ((i + 1) % n), bottomCenter)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

/** Tapered box: bottom bw×bd at y=0, top tw×td at y=h. */
export function frustumGeo(bw: number, bd: number, tw: number, td: number, h: number) {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  geo.translate(0, 0.5, 0)
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const top = y > 0.5
    pos.setXYZ(i, pos.getX(i) * (top ? tw : bw), y * h, pos.getZ(i) * (top ? td : bd))
  }
  geo.computeVertexNormals()
  return geo
}
