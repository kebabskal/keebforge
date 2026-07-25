import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  capSize,
  DEFAULT_TENT,
  isKeyMirrored,
  keyWorldXF,
  mirrorXF,
  type XForm,
} from '../model/keys'
import {
  caseBottomOutline,
  caseShells,
  CSK_DEPTH,
  foamWithCutouts,
  FOAM_THICKNESS,
  PCB_THICKNESS,
  pcbOutline,
  PLATE_THICKNESS,
  plateWithCutouts,
  SCREW,
  screwPositions,
  subtractDiscs,
  type MultiPolygon,
} from '../model/outline'
import { groupMap, useDocStore } from '../model/store'
import { useTheme } from '../ui/theme'
import { capGeo, CAP_PROFILE, frustumGeo } from './capGeometry'
import { loftRings, ringToVec, shapeFromRings, type LoftLevel } from './loft'
import { ViewBar } from './ViewBar'
import { useViewSettings } from './viewSettings'

/** Simplified switch/cap dimensions per type, mm (heights above plate top;
 * `lower` is the below-plate body depth measured down from the plate top). */
const SWITCH_3D = {
  mx: { housingBase: 15.6, housingTop: 11, housingH: 5.6, capBottom: 6, lower: 5.0 },
  choc: { housingBase: 15, housingTop: 13, housingH: 2.4, capBottom: 3.5, lower: 2.2 },
} as const

/** Hotswap socket hanging under the PCB. The board itself is modelled
 * separately, so this is just the socket body; together they still take the
 * 3.4 mm the bottom clearance was sized around. */
const SOCKET_W = 10
const SOCKET_D = 6.5
const SOCKET_H = 1.8

