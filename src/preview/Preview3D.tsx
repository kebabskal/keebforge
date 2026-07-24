import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { capSize, keyWorldXF, mirrorXF, type XForm } from '../model/keys'
import {
  FOAM_CLEARANCE,
  FOAM_THICKNESS,
  PLATE_THICKNESS,
  plateWithCutouts,
  type MultiPolygon,
} from '../model/outline'
import { groupMap, useDocStore } from '../model/store'

/** Simplified switch/cap dimensions per type, mm (heights above plate top). */
const SWITCH_3D = {
  mx: { housingBase: 15.6, housingTop: 11, housingH: 5.6, capBottom: 6, capH: 7.5, capTaper: 4.5 },
  choc: { housingBase: 15, housingTop: 13, housingH: 2.4, capBottom: 3.5, capH: 3.2, capTaper: 3 },
} as const

/** Tapered box: bottom bw×bd at y=0, top tw×td at y=h. */
function frustumGeo(bw: number, bd: number, tw: number, td: number, h: number) {
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

function shapesFromPolygons(mp: MultiPolygon): THREE.Shape[] {
  return mp.map((poly) => {
    const toVec = (ring: [number, number][]) => ring.map(([x, y]) => new THREE.Vector2(x, y))
    const shape = new THREE.Shape(toVec(poly[0] as [number, number][]))
    for (let i = 1; i < poly.length; i++) {
      shape.holes.push(new THREE.Path(toVec(poly[i] as [number, number][])))
    }
    return shape
  })
}

export function Preview3D() {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const store = useDocStore

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    wrap.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x16171d)

    const camera = new THREE.PerspectiveCamera(40, 1, 1, 3000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI / 2 - 0.02

    scene.add(new THREE.HemisphereLight(0xcdd8f2, 0x2a251e, 0.75))
    const sun = new THREE.DirectionalLight(0xffffff, 2.4)
    sun.position.set(80, 160, 100)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x9fb4e8, 0.5)
    fill.position.set(-60, 80, -90)
    scene.add(fill)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -FOAM_THICKNESS - PLATE_THICKNESS - 0.01
    ground.receiveShadow = true
    scene.add(ground)

    const materials = {
      plate: new THREE.MeshStandardMaterial({ color: 0x878d99, metalness: 0.85, roughness: 0.38 }),
      foam: new THREE.MeshStandardMaterial({ color: 0x262a33, roughness: 1 }),
      housing: new THREE.MeshStandardMaterial({ color: 0x1e2025, roughness: 0.55 }),
      cap: new THREE.MeshStandardMaterial({ color: 0xe7e3d7, roughness: 0.85 }),
      capAccent: new THREE.MeshStandardMaterial({ color: 0x5c7d6e, roughness: 0.85 }),
    }

    const board = new THREE.Group()
    scene.add(board)

    // Extruded plate/foam geometries are per-rebuild; switch/cap geometries
    // live in geoCache and are only disposed on unmount.
    let slabGeos: THREE.BufferGeometry[] = []
    const disposeBoard = () => {
      for (const geo of slabGeos) geo.dispose()
      slabGeos = []
      board.clear()
    }

    const geoCache = new Map<string, THREE.BufferGeometry>()
    const cachedFrustum = (
      kind: string,
      bw: number,
      bd: number,
      tw: number,
      td: number,
      h: number,
    ) => {
      const key = `${kind}:${bw.toFixed(2)},${bd.toFixed(2)},${h.toFixed(2)}`
      let geo = geoCache.get(key)
      if (!geo) {
        geo = frustumGeo(bw, bd, tw, td, h)
        geoCache.set(key, geo)
      }
      return geo
    }

    let bounds = { cx: 0, cz: 0, radius: 120 }

    const rebuild = () => {
      disposeBoard()
      const state = store.getState()
      const doc = { keys: state.keys, groups: state.groups, mirror: state.mirror, plate: state.plate }
      const groups = groupMap(doc.groups)

      // Plate and foam, extruded from the generated outlines.
      const addSlab = (
        mp: MultiPolygon,
        thickness: number,
        y: number,
        material: THREE.Material,
        shadows: boolean,
      ) => {
        for (const shape of shapesFromPolygons(mp)) {
          const geo = new THREE.ExtrudeGeometry(shape, {
            depth: thickness,
            bevelEnabled: false,
            curveSegments: 6,
          })
          slabGeos.push(geo)
          const mesh = new THREE.Mesh(geo, material)
          mesh.rotation.x = -Math.PI / 2
          mesh.position.y = y
          mesh.castShadow = shadows
          mesh.receiveShadow = true
          board.add(mesh)
        }
      }
      addSlab(plateWithCutouts(doc), PLATE_THICKNESS, -PLATE_THICKNESS, materials.plate, true)
      addSlab(
        plateWithCutouts(doc, FOAM_CLEARANCE),
        FOAM_THICKNESS,
        -PLATE_THICKNESS - FOAM_THICKNESS,
        materials.foam,
        false,
      )

      // Switches and keycaps (mirrored copies included).
      const worlds: { world: XForm; key: (typeof doc.keys)[number] }[] = []
      for (const key of doc.keys) {
        const world = keyWorldXF(key, groups)
        worlds.push({ key, world })
        if (doc.mirror.enabled) {
          worlds.push({ key, world: mirrorXF(world, doc.mirror.axis) })
        }
      }
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const { key, world } of worlds) {
        const dims = SWITCH_3D[key.type]
        const cap = capSize(key)
        const holder = new THREE.Group()
        holder.position.set(world.x, 0, -world.y)
        holder.rotation.y = (world.r * Math.PI) / 180

        const housing = new THREE.Mesh(
          cachedFrustum(
            'housing',
            dims.housingBase,
            dims.housingBase,
            dims.housingTop,
            dims.housingTop,
            dims.housingH,
          ),
          materials.housing,
        )
        holder.add(housing)

        const capMesh = new THREE.Mesh(
          cachedFrustum(
            `cap-${key.type}-${key.w}x${key.h}`,
            cap.w,
            cap.h,
            Math.max(cap.w - dims.capTaper, 4),
            Math.max(cap.h - dims.capTaper, 4),
            dims.capH,
          ),
          key.label ? materials.cap : materials.capAccent,
        )
        capMesh.position.y = dims.capBottom
        capMesh.castShadow = true
        holder.add(capMesh)

        board.add(holder)
        minX = Math.min(minX, world.x - 20)
        maxX = Math.max(maxX, world.x + 20)
        minZ = Math.min(minZ, -world.y - 20)
        maxZ = Math.max(maxZ, -world.y + 20)
      }

      if (worlds.length > 0) {
        bounds = {
          cx: (minX + maxX) / 2,
          cz: (minZ + maxZ) / 2,
          radius: Math.max(maxX - minX, maxZ - minZ) / 2 + 30,
        }
        const size = bounds.radius + 40
        sun.shadow.camera.left = -size
        sun.shadow.camera.right = size
        sun.shadow.camera.top = size
        sun.shadow.camera.bottom = -size
        sun.shadow.camera.updateProjectionMatrix()
        sun.target.position.set(bounds.cx, 0, bounds.cz)
        sun.target.updateMatrixWorld()
      }
    }

    rebuild()
    controls.target.set(bounds.cx, 0, bounds.cz)
    camera.position.set(bounds.cx, bounds.radius * 1.4, bounds.cz + bounds.radius * 1.7)
    controls.update()

    let last = store.getState()
    const unsubscribe = store.subscribe((state) => {
      if (
        state.keys !== last.keys ||
        state.groups !== last.groups ||
        state.mirror !== last.mirror ||
        state.plate !== last.plate
      ) {
        rebuild()
      }
      last = state
    })

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = wrap
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
      observer.disconnect()
      controls.dispose()
      disposeBoard()
      for (const geo of geoCache.values()) geo.dispose()
      for (const m of Object.values(materials)) m.dispose()
      ground.geometry.dispose()
      ;(ground.material as THREE.Material).dispose()
      renderer.dispose()
      wrap.removeChild(renderer.domElement)
    }
  }, [])

  return <div className="editor" ref={wrapRef} />
}
