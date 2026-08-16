/** The solid-modelling backend: manifold-3d, for the operations a stack of
 * extruded outlines cannot express.
 *
 * Everything here used to be done in plan view. A part was a 2D region swept
 * up a fixed distance, so a hole was a plan-view shape too — which is why the
 * case is split into bands at every height where a cut starts or stops, and
 * why anything shaped in a *vertical* plane (the connector opening's rounded
 * top) had no way to be cut at all and was faked by adding material back.
 *
 * Both cost more than they look. The bands are separate meshes, each normalled
 * on its own, so one continuous drafted face arrives at the renderer as three
 * or four surfaces that disagree at their seams and read as stripes down the
 * side of the case. And fill is only ever correct if it lands exactly inside
 * someone else's geometry; the corner slivers measured right and still floated
 * in the opening.
 *
 * A boolean does both properly: the bands union into one solid whose taper is
 * one surface, and a cutter can be any shape in any orientation. */
import * as THREE from 'three'
import Module from 'manifold-3d'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'

let mf: ManifoldToplevel | null = null

/** Load the WASM module. Idempotent; must resolve before any solid is built. */
export async function initManifold(): Promise<void> {
  if (mf) return
  const wasm = await Module()
  wasm.setup()
  mf = wasm
}

export function manifoldReady(): boolean {
  return mf !== null
}

/** The module itself, for callers building primitives. Throws if the load
 * failed — callers guard with `manifoldReady()` and fall back to the
 * extrusion path, which needs no WASM module to have arrived. */
export function csg(): ManifoldToplevel {
  if (!mf) throw new Error('manifold used before initManifold() resolved')
  return mf
}

// Resolved before the first render, so the geometry builders stay synchronous.
// A failure is not fatal: `manifoldReady()` stays false and the case falls
// back to banded extrusions, which is what it was before this module existed.
try {
  await initManifold()
} catch (error) {
  console.warn('keebforge: manifold unavailable, falling back to banded extrusion', error)
}

/** Grid the mesh's vertices are welded on, in reciprocal mm: 1e-5 mm, far
 * below any tolerance the outlines carry. Our meshes are built from shared
 * ring vertices, so faces that should meet carry bit-identical coordinates and
 * this only has to undo the un-indexing, not repair anything. */
const WELD = 1e5

/** Property channel the normals live in. Zero is the standard slot, and the
 * one the library intends to keep supporting: a mesh row is the position
 * first and the properties after it, so the normal sits at offset 3 of a
 * six-wide row, and `getMesh(0)` knows to re-orient it for transforms and for
 * faces that ended up on the back side of a subtraction. */
const NORMAL_SLOT = 0

/** A triangle soup as a solid, or null if it is not one.
 *
 * Normals ride along as vertex properties rather than being recomputed on the
 * far side. They are authored by whoever built the surface — who knows which
 * edges are real — and a boolean carries properties through, so the case comes
 * out of the cut shaded the way it was drawn, including on the faces the cut
 * itself created.
 *
 * That makes the weld two-part. Vertices are unique per position *and* normal,
 * since a hard edge is exactly a position holding two normals; `merge` then
 * records which of those are the same point geometrically, which is what
 * Manifold needs to see a closed surface. The morphological staircase still
 * fails that check by design — it emits coincident up- and down-facing caps
 * that cancel visually but leave every erosion interface with four triangles
 * on an edge — so a folded taper returns null here and the caller keeps its
 * bands. */