/** Even-odd point-in-ring test (ray cast along +x). */
function pointInRing(ring: [number, number][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function shapesFromPolygons(mp: MultiPolygon): THREE.Shape[] {
  return mp.map((poly) =>
    shapeFromRings(poly.map((ring) => ringToVec(ring as [number, number][]))),
  )
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
    // The wedge bottom is extruded past the desk and cut off at it.
    renderer.localClippingEnabled = true
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
    // Orbiting below the desk is allowed for underside inspection; the
    // backdrop hides itself when the camera goes under (see backdropVis).
    controls.maxPolarAngle = Math.PI - 0.05

    // Render on demand: the RAF loop only draws after something invalidated
    // (camera movement, rebuilds, view settings), so an idle preview costs no
    // GPU work. Damping keeps firing 'change' until the camera settles.
    let renderQueued = true
    const invalidate = () => {
      renderQueued = true
    }
    controls.addEventListener('change', invalidate)

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
    // Every other light points down, which would leave undersides pitch
    // black when orbiting below the desk for inspection.
    const underFill = new THREE.DirectionalLight(0xb8c4d8, 0.8)
    underFill.position.set(40, -120, 60)
    scene.add(underFill)

    // Table the keyboard rests on — a visible reference plane that makes the
    // typing-angle tilt readable. Sized/positioned per rebuild to the board
    // (its top tracks the case's resting plane, which the bottom part lowers).
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
      'caps' | 'switches' | 'case' | 'plate' | 'pcb' | 'foam' | 'bottom' | 'screws',
      THREE.Object3D[]
    > = { caps: [], switches: [], case: [], plate: [], pcb: [], foam: [], bottom: [], screws: [] }

    const applyViewSettings = () => {
      const v = useViewSettings.getState()
      camera.fov = v.fov
      camera.updateProjectionMatrix()
      const shown = {
        caps: v.showCaps,
        switches: v.showSwitches,
        case: v.showCase,
        plate: v.showPlate,
        pcb: v.showPcb,
        foam: v.showFoam,
        bottom: v.showBottom,
        screws: v.showScrews,
      }
      // Exploded view: raise each layer along the board normal by its place
      // in the assembly stack (bottom lid stays on the desk). Offsets are
      // applied on top of each mesh's recorded assembled position, so the
      // slider is cheap (no rebuild) and idempotent.
      // Assembly order, bottom to top: standoffs+lid stay on the desk, then
      // PCB, foam, plate, case shell, switches, caps (switches lift out through
      // the opened top). Uniform g gaps aren't enough around the shell — its
      // wall spans from below the plate to above the caps — so the shell and
      // everything above it get extra ramped clearance that separates the
      // layers fully once the explode gap passes ~5 mm.
      const g = v.explode
      const r = Math.min(1, g / 5)
      const lift = {
        bottom: 0,
        // Screws ride with the lid they pass through.
        screws: 0,
        pcb: g,
        foam: 2 * g,
        plate: 3 * g,
        case: 4 * g + 12 * r,
        switches: 5 * g + 30 * r,
        caps: 6 * g + 30 * r,
      }
      for (const part of Object.keys(partMeshes) as (keyof typeof partMeshes)[]) {
        for (const mesh of partMeshes[part]) {
          mesh.visible = shown[part]
          if (typeof mesh.userData.assembledY === 'number') {
            mesh.position.y = mesh.userData.assembledY + lift[part]
          }
        }
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
      backdropVis()
      ;(cyclo.material as THREE.MeshStandardMaterial).color.set(v.backdropColor)
      // VSM needs at least a little blur or its variance test bands visibly.
      sun.shadow.radius = Math.max(1, v.shadowBlur)
      ssaoPass.enabled = v.ssao
      invalidate()
    }

    // World-space cut at the desk surface for the wedge bottom; the constant
    // tracks the resting plane per rebuild.
    const groundClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

    const materials = {
      plate: new THREE.MeshStandardMaterial({ color: 0x878d99, metalness: 0.85, roughness: 0.38 }),
      foam: new THREE.MeshStandardMaterial({ color: 0x262a33, roughness: 1 }),
      bezel: new THREE.MeshStandardMaterial({ color: 0x454b58, metalness: 0.55, roughness: 0.45 }),
      // Case material again, but clipped at the desk (wedge bottoms only).
      wedge: new THREE.MeshStandardMaterial({
        color: 0x454b58,
        metalness: 0.55,
        roughness: 0.45,
        side: THREE.DoubleSide,
        clippingPlanes: [groundClip],
        clipShadows: true,
      }),
      housing: new THREE.MeshStandardMaterial({ color: 0x1e2025, roughness: 0.55 }),
      // Solder-mask green, fixed rather than doc-controlled like the foam.
      pcb: new THREE.MeshStandardMaterial({ color: 0x1f5c3a, roughness: 0.6 }),
      // Screw proxies: fixed dark steel, not doc-controlled.
      screw: new THREE.MeshStandardMaterial({ color: 0x33363d, metalness: 0.9, roughness: 0.35 }),
      cap: new THREE.MeshStandardMaterial({ color: 0xe7e3d7, roughness: 0.85 }),
      capAccent: new THREE.MeshStandardMaterial({ color: 0x5c7d6e, roughness: 0.85 }),
    }

    const board = new THREE.Group()
    scene.add(board)
    // Support posts stand vertically on the desk, so they live outside the
    // tilted/tented board frames.
    const posts = new THREE.Group()
    scene.add(posts)

    // Extruded plate/foam geometries are per-rebuild; switch/cap geometries
    // live in geoCache and are only disposed on unmount.
    let slabGeos: THREE.BufferGeometry[] = []
    const disposeBoard = () => {
      for (const geo of slabGeos) geo.dispose()
      slabGeos = []
      board.clear()
      posts.clear()
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
    // Desk height (the case's resting plane), tracked per rebuild so the
    // backdrop can hide itself when the camera orbits below it.
    let restingY = 0
    const backdropVis = () => {
      const v = useViewSettings.getState()
      const below = camera.position.y < restingY - 0.1
      ground.visible = !below && v.backdrop === 'table'
      cyclo.visible = !below && v.backdrop === 'studio'
    }

    const rebuild = () => {
      disposeBoard()
      const state = store.getState()
      const doc = {
        keys: state.keys,
        groups: state.groups,
        mirror: state.mirror,
        plate: state.plate,
        bezel: state.bezel,
        bottom: state.bottom,
        mounting: state.mounting,
        tilt: state.tilt,
        materials: state.materials,
      }
      const groups = groupMap(doc.groups)

      // The case interior is `clearance` deep below the plate (never less
      // than the foam layer), leaving room for switch bodies and sockets.
      // The case rests on the underside of the bottom part (when present),
      // which is also the tilt/tent pivot plane and the desk height.
      const cavity = doc.bottom.enabled
        ? Math.max(FOAM_THICKNESS, doc.bottom.clearance ?? 0)
        : FOAM_THICKNESS
      const caseBottomY = -PLATE_THICKNESS - cavity
      const bottomThickness = doc.bottom.enabled ? Math.max(0.5, doc.bottom.thickness) : 0
      const restY = caseBottomY - bottomThickness
      restingY = restY
      groundClip.constant = 0.05 - restY

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
      applyMaterial(materials.wedge, doc.materials.case)
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
      const tiltRad = ((doc.tilt || 0) * Math.PI) / 180
      const tentRad = split ? (((doc.mirror.tent ?? DEFAULT_TENT) * Math.PI) / 180) : 0
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

      /** Orient, place and register one built part. Raw geometry is authored
       * in the XY plane rising along +Z, the way an extrusion comes out. */
      const placePart = (
        raw: THREE.BufferGeometry,
        ring: [number, number][],
        part: 'plate' | 'pcb' | 'foam' | 'case' | 'bottom',
        y: number,
        material: THREE.Material,
        shadows: boolean,
        preCreased = false,
      ) => {
        // Extrusions come flat-shaded, so curved outline corners read as
        // facets. Smooth normals across shallow face angles only — real
        // edges (the 45° bevel chamfer, top/bottom rims, cutout corners)
        // stay creased. Lofted parts crease per band as they are built, so
        // they arrive already normalled.
        const geo = preCreased ? raw : toCreasedNormals(raw, Math.PI / 6)
        if (!preCreased) raw.dispose()
        slabGeos.push(geo)
        const mesh = new THREE.Mesh(geo, material)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = y
        mesh.userData.assembledY = y
        mesh.castShadow = shadows
        mesh.receiveShadow = true
        let sMinX = Infinity
        let sMaxX = -Infinity
        for (const [x] of ring) {
          sMinX = Math.min(sMinX, x)
          sMaxX = Math.max(sMaxX, x)
        }
        noteX(sMinX, sMaxX)
        if (split) {
          const pts = sidePts[(sMinX + sMaxX) / 2 < axis ? 'left' : 'right']
          for (const [x, y] of ring) pts.push([x, -y])
        }
        targetFor((sMinX + sMaxX) / 2).add(mesh)
        partMeshes[part].push(mesh)
      }

      /** A part whose outer face tapers with height. `insetAt` gives the
       * outer pull-in at any world height, so parts stacked along the case
       * continue one unbroken profile. `breaks` are world heights where that
       * profile changes slope — a level is planted at each one falling inside
       * this band, so the break lands exactly where asked even mid-part.
       * `bevel` chamfers the top edge, opening included. */
      const addTaperedSlab = (
        mp: MultiPolygon,
        part: 'case',
        thickness: number,
        y: number,
        material: THREE.Material,
        shadows: boolean,
        insetAt: (worldY: number) => number,
        breaks: number[],
        bevel = 0,
      ) => {
        const b = Math.max(0, Math.min(bevel, thickness / 2 - 0.05))
        const top = y + thickness - b
        const levels: LoftLevel[] = [{ z: 0, outer: insetAt(y), hole: 0 }]
        for (const at of breaks) {
          if (at > y + 1e-6 && at < top - 1e-6) levels.push({ z: at - y, outer: insetAt(at), hole: 0 })
        }
        levels.push({ z: top - y, outer: insetAt(top), hole: 0 })
        // The chamfer pulls both boundaries in on top of whatever draft has
        // already accumulated.
        if (b > 0) levels.push({ z: thickness, outer: insetAt(top) + b, hole: b })
        for (const poly of mp) {
          const rings = poly.map((ring) => ringToVec(ring as [number, number][]))
          if (rings[0].length < 3) continue
          placePart(
            loftRings(rings, levels), poly[0] as [number, number][],
            part, y, material, shadows, true,
          )
        }
      }

      const addSlab = (
        mp: MultiPolygon,
        part: 'plate' | 'pcb' | 'foam' | 'case' | 'bottom',
        thickness: number,
        y: number,
        material: THREE.Material,
        shadows: boolean,
        bevel = 0,
      ) => {
        const b = Math.max(0, Math.min(bevel, thickness / 2 - 0.05))
        shapesFromPolygons(mp).forEach((shape, i) => {
          const extruded = new THREE.ExtrudeGeometry(shape, {
            depth: thickness - 2 * b,
            bevelEnabled: b > 0,
            bevelThickness: b,
            bevelSize: b,
            bevelOffset: -b,
            bevelSegments: 1,
            curveSegments: 6,
          })
          placePart(extruded, mp[i][0] as [number, number][], part, y + b, material, shadows)
        })
      }
      // Candidate contact points for tight-bottom support posts, in each case
      // piece's pre-tilt frame; realized once the tilt/tent transforms exist.
      const supportPoints: { target: THREE.Object3D; x: number; z: number }[] = []

      // The board sits against the underside of the switch bodies. A mixed
      // board only gets one depth, so it clears the deepest type present and
      // shallower switches stand off it.
      const pcbTop = -Math.max(
        PLATE_THICKNESS,
        ...doc.keys.map((k) => SWITCH_3D[k.type].lower),
      )
      // Plate foam fills what is left between the plate and the board, rather
      // than a fixed depth — on Choc a nominal 3.5 mm layer would reach below
      // the switches and swallow the board. On MX the gap is exactly the
      // nominal thickness, so those boards are unchanged.
      const foamH = Math.max(0, -PLATE_THICKNESS - pcbTop)

      // A clipping failure should degrade to "no plate shown", not crash the
      // whole app (React unmounts the tree on uncaught render errors).
      try {
        const plateMp = plateWithCutouts(doc)
        trackFront(plateMp)
        addSlab(plateMp, 'plate', PLATE_THICKNESS, -PLATE_THICKNESS, materials.plate, true)
        if (foamH > 0.05) {
          addSlab(foamWithCutouts(doc), 'foam', foamH, pcbTop, materials.foam, false)
        }
        addSlab(
          pcbOutline(doc),
          'pcb',
          PCB_THICKNESS,
          pcbTop - PCB_THICKNESS,
          materials.pcb,
          true,
        )
        // Hollow top shell: wall ring from the lid plane up to the plate
        // top, rim ring (keycap opening) above it, and the supporting lip
        // reaching up to the plate's underside. Plate and foam are cut to
        // the cavity, so nothing interpenetrates.
        const screws = screwPositions(doc)
        if (doc.bezel.enabled && doc.bezel.width > 0) {
          const bevel = Math.min(doc.bezel.bevel ?? 0, doc.bezel.width / 2 - 0.05)
          const wallH = PLATE_THICKNESS + cavity
          // Self-tapping pilots are blind: only as deep as the screw bites,
          // so the wall still reads solid from inside the case. Splitting the
          // band at that depth is how an extruded outline gets a blind hole.
          const pilotH = Math.min(SCREW.bite, wallH)
          // The wall and rim share the hull, so their outer faces form one
          // continuous surface from the lid plane to the top of the rim. The
          // draft is spread over that whole height and each band picks up the
          // slice it spans, so the slope never breaks at a seam.
          const rimH = doc.bezel.height > 0 ? doc.bezel.height : 0
          const outerH = wallH + rimH
          const draft = Math.max(0, doc.bezel.draft ?? 0)
          // The face stays vertical up to the break, then tapers the rest of
          // the way to the top of the rim.
          const breakY = caseBottomY + Math.max(0, Math.min(doc.bezel.draftStart ?? 0, outerH))
          const taperH = caseBottomY + outerH - breakY
          const insetAt = (y: number) =>
            taperH > 1e-6 ? (draft * Math.max(0, y - breakY)) / taperH : 0
          const breaks = [breakY]
          for (const shell of caseShells(doc)) {
            trackFront(shell.hull)
            if (screws.length > 0) {
              const drilled = subtractDiscs(shell.wall, screws, SCREW.pilotR)
              const splitY = caseBottomY + pilotH
              addTaperedSlab(
                drilled, 'case', pilotH, caseBottomY, materials.bezel, true, insetAt, breaks,
              )
              if (wallH > pilotH) {
                addTaperedSlab(
                  shell.wall, 'case', wallH - pilotH, splitY, materials.bezel, true, insetAt, breaks,
                )
              }
            } else {
              addTaperedSlab(
                shell.wall, 'case', wallH, caseBottomY, materials.bezel, true, insetAt, breaks,
              )
            }
            if (rimH > 0) {
              addTaperedSlab(
                shell.rim, 'case', rimH, 0, materials.bezel, true, insetAt, breaks, bevel,
              )
            }
          }
        }
        // Bottom case under the whole footprint. `tight` is a plate hugging
        // the underside (posts come later, once transforms are known);
        // `wedge` extrudes deep enough to reach the desk at full tilt/tent
        // and is cut off at it by the clipping plane.
        if (doc.bottom.enabled) {
          // Lid screws go up through the lid into the bezel wall. The lid is
          // opened to the countersink's full width; the collars below put the
          // bore back, leaving a cone seat over a clearance hole.
          const bottomMp = subtractDiscs(caseBottomOutline(doc), screws, SCREW.cskR)
          trackFront(bottomMp)
          let extent = 0
          for (const poly of bottomMp) {
            let minX = Infinity
            let maxX = -Infinity
            let minY = Infinity
            let maxY = -Infinity
            for (const [x, y] of poly[0]) {
              minX = Math.min(minX, x)
              maxX = Math.max(maxX, x)
              minY = Math.min(minY, y)
              maxY = Math.max(maxY, y)
            }
            extent = Math.max(extent, maxX - minX, maxY - minY)
            const inset = Math.min(8, (maxX - minX) / 4, (maxY - minY) / 4)
            const target = targetFor((minX + maxX) / 2)
            // The outline is rarely a rectangle, so bounds corners can land
            // in empty space; walk them toward the center until they sit
            // under actual case, or drop them.
            const cx = (minX + maxX) / 2
            const cy = (minY + maxY) / 2
            const ring = poly[0] as [number, number][]
            for (const [px, py] of [
              [minX + inset, minY + inset],
              [maxX - inset, minY + inset],
              [minX + inset, maxY - inset],
              [maxX - inset, maxY - inset],
            ]) {
              // Post radius is 4; require that much clearance so a post
              // never overhangs the case edge.
              const fits = (x: number, y: number) =>
                pointInRing(ring, x, y) &&
                pointInRing(ring, x - 4, y) &&
                pointInRing(ring, x + 4, y) &&
                pointInRing(ring, x, y - 4) &&
                pointInRing(ring, x, y + 4)
              for (let t = 0; t <= 0.65; t += 0.13) {
                const qx = px + (cx - px) * t
                const qy = py + (cy - py) * t
                if (fits(qx, qy)) {
                  supportPoints.push({ target, x: qx, z: -qy })
                  break
                }
              }
            }
          }
          // Screw proxies (shaft + countersunk head) sit in the lid holes and
          // ride with the lid — in the exploded view they read as studs
          // waiting to bite into the wall above.
          if (screws.length > 0) {
            const shaftLen = bottomThickness + SCREW.bite
            const shaftGeo = new THREE.CylinderGeometry(SCREW.shaftR, SCREW.shaftR, shaftLen, 12)
            // Countersunk head: a cone widening to its major radius at the
            // lid's underside, matching the seat it drops into.
            const headGeo = new THREE.CylinderGeometry(SCREW.shaftR, SCREW.headR, SCREW.headH, 16)
            // The seat itself. Extrusions can only cut straight holes, so the
            // lid is opened to the full countersink and this collar restores
            // the material around the bore: a cone down to the underside,
            // then a plain clearance bore up to the lid's top face.
            const seatDepth = Math.min(CSK_DEPTH, Math.max(0, bottomThickness - 0.3))
            // Profile runs counter-clockwise in the (radius, height) plane so
            // the revolved faces end up pointing out of the solid ring.
            const collarLathe = new THREE.LatheGeometry(
              [
                new THREE.Vector2(SCREW.cskR, 0),
                new THREE.Vector2(SCREW.cskR, bottomThickness),
                new THREE.Vector2(SCREW.lidHoleR, bottomThickness),
                new THREE.Vector2(SCREW.lidHoleR, seatDepth),
                new THREE.Vector2(SCREW.cskR, 0),
              ],
              24,
            )
            // A lathe shares vertices across profile corners, which would
            // round off the seat's rim; crease it back like the slabs.
            const collarGeo = toCreasedNormals(collarLathe, Math.PI / 6)
            collarLathe.dispose()
            slabGeos.push(shaftGeo, headGeo, collarGeo)
            for (const [sx, sy] of screws) {
              const shaft = new THREE.Mesh(shaftGeo, materials.screw)
              shaft.position.set(sx, restY + shaftLen / 2, -sy)
              shaft.userData.assembledY = shaft.position.y
              const head = new THREE.Mesh(headGeo, materials.screw)
              head.position.set(sx, restY + SCREW.headH / 2, -sy)
              head.userData.assembledY = head.position.y
              targetFor(sx).add(shaft, head)
              partMeshes.screws.push(shaft, head)
              // The collar is lid material, not fastener — it stays visible
              // when the screws are hidden, so the seats read as holes.
              const collar = new THREE.Mesh(collarGeo, materials.bezel)
              collar.position.set(sx, restY, -sy)
              collar.userData.assembledY = collar.position.y
              collar.castShadow = true
              collar.receiveShadow = true
              targetFor(sx).add(collar)
              partMeshes.bottom.push(collar)
            }
          }
          // Tray ridge: an inset rim rising from the lid to the plate's
          // underside — the bottom becomes a tray whose lip supports the
          // plate from below, sandwiching it against the top case's rim.
          const ridgeMp = caseShells(doc).flatMap((s) => s.ridge)
          if (ridgeMp.length > 0) {
            addSlab(ridgeMp, 'bottom', cavity, caseBottomY, materials.bezel, false)
          }
          if (doc.bottom.mode === 'tight') {
            addSlab(bottomMp, 'bottom', bottomThickness, restY, materials.bezel, true)
          } else {
            const depth =
              bottomThickness +
              Math.min(300, extent * (Math.tan(Math.abs(tiltRad)) + Math.tan(Math.abs(tentRad)))) +
              2
            addSlab(bottomMp, 'bottom', depth, caseBottomY - depth, materials.wedge, true)
          }
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
        housing.userData.assembledY = 0
        holder.add(housing)
        partMeshes.switches.push(housing)

        // Below-plate body, through the plate cutout — this plus the board
        // and socket under it is what the bottom clearance has to swallow.
        const lower = new THREE.Mesh(
          cachedFrustum('lower', 13.8, 13.8, 13.8, 13.8, dims.lower),
          materials.housing,
        )
        lower.position.y = -dims.lower
        lower.userData.assembledY = -dims.lower
        holder.add(lower)
        partMeshes.switches.push(lower)
        // Hotswap sockets mount on the board's underside, so they hang off
        // the PCB rather than off each switch.
        const socket = new THREE.Mesh(
          cachedFrustum('socket', SOCKET_W, SOCKET_D, SOCKET_W, SOCKET_D, SOCKET_H),
          materials.housing,
        )
        const socketY = pcbTop - PCB_THICKNESS - SOCKET_H
        socket.position.y = socketY
        socket.userData.assembledY = socketY
        holder.add(socket)
        partMeshes.pcb.push(socket)

        const capMesh = new THREE.Mesh(
          cachedCap(key.type, cap.w, cap.h, key.convex === true),
          key.label ? materials.cap : materials.capAccent,
        )
        capMesh.position.y = dims.capBottom
        capMesh.userData.assembledY = dims.capBottom
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

        const groundY = restY
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
      const rad = tiltRad
      const pivotY = restY
      const pivotZ = frontY === Infinity ? 0 : -frontY
      board.rotation.x = rad
      board.position.set(
        0,
        pivotY - (pivotY * Math.cos(rad) - pivotZ * Math.sin(rad)),
        pivotZ - (pivotY * Math.sin(rad) + pivotZ * Math.cos(rad)),
      )

      // Tight bottoms rest on posts: vertical pillars from the desk up to the
      // case underside wherever tilt/tent lift it clear. Tops are embedded a
      // little so the inclined underside never shows a gap over the post.
      if (doc.bottom.enabled && doc.bottom.mode === 'tight') {
        board.updateMatrixWorld(true)
        const embed = 1 + 4 * Math.tan(Math.abs(tiltRad) + Math.abs(tentRad))
        for (const p of supportPoints) {
          const world = p.target.localToWorld(new THREE.Vector3(p.x, restY, p.z))
          const h = world.y - restY
          if (h < 1) continue
          // Thick where they meet the case, tapering toward the desk.
          const geo = new THREE.CylinderGeometry(4, 3, h + embed, 20)
          slabGeos.push(geo)
          const mesh = new THREE.Mesh(geo, materials.bezel)
          mesh.position.set(world.x, restY + (h + embed) / 2, world.z)
          mesh.castShadow = true
          mesh.receiveShadow = true
          posts.add(mesh)
          partMeshes.bottom.push(mesh)
        }
      }

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
      ground.position.set(bounds.cx, restY - 0.01 - TABLE_THICKNESS / 2, bounds.cz)
      cyclo.position.y = restY - 0.01
      buildCyclorama(bounds.cx, bounds.cz, bounds.radius)
      applyViewSettings()
    }

    rebuild()
    controls.target.set(bounds.cx, 0, bounds.cz)
    // Framing distances are tuned for a 40° FOV; narrower lenses back off
    // proportionally so the board still fills the view.
    const fovScale =
      Math.tan((40 * Math.PI) / 360) /
      Math.tan((useViewSettings.getState().fov * Math.PI) / 360)
    camera.position.set(
      bounds.cx,
      bounds.radius * 1.4 * fovScale,
      bounds.cz + bounds.radius * 1.7 * fovScale,
    )
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
        state.bottom !== last.bottom ||
        state.mounting !== last.mounting ||
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
      invalidate()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      if (!renderQueued) return
      renderQueued = false
      backdropVis()
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

  return (
    <div className="editor preview3d">
      <div className="preview-canvas" ref={wrapRef} />
      <ViewBar />
    </div>
  )
}
