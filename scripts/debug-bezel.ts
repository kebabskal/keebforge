/** Dev script: numerically inspect outline generation + 3D extrusion.
 * Run: bun scripts/debug-bezel.ts [path/to/layout.json] */
import * as THREE from 'three'
import {
  DEFAULT_BEZEL,
  DEFAULT_MATERIALS,
  DEFAULT_PLATE,
  DEFAULT_TILT,
  U,
  type Doc,
} from '../src/model/keys'
import {
  bezelShape,
  plateOutline,
  plateWithCutouts,
  type MultiPolygon,
} from '../src/model/outline'

const path = process.argv[2] ?? `${import.meta.dir}/../examples/test.json`
const parsed = await Bun.file(path).json()
const doc: Doc = {
  keys: parsed.keys ?? [],
  groups: parsed.groups ?? [],
  mirror: parsed.mirror ?? { enabled: false, axis: 6 * U },
  plate: { ...DEFAULT_PLATE, ...parsed.plate },
  bezel: { ...DEFAULT_BEZEL, ...parsed.bezel },
  tilt: parsed.tilt ?? DEFAULT_TILT,
  materials: structuredClone(DEFAULT_MATERIALS),
}
console.log(
  `${path}: ${doc.keys.length} keys, mirror=${doc.mirror.enabled}, bezel mode=${doc.bezel.mode} radius=${doc.bezel.radius}`,
)

function ringStats(mp: MultiPolygon, name: string) {
  let nan = 0
  let rings = 0
  let pts = 0
  let minEdge = Infinity
  let sharp = 0
  for (const poly of mp) {
    for (const ring of poly) {
      rings++
      pts += ring.length
      for (const [x, y] of ring) if (!Number.isFinite(x) || !Number.isFinite(y)) nan++
      for (let i = 0; i < ring.length - 1; i++) {
        const l = Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1])
        if (l > 0) minEdge = Math.min(minEdge, l)
      }
      // sharp corners: adjacent edges both > 1mm and turn angle > 30deg
      const n = ring.length - 1
      for (let i = 0; i < n; i++) {
        const a = ring[(i + n - 1) % n]
        const b = ring[i]
        const c = ring[(i + 1) % n]
        const l1 = Math.hypot(b[0] - a[0], b[1] - a[1])
        const l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
        if (l1 < 1 || l2 < 1) continue
        const dot =
          ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2)
        if (dot < Math.cos((30 * Math.PI) / 180)) sharp++
      }
    }
  }
  console.log(
    `  ${name}: polys=${mp.length} rings=${rings} pts=${pts} minEdge=${minEdge.toFixed(4)} sharpCorners=${sharp} NaN=${nan}`,
  )
}

function shapesFromPolygons(mp: MultiPolygon): THREE.Shape[] {
  const toVec = (ring: [number, number][]) => {
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
  return mp.map((poly) => {
    const shape = new THREE.Shape(toVec(poly[0] as [number, number][]))
    for (let i = 1; i < poly.length; i++) {
      shape.holes.push(new THREE.Path(toVec(poly[i] as [number, number][])))
    }
    return shape
  })
}

const time = <T,>(name: string, fn: () => T): T => {
  const t = performance.now()
  try {
    return fn()
  } finally {
    console.log(`${name}: ${(performance.now() - t).toFixed(1)}ms`)
  }
}

const po = time('plateOutline', () => plateOutline(doc))
ringStats(po, 'plateOutline')
const pc = time('plateWithCutouts', () => plateWithCutouts(doc))

const modes: ('tight' | 'box')[] = ['tight', 'box']
const shapes: Record<string, MultiPolygon> = {}
for (const mode of modes) {
  const d = { ...doc, bezel: { ...doc.bezel, mode } }
  const bz = time(`bezelShape(${mode})`, () => bezelShape(d))
  ringStats(bz, `bezel ${mode}`)
  shapes[mode] = bz
}

// Extrude like Preview3D does (bevel path) and scan for NaN.
for (const [name, mp, bevel] of [
  ['plate (no bevel)', pc, 0],
  ['bezel tight (bevel 1.5)', shapes.tight, 1.5],
  ['bezel box (bevel 1.5)', shapes.box, 1.5],
] as const) {
  let nan = 0
  let meshes = 0
  for (const shape of shapesFromPolygons(mp)) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 11 - 2 * bevel,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: 1,
      curveSegments: 6,
    })
    meshes++
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count * 3; i++) {
      if (!Number.isFinite((pos.array as Float32Array)[i])) nan++
    }
  }
  console.log(`extrude ${name}: meshes=${meshes} NaN=${nan}`)
}