export function solidOf(geo: THREE.BufferGeometry): Manifold | null {
  if (!mf) return null
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos) return null
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const index = geo.getIndex()
  const count = index ? index.count : pos.count
  const stride = nor ? 6 : 3
  const verts: number[] = []
  const tris = new Uint32Array(count)
  const seen = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const v = index ? index.getX(i) : i
    const x = pos.getX(v)
    const y = pos.getY(v)
    const z = pos.getZ(v)
    let key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`
    if (nor) {
      // Normals only need enough resolution to tell two shading groups apart.
      key += `|${Math.round(nor.getX(v) * 1e3)},${Math.round(nor.getY(v) * 1e3)},${Math.round(nor.getZ(v) * 1e3)}`
    }
    let id = seen.get(key)
    if (id === undefined) {
      id = verts.length / stride
      seen.set(key, id)
      verts.push(x, y, z)
      if (nor) verts.push(nor.getX(v), nor.getY(v), nor.getZ(v))
    }
    tris[i] = id
  }
  try {
    const mesh = new mf.Mesh({
      numProp: stride,
      vertProperties: new Float32Array(verts),
      triVerts: tris,
    })
    // Pairs up the vertices split above for their normals, so the surface
    // reads as closed even where its shading is not.
    if (nor) mesh.merge()
    return new mf.Manifold(mesh)
  } catch (error) {
    console.warn('keebforge: mesh is not a solid, skipping the boolean', error)
    return null
  }
}

/** Give a solid built from primitives the normals it would have been authored
 * with. Only for shapes simple enough that an angle tells the truth about
 * them — a cylinder's wall against its end cap, a swept profile against its
 * ends — which is every cutter here, and never the case itself. Needed as much
 * for the property count as for the shading: a boolean wants both sides
 * carrying the same channels. */
export function withNormals(solid: Manifold, sharpAngle = 40): Manifold {
  const out = solid.calculateNormals(NORMAL_SLOT, sharpAngle)
  solid.delete()
  return out
}

/** A solid back as a renderable geometry, normals and all.
 *
 * The normals are the ones its inputs carried, re-oriented by any transform
 * and flipped on faces that came out of the back side of a subtraction. A
 * solid that arrives without them — nothing does today — is given faceted
 * ones rather than none, since a lit surface with no normals renders black. */
export function geometryOf(solid: Manifold): THREE.BufferGeometry {
  const shaded = solid.numProp() >= 3 ? solid : solid.calculateNormals(NORMAL_SLOT, 0)
  const mesh = shaded.getMesh(NORMAL_SLOT)
  if (shaded !== solid) shaded.delete()
  const n = mesh.numVert
  const stride = mesh.numProp
  const position = new Float32Array(n * 3)
  const normal = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    position[i * 3] = mesh.vertProperties[i * stride]
    position[i * 3 + 1] = mesh.vertProperties[i * stride + 1]
    position[i * 3 + 2] = mesh.vertProperties[i * stride + 2]
    normal[i * 3] = mesh.vertProperties[i * stride + 3]
    normal[i * 3 + 1] = mesh.vertProperties[i * stride + 4]
    normal[i * 3 + 2] = mesh.vertProperties[i * stride + 5]
  }
  const repaired = repairNormals(position, normal, Array.from(mesh.triVerts))
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(repaired.position, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(repaired.normal, 3))
  geo.setIndex(new THREE.Uint32BufferAttribute(repaired.index, 1))
  return geo
}

/** Cosine of how far a vertex normal may lean off the face it belongs to
 * before it is treated as wrong rather than smooth. A blend leans by at most
 * half the angle it spans, and nothing here smooths across more than the
 * coarsest level's ~82°, so anything past 60° is not shading. */
const MAX_LEAN = Math.cos((60 * Math.PI) / 180)

/** Repoint any triangle corner whose normal has come away from its own face.
 *
 * A boolean invents vertices where the cut meets the surface, and has to give
 * each one properties. Where the cut lands on a seam between two of the
 * solid's own faces, the vertex it makes there can be handed the neighbouring
 * face's normal instead of its own — a horizontal ledge holding a wall normal,
 * on the order of one triangle in a thousand, which reads as a bright or black
 * speck. They are cheap to find, because a normal that disagrees with its face
 * this badly cannot have been authored: the offender gets a copy of the vertex
 * carrying the face's own normal, so only that corner is corrected and every
 * other face sharing the vertex keeps its shading. */
function repairNormals(
  position: Float32Array,
  normal: Float32Array,
  tris: number[],
): { position: Float32Array; normal: Float32Array; index: Uint32Array } {
  const fixed = new Map<string, number>()
  const extraPos: number[] = []
  const extraNor: number[] = []
  let count = position.length / 3
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]]
    const ux = position[b * 3] - position[a * 3]
    const uy = position[b * 3 + 1] - position[a * 3 + 1]
    const uz = position[b * 3 + 2] - position[a * 3 + 2]
    const vx = position[c * 3] - position[a * 3]
    const vy = position[c * 3 + 1] - position[a * 3 + 1]
    const vz = position[c * 3 + 2] - position[a * 3 + 2]
    const fx = uy * vz - uz * vy
    const fy = uz * vx - ux * vz
    const fz = ux * vy - uy * vx
    const fl = Math.hypot(fx, fy, fz)
    if (fl < 1e-12) continue
    for (let k = 0; k < 3; k++) {
      const v = tris[t + k]
      const dot =
        (fx * normal[v * 3] + fy * normal[v * 3 + 1] + fz * normal[v * 3 + 2]) / fl
      if (dot >= MAX_LEAN) continue
      const key = `${v}|${Math.round((fx / fl) * 1e3)},${Math.round((fy / fl) * 1e3)},${Math.round((fz / fl) * 1e3)}`
      let id = fixed.get(key)
      if (id === undefined) {
        id = count++
        fixed.set(key, id)
        extraPos.push(position[v * 3], position[v * 3 + 1], position[v * 3 + 2])
        extraNor.push(fx / fl, fy / fl, fz / fl)
      }
      tris[t + k] = id
    }
  }
  const index = new Uint32Array(tris)
  if (extraPos.length === 0) return { position, normal, index }
  const pos = new Float32Array(position.length + extraPos.length)
  pos.set(position)
  pos.set(extraPos, position.length)
  const nor = new Float32Array(normal.length + extraNor.length)
  nor.set(normal)
  nor.set(extraNor, normal.length)
  return { position: pos, normal: nor, index }
}

/** Union a list of solids, deleting the inputs. Empty list gives null. */
export function unionAll(parts: Manifold[]): Manifold | null {
  if (!mf || parts.length === 0) return null
  const out = parts.length === 1 ? parts[0] : mf.Manifold.union(parts)
  if (parts.length > 1) for (const p of parts) p.delete()
  return out
}
