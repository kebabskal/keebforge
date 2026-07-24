import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { capSize, isKeyMirrored, keyWorldXF, mirrorXF, type XForm } from '../model/keys'
import {
  bezelShape,
  FOAM_CLEARANCE,
  FOAM_THICKNESS,
  PLATE_THICKNESS,
  plateWithCutouts,
  type MultiPolygon,
} from '../model/outline'
import { groupMap, useDocStore } from '../model/store'
import { useTheme } from '../ui/theme'
import { useViewSettings } from './viewSettings'

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
  // Shapes close implicitly; the rings' duplicated closing point (and any
  // coincident neighbours) create zero-length edges that turn the bevel
  // offset into NaNs, which culls the whole mesh.
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

export function Preview3D() {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const store = useDocStore
    const light = useTheme.getState().theme === 'light'

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    wrap.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(light ? 0xe6e9ef : 0x16171d)

    const camera = new THREE.PerspectiveCamera(useViewSettings.getState().fov, 1, 1, 6000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI / 2 - 0.02

    const hemi = new THREE.HemisphereLight(0xcdd8f2, 0x2a251e, 0.75)
    scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xffffff, 2.4)
    sun.position.set(80, 160, 100)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x9fb4e8, 0.5)
    fill.position.set(-60, 80, -90)
    scene.add(fill)

    // Table the keyboard rests on — a visible reference plane that makes the
    // typing-angle tilt readable. Sized/positioned per rebuild to the board.
    const TABLE_TOP = -FOAM_THICKNESS - PLATE_THICKNESS - 0.01
    const TABLE_THICKNESS = 18
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: light ? 0xd9c7a7 : 0x352c22,
        roughness: 0.95,
      }),
    )
    ground.receiveShadow = true
    scene.add(ground)

    // Studio backdrop: a seamless floor that bends up into a back wall
    // (cyclorama), rebuilt to fit the board bounds.
    const cyclo = new THREE.Mesh(
      undefined,
      new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 1 }),
    )
    cyclo.receiveShadow = true
    cyclo.position.y = TABLE_TOP
    scene.add(cyclo)
    const buildCyclorama = (cx: number, cz: number, radius: number) => {
      const width = Math.max(1800, radius * 5)
      const front = cz + Math.max(900, radius * 3)
      const bendZ = cz - (radius + 160)
      const bendR = 220
      const wallH = 700
      const profile: [number, number][] = [[front, 0]]
      const SEG = 20
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * (Math.PI / 2)
        profile.push([bendZ - Math.sin(a) * bendR, bendR - Math.cos(a) * bendR])
      }
      profile.push([bendZ - bendR, bendR + wallH])
      const pos: number[] = []
      const idx: number[] = []
      profile.forEach(([z, y], i) => {
        pos.push(cx - width / 2, y, z, cx + width / 2, y, z)
        if (i > 0) {
          const a = 2 * (i - 1)
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      cyclo.geometry?.dispose()
      cyclo.geometry = geo
    }

    const applyViewSettings = () => {
      const v = useViewSettings.getState()
      camera.fov = v.fov
      camera.updateProjectionMatrix()
      sun.intensity = v.keyLight
      const az = (v.lightAngle * Math.PI) / 180
      sun.position.set(
        bounds.cx + Math.cos(az) * 180,
        160,
        bounds.cz + Math.sin(az) * 180,
      )
      fill.intensity = v.fillLight
      hemi.intensity = v.ambient
      ground.visible = v.backdrop === 'table'
      cyclo.visible = v.backdrop === 'studio'
      ;(cyclo.material as THREE.MeshStandardMaterial).color.set(v.backdropColor)
    }

    const materials = {
      plate: new THREE.MeshStandardMaterial({ color: 0x878d99, metalness: 0.85, roughness: 0.38 }),
      foam: new THREE.MeshStandardMaterial({ color: 0x262a33, roughness: 1 }),
      bezel: new THREE.MeshStandardMaterial({ color: 0x454b58, metalness: 0.55, roughness: 0.45 }),
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
      const doc = {
        keys: state.keys,
        groups: state.groups,
        mirror: state.mirror,
        plate: state.plate,
        bezel: state.bezel,
        tilt: state.tilt,
        colors: state.colors,
      }
      const groups = groupMap(doc.groups)

      materials.bezel.color.set(doc.colors.case)
      materials.cap.color.set(doc.colors.cap)
      materials.capAccent.color.set(doc.colors.capAccent)

      // Front edge of the board (min 2D y across outlines) — the tilt pivot.
      let frontY = Infinity
      const trackFront = (mp: MultiPolygon) => {
        for (const poly of mp) {
          for (const [, y] of poly[0]) frontY = Math.min(frontY, y)
        }
      }

      // Plate and foam, extruded from the generated outlines.
      // `bevel` chamfers the top and bottom edges inward (holes chamfer
      // outward), keeping the outline footprint unchanged.
      const addSlab = (
        mp: MultiPolygon,
        thickness: number,
        y: number,
        material: THREE.Material,
        shadows: boolean,
        bevel = 0,
      ) => {
        const b = Math.max(0, Math.min(bevel, thickness / 2 - 0.05))
        for (const shape of shapesFromPolygons(mp)) {
          const geo = new THREE.ExtrudeGeometry(shape, {
            depth: thickness - 2 * b,
            bevelEnabled: b > 0,
            bevelThickness: b,
            bevelSize: b,
            bevelOffset: -b,
            bevelSegments: 1,
            curveSegments: 6,
          })
          slabGeos.push(geo)
          const mesh = new THREE.Mesh(geo, material)
          mesh.rotation.x = -Math.PI / 2
          mesh.position.y = y + b
          mesh.castShadow = shadows
          mesh.receiveShadow = true
          board.add(mesh)
        }
      }
      // A clipping failure should degrade to "no plate shown", not crash the
      // whole app (React unmounts the tree on uncaught render errors).
      try {
        const plateMp = plateWithCutouts(doc)
        trackFront(plateMp)
        addSlab(plateMp, PLATE_THICKNESS, -PLATE_THICKNESS, materials.plate, true)
        addSlab(
          plateWithCutouts(doc, FOAM_CLEARANCE),
          FOAM_THICKNESS,
          -PLATE_THICKNESS - FOAM_THICKNESS,
          materials.foam,
          false,
        )
        // The bezel rim runs from the ground to `height` above the plate top,
        // so it reads as the case wall around plate and foam.
        if (doc.bezel.enabled && doc.bezel.height > 0) {
          const bezelMp = bezelShape(doc)
          trackFront(bezelMp)
          addSlab(
            bezelMp,
            doc.bezel.height + PLATE_THICKNESS + FOAM_THICKNESS,
            -PLATE_THICKNESS - FOAM_THICKNESS,
            materials.bezel,
            true,
            Math.min(doc.bezel.bevel ?? 0, doc.bezel.width / 2 - 0.05),
          )
        }
      } catch (error) {
        console.warn('keebforge: plate outline generation failed', error)
      }

      // Switches and keycaps (mirrored copies included).
      const worlds: { world: XForm; key: (typeof doc.keys)[number] }[] = []
      for (const key of doc.keys) {
        const world = keyWorldXF(key, groups)
        worlds.push({ key, world })
        if (doc.mirror.enabled && isKeyMirrored(key, groups)) {
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

      // Tilt the whole board about its front bottom edge, so the front stays
      // on the ground and the back rises (positive = typing angle).
      const rad = ((doc.tilt || 0) * Math.PI) / 180
      const pivotY = -PLATE_THICKNESS - FOAM_THICKNESS
      const pivotZ = frontY === Infinity ? 0 : -frontY
      board.rotation.x = rad
      board.position.set(
        0,
        pivotY - (pivotY * Math.cos(rad) - pivotZ * Math.sin(rad)),
        pivotZ - (pivotY * Math.sin(rad) + pivotZ * Math.cos(rad)),
      )

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
      ground.scale.set(
        Math.max(900, bounds.radius * 2 + 300),
        TABLE_THICKNESS,
        Math.max(600, bounds.radius * 2 + 200),
      )
      ground.position.set(bounds.cx, TABLE_TOP - TABLE_THICKNESS / 2, bounds.cz)
      buildCyclorama(bounds.cx, bounds.cz, bounds.radius)
      applyViewSettings()
    }

    rebuild()
    controls.target.set(bounds.cx, 0, bounds.cz)
    camera.position.set(bounds.cx, bounds.radius * 1.4, bounds.cz + bounds.radius * 1.7)
    controls.update()

    // Outline generation is too heavy for every drag frame; throttle the
    // scene rebuild. Single edits still rebuild near-instantly.
    let rebuildTimer: ReturnType<typeof setTimeout> | undefined
    let rebuildLastRun = 0
    const scheduleRebuild = () => {
      const wait = Math.max(0, 150 - (performance.now() - rebuildLastRun))
      clearTimeout(rebuildTimer)
      rebuildTimer = setTimeout(() => {
        rebuildLastRun = performance.now()
        rebuild()
      }, wait)
    }

    let last = store.getState()
    const unsubscribe = store.subscribe((state) => {
      if (
        state.keys !== last.keys ||
        state.groups !== last.groups ||
        state.mirror !== last.mirror ||
        state.plate !== last.plate ||
        state.bezel !== last.bezel ||
        state.tilt !== last.tilt ||
        state.colors !== last.colors
      ) {
        scheduleRebuild()
      }
      last = state
    })
    const unsubscribeView = useViewSettings.subscribe(applyViewSettings)

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
      clearTimeout(rebuildTimer)
      unsubscribe()
      unsubscribeView()
      observer.disconnect()
      controls.dispose()
      disposeBoard()
      for (const geo of geoCache.values()) geo.dispose()
      for (const m of Object.values(materials)) m.dispose()
      ground.geometry.dispose()
      ;(ground.material as THREE.Material).dispose()
      cyclo.geometry?.dispose()
      ;(cyclo.material as THREE.Material).dispose()
      renderer.dispose()
      wrap.removeChild(renderer.domElement)
    }
  }, [])

  return <div className="editor" ref={wrapRef} />
}
