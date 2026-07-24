import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js'
import {
  capSize,
  DEFAULT_TENT,
  isKeyMirrored,
  keyWorldXF,
  mirrorXF,
  type XForm,
} from '../model/keys'
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
import { capGeo, CAP_PROFILE, frustumGeo } from './capGeometry'
import { useViewSettings } from './viewSettings'

/** Simplified switch/cap dimensions per type, mm (heights above plate top). */
const SWITCH_3D = {
  mx: { housingBase: 15.6, housingTop: 11, housingH: 5.6, capBottom: 6 },
  choc: { housingBase: 15, housingTop: 13, housingH: 2.4, capBottom: 3.5 },
} as const

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
    // VSM blurs the shadow map itself, giving real soft penumbras.
    renderer.shadowMap.type = THREE.VSMShadowMap
    wrap.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(light ? 0xe6e9ef : 0x16171d)

    const camera = new THREE.PerspectiveCamera(useViewSettings.getState().fov, 1, 1, 6000)

    // Post-processing: multisampled render target so AA survives, SSAO for
    // contact shading, OutputPass for the sRGB conversion.
    const composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }),
    )
    composer.addPass(new RenderPass(scene, camera))
    const ssaoPass = new SSAOPass(scene, camera, 1, 1)
    ssaoPass.kernelRadius = 8
    ssaoPass.minDistance = 0.0002
    ssaoPass.maxDistance = 0.01
    composer.addPass(ssaoPass)
    composer.addPass(new OutputPass())

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
    sun.shadow.radius = 5
    sun.shadow.blurSamples = 12
    sun.shadow.bias = -0.0002
    // Cover all receivers (table, backdrop): fragments beyond the shadow
    // camera's depth range otherwise read as a shadow seam under VSM.
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 4000
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

    // Meshes grouped by part, so visibility toggles apply without a rebuild.
    // Repopulated on every rebuild.
    const partMeshes: Record<
      'caps' | 'switches' | 'case' | 'plate' | 'foam',
      THREE.Object3D[]
    > = { caps: [], switches: [], case: [], plate: [], foam: [] }

    const applyViewSettings = () => {
      const v = useViewSettings.getState()
      camera.fov = v.fov
      camera.updateProjectionMatrix()
      const shown = {
        caps: v.showCaps,
        switches: v.showSwitches,
        case: v.showCase,
        plate: v.showPlate,
        foam: v.showFoam,
      }
      for (const part of Object.keys(partMeshes) as (keyof typeof partMeshes)[]) {
        for (const mesh of partMeshes[part]) mesh.visible = shown[part]
      }
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
      // VSM needs at least a little blur or its variance test bands visibly.
      sun.shadow.radius = Math.max(1, v.shadowBlur)
      ssaoPass.enabled = v.ssao
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
    const cachedCap = (type: 'mx' | 'choc', w: number, h: number, convex: boolean) => {
      const key = `cap:${type}:${w.toFixed(2)}x${h.toFixed(2)}:${convex ? 'x' : 'c'}`
      let geo = geoCache.get(key)
      if (!geo) {
        geo = capGeo(w, h, CAP_PROFILE[type], convex)
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
        materials: state.materials,
      }
      const groups = groupMap(doc.groups)

      const applyMaterial = (
        target: THREE.MeshStandardMaterial,
        m: { color: string; roughness: number; specular: number },
      ) => {
        target.color.set(m.color)
        target.roughness = m.roughness
        target.metalness = m.specular
      }
      applyMaterial(materials.plate, doc.materials.plate)
      applyMaterial(materials.bezel, doc.materials.case)
      applyMaterial(materials.cap, doc.materials.cap)
      applyMaterial(materials.capAccent, doc.materials.capAccent)

      // Front edge of the board (min 2D y across outlines) — the tilt pivot.
      let frontY = Infinity
      const trackFront = (mp: MultiPolygon) => {
        for (const poly of mp) {
          for (const [, y] of poly[0]) frontY = Math.min(frontY, y)
        }
      }

      // Split case: each half is a nested pair of groups — the inner one for
      // yaw about the half's center, the outer one for tenting about the
      // half's outer bottom edge (inner edges rise toward the middle).
      const split = doc.mirror.enabled && doc.mirror.split === true
      const axis = doc.mirror.axis
      const makeHalf = () => {
        const tent = new THREE.Group()
        const yaw = new THREE.Group()
        tent.add(yaw)
        return { tent, yaw }
      }
      const halves = { left: makeHalf(), right: makeHalf() }
      const outerX = { left: Infinity, right: -Infinity }
      const sideBounds = {
        left: { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
        right: { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
      }
      // Footprint samples per half (x, z), used to keep yawed halves apart.
      const sidePts = { left: [] as [number, number][], right: [] as [number, number][] }
      if (split) board.add(halves.left.tent, halves.right.tent)
      const targetFor = (x: number) => {
        if (!split) return board
        const side = x < axis ? 'left' : 'right'
        return halves[side].yaw
      }
      const noteX = (x0: number, x1: number) => {
        if (!split) return
        if ((x0 + x1) / 2 < axis) outerX.left = Math.min(outerX.left, x0)
        else outerX.right = Math.max(outerX.right, x1)
      }

      // Plate and foam, extruded from the generated outlines.
      // `bevel` chamfers the top and bottom edges inward (holes chamfer
      // outward), keeping the outline footprint unchanged.
      for (const part of Object.keys(partMeshes) as (keyof typeof partMeshes)[]) {
        partMeshes[part] = []
      }

      const addSlab = (
        mp: MultiPolygon,
        part: 'plate' | 'foam' | 'case',
        thickness: number,
        y: number,
        material: THREE.Material,
        shadows: boolean,
        bevel = 0,
      ) => {
        const b = Math.max(0, Math.min(bevel, thickness / 2 - 0.05))
        shapesFromPolygons(mp).forEach((shape, i) => {
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
          let sMinX = Infinity
          let sMaxX = -Infinity
          for (const [x] of mp[i][0]) {
            sMinX = Math.min(sMinX, x)
            sMaxX = Math.max(sMaxX, x)
          }
          noteX(sMinX, sMaxX)
          if (split) {
            const pts = sidePts[(sMinX + sMaxX) / 2 < axis ? 'left' : 'right']
            for (const [x, y] of mp[i][0]) pts.push([x, -y])
          }
          targetFor((sMinX + sMaxX) / 2).add(mesh)
          partMeshes[part].push(mesh)
        })
      }
      // A clipping failure should degrade to "no plate shown", not crash the
      // whole app (React unmounts the tree on uncaught render errors).
      try {
        const plateMp = plateWithCutouts(doc)
        trackFront(plateMp)
        addSlab(plateMp, 'plate', PLATE_THICKNESS, -PLATE_THICKNESS, materials.plate, true)
        addSlab(
          plateWithCutouts(doc, FOAM_CLEARANCE),
          'foam',
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
            'case',
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
        partMeshes.switches.push(housing)

        const capMesh = new THREE.Mesh(
          cachedCap(key.type, cap.w, cap.h, key.convex === true),
          key.label ? materials.cap : materials.capAccent,
        )
        capMesh.position.y = dims.capBottom
        capMesh.castShadow = true
        holder.add(capMesh)
        partMeshes.caps.push(capMesh)

        noteX(world.x - 12, world.x + 12)
        if (split) {
          const side = world.x < axis ? 'left' : 'right'
          const b = sideBounds[side]
          b.minX = Math.min(b.minX, world.x)
          b.maxX = Math.max(b.maxX, world.x)
          b.minZ = Math.min(b.minZ, -world.y)
          b.maxZ = Math.max(b.maxZ, -world.y)
          sidePts[side].push([world.x - 12, -world.y], [world.x + 12, -world.y])
        }
        targetFor(world.x).add(holder)
        minX = Math.min(minX, world.x - 20)
        maxX = Math.max(maxX, world.x + 20)
        minZ = Math.min(minZ, -world.y - 20)
        maxZ = Math.max(maxZ, -world.y + 20)
      }

      // Yaw each half about its center (positive = backs angle inward), then
      // tent about its outer bottom edge so the inner edges rise toward the
      // middle like a tent.
      if (split) {
        const rotRad = (((doc.mirror.rotation ?? 0) * Math.PI) / 180)
        const applyYaw = (
          g: THREE.Group,
          b: (typeof sideBounds)['left'],
          theta: number,
        ) => {
          if (!Number.isFinite(b.minX)) return
          const px = (b.minX + b.maxX) / 2
          const pz = (b.minZ + b.maxZ) / 2
          const cos = Math.cos(theta)
          const sin = Math.sin(theta)
          g.rotation.y = theta
          g.position.set(
            px - (px * cos + pz * sin),
            0,
            pz - (-px * sin + pz * cos),
          )
        }
        applyYaw(halves.left.yaw, sideBounds.left, -rotRad)
        applyYaw(halves.right.yaw, sideBounds.right, rotRad)

        const tentRad = (((doc.mirror.tent ?? DEFAULT_TENT) * Math.PI) / 180)
        const groundY = -PLATE_THICKNESS - FOAM_THICKNESS
        const applyTent = (g: THREE.Group, px: number, theta: number) => {
          if (!Number.isFinite(px)) return
          const cos = Math.cos(theta)
          const sin = Math.sin(theta)
          g.rotation.z = theta
          g.position.set(
            px - (px * cos - groundY * sin),
            groundY - (px * sin + groundY * cos),
            0,
          )
        }
        applyTent(halves.left.tent, outerX.left, tentRad)
        applyTent(halves.right.tent, outerX.right, -tentRad)

        // Keep the halves apart: yawing swings inner corners toward the
        // seam, so measure each half's rotated footprint and separate them
        // to a small clearance if they would cross.
        const innerEdge = (side: 'left' | 'right', theta: number) => {
          const b = sideBounds[side]
          if (!Number.isFinite(b.minX) || sidePts[side].length === 0) return null
          const px = (b.minX + b.maxX) / 2
          const pz = (b.minZ + b.maxZ) / 2
          const cos = Math.cos(theta)
          const sin = Math.sin(theta)
          let edge = side === 'left' ? -Infinity : Infinity
          for (const [x, z] of sidePts[side]) {
            const xr = px + (x - px) * cos + (z - pz) * sin
            edge = side === 'left' ? Math.max(edge, xr) : Math.min(edge, xr)
          }
          return edge
        }
        const leftEdge = innerEdge('left', -rotRad)
        const rightEdge = innerEdge('right', rotRad)
        if (leftEdge !== null && rightEdge !== null) {
          const overlap = leftEdge - rightEdge + 2
          if (overlap > 0) {
            halves.left.tent.position.x -= overlap / 2
            halves.right.tent.position.x += overlap / 2
          }
        }
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
        // Generous margin: covers the table and keeps blurred caster depths
        // away from the map edge, where they would smear into a seam.
        const size = bounds.radius + 300
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
        state.materials !== last.materials
      ) {
        scheduleRebuild()
      }
      last = state
    })
    const unsubscribeView = useViewSettings.subscribe(applyViewSettings)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = wrap
      renderer.setSize(w, h)
      composer.setPixelRatio(window.devicePixelRatio)
      composer.setSize(w, h)
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
      composer.render()
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
      composer.dispose()
      renderer.dispose()
      wrap.removeChild(renderer.domElement)
    }
  }, [])

  return <div className="editor" ref={wrapRef} />
}
