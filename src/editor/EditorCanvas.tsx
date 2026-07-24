import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  capSize,
  groupWorldXF,
  hitTest,
  isKeyMirrored,
  keySize,
  keyWorldXF,
  mirrorXF,
  SPEC,
  worldToLocal,
  type Key,
  type XForm,
} from '../model/keys'
import {
  bezelShape,
  plateOutline,
  SCREW,
  screwPositions,
  type MultiPolygon,
} from '../model/outline'
import {
  coalesceUndo,
  groupMap,
  memberKeyIds,
  topGroupOf,
  useDocStore,
  wholeSelectedGroup,
  type TransformPatches,
} from '../model/store'
import { useTheme } from '../ui/theme'

const PALETTES = {
  dark: {
    bg: 0x16171d,
    grid: 0x23252e,
    gridCenter: 0x30333f,
    base: 0x1e2028,
    baseSelected: 0x263248,
    capMx: 0x4c505f,
    capChoc: 0x46605d,
    capSelected: 0x5f6a8c,
    outline: 0x6aa6ff,
    groupOutline: 0x8f7ddb,
    mirrorAxis: 0x50b88a,
    bezel: 0x77809a,
    screw: 0x9b8f6e,
    ghost: 0x3b3f4d,
    snapGuide: 0xe0607e,
    label: '#e8eaf0',
  },
  light: {
    bg: 0xf2f3f6,
    grid: 0xe1e4ea,
    gridCenter: 0xd2d6df,
    base: 0xd6dae2,
    baseSelected: 0xc3d4f2,
    capMx: 0xfdfdfb,
    capChoc: 0xe9f2f0,
    capSelected: 0xbfd0f0,
    outline: 0x2f6fd0,
    groupOutline: 0x7a5fd0,
    mirrorAxis: 0x2e9968,
    bezel: 0x9aa2b5,
    screw: 0x8d7c4f,
    ghost: 0xc4c9d3,
    snapGuide: 0xd23a60,
    label: '#2c313b',
  },
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

function makeLabelTexture(label: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.font = '600 72px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(label, 128, 70, 240)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function EditorCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const dimsRef = useRef<HTMLDivElement>(null)
  const gizmoRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const band = bandRef.current
    const dims = dimsRef.current
    const gizmoLayer = gizmoRef.current
    if (!wrap || !band || !dims || !gizmoLayer) return

    const store = useDocStore
    const COLORS = PALETTES[useTheme.getState().theme]

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(COLORS.bg)
    wrap.appendChild(renderer.domElement)
    const canvas = renderer.domElement

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    camera.position.z = 10

    // Grid on the XY plane, one line per 19.05mm unit.
    const grid = new THREE.GridHelper(84 * 19.05, 84, COLORS.gridCenter, COLORS.grid)
    grid.rotation.x = Math.PI / 2
    grid.position.z = -1
    scene.add(grid)

    // View state: center in mm, zoom in px per mm.
    const view = { cx: 0, cy: 0, zoom: 6 }
    const fitToContent = () => {
      const state = store.getState()
      if (state.keys.length === 0) return
      const groups = groupMap(state.groups)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      let minXMirrored = Infinity
      for (const k of state.keys) {
        const w = keyWorldXF(k, groups)
        minX = Math.min(minX, w.x - 20)
        maxX = Math.max(maxX, w.x + 20)
        minY = Math.min(minY, w.y - 20)
        maxY = Math.max(maxY, w.y + 20)
        if (isKeyMirrored(k, groups)) minXMirrored = Math.min(minXMirrored, w.x - 20)
      }
      if (state.mirror.enabled && minXMirrored < Infinity) {
        maxX = Math.max(maxX, 2 * state.mirror.axis - minXMirrored)
      }
      view.cx = (minX + maxX) / 2
      view.cy = (minY + maxY) / 2
      const { clientWidth: w, clientHeight: h } = wrap
      if (w > 0 && h > 0) {
        view.zoom = Math.min(w / (maxX - minX), h / (maxY - minY), 12) * 0.95
      }
    }

    // Assigned once the gizmo helpers exist; camera moves must reposition
    // the HTML gizmo overlay too.
    let positionGizmosHook: () => void = () => {}

    // Render on demand: the RAF loop only draws after something invalidated,
    // so an idle editor costs no GPU work.
    let renderQueued = true
    const invalidate = () => {
      renderQueued = true
    }

    const applyCamera = () => {
      const { clientWidth: w, clientHeight: h } = wrap
      camera.left = view.cx - w / 2 / view.zoom
      camera.right = view.cx + w / 2 / view.zoom
      camera.top = view.cy + h / 2 / view.zoom
      camera.bottom = view.cy - h / 2 / view.zoom
      camera.updateProjectionMatrix()
      positionGizmosHook()
      invalidate()
    }

    const toMM = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: view.cx + (clientX - rect.left - rect.width / 2) / view.zoom,
        y: view.cy - (clientY - rect.top - rect.height / 2) / view.zoom,
      }
    }
    const mmToPx = (x: number, y: number) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: (x - view.cx) * view.zoom + rect.width / 2,
        y: (view.cy - y) * view.zoom + rect.height / 2,
      }
    }

    // ---- Key meshes -------------------------------------------------------

    const geoCache = new Map<string, THREE.BufferGeometry>()
    const shapeGeo = (kind: string, w: number, h: number, r: number) => {
      const cacheKey = `${kind}:${w.toFixed(2)}x${h.toFixed(2)}:${r.toFixed(2)}`
      let geo = geoCache.get(cacheKey)
      if (!geo) {
        geo = new THREE.ShapeGeometry(roundedRect(w, h, r))
        geoCache.set(cacheKey, geo)
      }
      return geo
    }
    // Traces the exact pitch-area footprint (matching the base mesh), so
    // tangent keys show touching outlines and real overlaps stay visible.
    // Sampled with the same divisions ShapeGeometry uses, so the line hugs
    // the fill's corner arcs exactly.
    const outlineGeo = (w: number, h: number, r: number) => {
      const cacheKey = `outline:${w.toFixed(2)}x${h.toFixed(2)}:${r.toFixed(2)}`
      let geo = geoCache.get(cacheKey)
      if (!geo) {
        geo = new THREE.BufferGeometry().setFromPoints(
          roundedRect(w, h, r).getPoints(12),
        )
        geoCache.set(cacheKey, geo)
      }
      return geo
    }
    // Cap corner radius; the base radius grows by the cap inset so the two
    // rounded rects are concentric.
    const CAP_RADIUS = 1.6
    const baseRadius = (size: { w: number }, cap: { w: number }) =>
      CAP_RADIUS + (size.w - cap.w) / 2

    const materials = {
      base: new THREE.MeshBasicMaterial({ color: COLORS.base }),
      baseSelected: new THREE.MeshBasicMaterial({ color: COLORS.baseSelected }),
      capMx: new THREE.MeshBasicMaterial({ color: COLORS.capMx }),
      capChoc: new THREE.MeshBasicMaterial({ color: COLORS.capChoc }),
      capSelected: new THREE.MeshBasicMaterial({ color: COLORS.capSelected }),
      outline: new THREE.LineBasicMaterial({ color: COLORS.outline }),
      groupOutline: new THREE.LineDashedMaterial({
        color: COLORS.groupOutline,
        dashSize: 3,
        gapSize: 2,
      }),
      mirrorAxis: new THREE.LineDashedMaterial({
        color: COLORS.mirrorAxis,
        dashSize: 4,
        gapSize: 3,
      }),
      bezelLine: new THREE.LineBasicMaterial({ color: COLORS.bezel }),
      screwLine: new THREE.LineBasicMaterial({ color: COLORS.screw }),
      snapGuide: new THREE.LineBasicMaterial({ color: COLORS.snapGuide }),
      ghostCap: new THREE.MeshBasicMaterial({
        color: COLORS.ghost,
        transparent: true,
        opacity: 0.55,
      }),
      ghostBase: new THREE.MeshBasicMaterial({
        color: COLORS.base,
        transparent: true,
        opacity: 0.4,
      }),
    }

    interface KeyView {
      group: THREE.Group
      base: THREE.Mesh
      cap: THREE.Mesh
      outline: THREE.LineLoop
      sprite: THREE.Sprite | null
      key: Key
      selected: boolean
    }
    const views = new Map<string, KeyView>()

    const disposeSprite = (v: { sprite: THREE.Sprite | null; group: THREE.Group }) => {
      if (!v.sprite) return
      v.group.remove(v.sprite)
      ;(v.sprite.material.map as THREE.Texture)?.dispose()
      v.sprite.material.dispose()
      v.sprite = null
    }

    const updateView = (
      v: KeyView,
      key: Key,
      world: XForm,
      selected: boolean,
      force: boolean,
    ) => {
      if (force || v.key.type !== key.type || v.key.w !== key.w || v.key.h !== key.h) {
        const size = keySize(key)
        const cap = capSize(key)
        const r = baseRadius(size, cap)
        v.base.geometry = shapeGeo('base', size.w, size.h, r)
        v.cap.geometry = shapeGeo('cap', cap.w, cap.h, CAP_RADIUS)
        v.outline.geometry = outlineGeo(size.w, size.h, r)
      }
      if (force || v.key.label !== key.label) {
        disposeSprite(v)
        if (key.label) {
          const material = new THREE.SpriteMaterial({
            map: makeLabelTexture(key.label, COLORS.label),
            transparent: true,
            depthTest: false,
          })
          const sprite = new THREE.Sprite(material)
          sprite.scale.set(13, 6.5, 1)
          sprite.position.z = 0.6
          v.group.add(sprite)
          v.sprite = sprite
        }
      }
      v.group.position.set(world.x, world.y, 0)
      v.group.rotation.z = (world.r * Math.PI) / 180
      v.base.material = selected ? materials.baseSelected : materials.base
      v.cap.material = selected
        ? materials.capSelected
        : key.type === 'mx'
          ? materials.capMx
          : materials.capChoc
      v.outline.visible = selected
      v.key = key
      v.selected = selected
    }

    const createView = (key: Key, world: XForm, selected: boolean): KeyView => {
      const group = new THREE.Group()
      const base = new THREE.Mesh()
      const cap = new THREE.Mesh()
      cap.position.z = 0.2
      const outline = new THREE.LineLoop(undefined, materials.outline)
      outline.position.z = 0.4
      group.add(base, cap, outline)
      scene.add(group)
      const v: KeyView = { group, base, cap, outline, sprite: null, key, selected }
      updateView(v, key, world, selected, true)
      return v
    }

    // Mirrored ghost previews (non-interactive).
    interface GhostView {
      group: THREE.Group
      base: THREE.Mesh
      cap: THREE.Mesh
      key: Key
    }
    const ghosts = new Map<string, GhostView>()

    const updateGhost = (v: GhostView, key: Key, world: XForm, force: boolean) => {
      if (force || v.key.type !== key.type || v.key.w !== key.w || v.key.h !== key.h) {
        const size = keySize(key)
        const cap = capSize(key)
        v.base.geometry = shapeGeo('base', size.w, size.h, baseRadius(size, cap))
        v.cap.geometry = shapeGeo('cap', cap.w, cap.h, CAP_RADIUS)
      }
      v.group.position.set(world.x, world.y, -0.5)
      v.group.rotation.z = (world.r * Math.PI) / 180
      v.key = key
    }

    const createGhost = (key: Key, world: XForm): GhostView => {
      const group = new THREE.Group()
      const base = new THREE.Mesh(undefined, materials.ghostBase)
      const cap = new THREE.Mesh(undefined, materials.ghostCap)
      cap.position.z = 0.1
      group.add(base, cap)
      scene.add(group)
      const v: GhostView = { group, base, cap, key }
      updateGhost(v, key, world, true)
      return v
    }

    // Mirror axis line.
    const axisLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -2000, 0),
        new THREE.Vector3(0, 2000, 0),
      ]),
      materials.mirrorAxis,
    )
    axisLine.computeLineDistances()
    axisLine.position.z = -0.6
    scene.add(axisLine)

    // Alignment guides: shown while a drag is being pulled onto a neighbour's
    // edge/center or the mirror axis, so the snap is visible as it happens.
    const makeGuide = (a: THREE.Vector3, b: THREE.Vector3) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        materials.snapGuide,
      )
      line.position.z = 0.9
      line.visible = false
      scene.add(line)
      return line
    }
    const guideV = makeGuide(
      new THREE.Vector3(0, -5000, 0),
      new THREE.Vector3(0, 5000, 0),
    )
    const guideH = makeGuide(
      new THREE.Vector3(-5000, 0, 0),
      new THREE.Vector3(5000, 0, 0),
    )
    const setSnapGuides = (x: number | null, y: number | null) => {
      guideV.visible = x !== null
      if (x !== null) guideV.position.x = x
      guideH.visible = y !== null
      if (y !== null) guideH.position.y = y
    }

    // Bezel contours and the board-size badge, rebuilt only when the
    // geometry-relevant slices of the store change — sync() also fires for
    // selection changes, which don't affect either.
    let bezelLines: THREE.LineLoop[] = []
    // Screw markers share one unit-circle geometry, scaled per ring.
    const screwCircleGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 32 }, (_, i) => {
        const a = (i / 32) * Math.PI * 2
        return new THREE.Vector3(Math.cos(a), Math.sin(a), 0)
      }),
    )
    let screwLines: THREE.LineLoop[] = []
    let bezelDeps: Partial<
      Pick<
        ReturnType<typeof store.getState>,
        'keys' | 'groups' | 'mirror' | 'plate' | 'bezel' | 'bottom' | 'mounting'
      >
    > = {}
    const rebuildOutlines = (state: ReturnType<typeof store.getState>) => {
      if (
        state.keys === bezelDeps.keys &&
        state.groups === bezelDeps.groups &&
        state.mirror === bezelDeps.mirror &&
        state.plate === bezelDeps.plate &&
        state.bezel === bezelDeps.bezel &&
        state.bottom === bezelDeps.bottom &&
        state.mounting === bezelDeps.mounting
      )
        return
      bezelDeps = {
        keys: state.keys,
        groups: state.groups,
        mirror: state.mirror,
        plate: state.plate,
        bezel: state.bezel,
        bottom: state.bottom,
        mounting: state.mounting,
      }
      for (const line of bezelLines) {
        scene.remove(line)
        line.geometry.dispose()
      }
      bezelLines = []
      for (const line of screwLines) scene.remove(line)
      screwLines = []
      dims.style.display = 'none'
      try {
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
        const bezelMp = state.bezel.enabled ? bezelShape(doc) : []
        for (const poly of bezelMp) {
          for (const ring of poly) {
            const geo = new THREE.BufferGeometry().setFromPoints(
              ring.map(([x, y]) => new THREE.Vector3(x, y, 0)),
            )
            const line = new THREE.LineLoop(geo, materials.bezelLine)
            line.position.z = -0.45
            scene.add(line)
            bezelLines.push(line)
          }
        }
        // Screws: the lid's clearance hole ringed by the head's footprint,
        // so it reads at a glance whether a head clears the parts around it.
        if (state.bottom.enabled) {
          for (const [x, y] of screwPositions(doc)) {
            for (const r of [SCREW.lidHoleR, SCREW.headR]) {
              const line = new THREE.LineLoop(screwCircleGeo, materials.screwLine)
              line.position.set(x, y, -0.4)
              line.scale.set(r, r, 1)
              scene.add(line)
              screwLines.push(line)
            }
          }
        }

        // Overall board footprint: plate and bezel outer edges combined.
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        const track = (mp: MultiPolygon) => {
          for (const poly of mp) {
            for (const [x, y] of poly[0]) {
              minX = Math.min(minX, x)
              minY = Math.min(minY, y)
              maxX = Math.max(maxX, x)
              maxY = Math.max(maxY, y)
            }
          }
        }
        track(plateOutline(doc))
        track(bezelMp)
        if (minX < maxX) {
          dims.textContent = `${(maxX - minX).toFixed(1)} × ${(maxY - minY).toFixed(1)} mm`
          dims.style.display = 'block'
        }
      } catch (error) {
        console.warn('keebforge: outline generation failed', error)
      }
    }

    // Outline generation runs polygon offsetting — too heavy for every drag
    // frame. Throttle to trailing updates; single edits still feel instant.
    let outlineTimer: ReturnType<typeof setTimeout> | undefined
    let outlineLastRun = 0
    const scheduleOutlines = () => {
      const wait = Math.max(0, 150 - (performance.now() - outlineLastRun))
      clearTimeout(outlineTimer)
      outlineTimer = setTimeout(() => {
        outlineLastRun = performance.now()
        rebuildOutlines(store.getState())
        invalidate()
      }, wait)
    }

    // Dashed outline around a fully-selected group.
    let groupBox: THREE.LineLoop | null = null
    const clearGroupBox = () => {
      if (groupBox) {
        scene.remove(groupBox)
        groupBox.geometry.dispose()
        groupBox = null
      }
    }

    // ---- On-canvas gizmos -------------------------------------------------
    // HTML overlay handles: a rotation handle for the selection, and — when
    // a whole column cluster is selected — per-column stagger/splay drag
    // handles plus add/remove column buttons.

    // Half of .gizmo-handle's 12px box — how far a handle reaches past the
    // point it is placed at.
    const HANDLE_RADIUS_PX = 6

    let gizmoSig = ''
    let gizmoPlacers: (() => void)[] = []
    let gizmoDragging = false
    let gestureSeq = 0

    const placeEl = (el: HTMLElement, wx: number, wy: number, dyPx = 0, dxPx = 0) => {
      const p = mmToPx(wx, wy)
      el.style.left = `${p.x + dxPx}px`
      el.style.top = `${p.y + dyPx}px`
    }

    // Floating readout for the value being manipulated.
    const dragBadge = document.createElement('div')
    dragBadge.className = 'drag-badge'
    wrap.appendChild(dragBadge)
    const showDragBadge = (ev: PointerEvent, text: string) => {
      const rect = canvas.getBoundingClientRect()
      dragBadge.style.display = 'block'
      dragBadge.style.left = `${ev.clientX - rect.left + 14}px`
      dragBadge.style.top = `${ev.clientY - rect.top + 14}px`
      dragBadge.textContent = text
    }
    const hideDragBadge = () => {
      dragBadge.style.display = 'none'
    }

    /** Shift-click resets a handle's value; anything else starts its drag. */
    const shiftResettable =
      (reset: () => void, start: (e: PointerEvent) => void) => (e: PointerEvent) => {
        if (e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          reset()
          return
        }
        start(e)
      }

    const rotationIsZero = () => {
      const state = store.getState()
      const whole = wholeSelectedGroup(state)
      if (whole) return whole.r === 0
      return state.keys.every((k) => !state.selection.has(k.id) || k.r === 0)
    }

    const resetRotation = () => {
      const state = store.getState()
      const whole = wholeSelectedGroup(state)
      if (whole) state.updateGroup(whole.id, { r: 0 })
      else state.updateSelected({ r: 0 })
    }

    const makeHandle = (cls: string, title: string): HTMLDivElement => {
      const el = document.createElement('div')
      el.className = `gizmo-handle ${cls}`
      el.title = title
      gizmoLayer.appendChild(el)
      return el
    }

    const selectionBounds = () => {
      const state = store.getState()
      const groups = groupMap(state.groups)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const key of state.keys) {
        if (!state.selection.has(key.id)) continue
        const w = keyWorldXF(key, groups)
        const size = keySize(key)
        const rad = (w.r * Math.PI) / 180
        const ex = (Math.abs(Math.cos(rad)) * size.w + Math.abs(Math.sin(rad)) * size.h) / 2
        const ey = (Math.abs(Math.sin(rad)) * size.w + Math.abs(Math.cos(rad)) * size.h) / 2
        minX = Math.min(minX, w.x - ex)
        maxX = Math.max(maxX, w.x + ex)
        minY = Math.min(minY, w.y - ey)
        maxY = Math.max(maxY, w.y + ey)
      }
      return minX < maxX ? { minX, maxX, minY, maxY } : null
    }

    /** Live geometry of one cluster column: its top/bottom key transforms. */
    const columnInfo = (groupId: string, col: number) => {
      const state = store.getState()
      const g = state.groups.find((g) => g.id === groupId)
      if (!g || g.layout.kind !== 'columns') return null
      const groups = groupMap(state.groups)
      const members = state.keys.filter((k) => k.groupId === groupId && k.col === col)
      if (members.length === 0) return null
      const top = members.reduce((a, b) => ((a.row ?? 0) < (b.row ?? 0) ? a : b))
      const bottom = members.reduce((a, b) => ((a.row ?? 0) > (b.row ?? 0) ? a : b))
      const spec = SPEC[g.layout.keyType]
      return {
        layout: g.layout,
        wTop: keyWorldXF(top, groups),
        wBot: keyWorldXF(bottom, groups),
        pitchX: spec.pitchX,
        pitchY: spec.pitchY,
      }
    }

    /** World positions of a column's two handles: splay above the top key,
     * stagger below the bottom one. Shared so the size bar can dodge them. */
    const columnHandlePoints = (groupId: string, col: number) => {
      const info = columnInfo(groupId, col)
      if (!info) return null
      const rad = (info.wTop.r * Math.PI) / 180
      const up = { x: -Math.sin(rad), y: Math.cos(rad) }
      const off = info.pitchY * 0.85
      return {
        info,
        splay: { x: info.wTop.x + up.x * off, y: info.wTop.y + up.y * off },
        stagger: { x: info.wBot.x - up.x * off, y: info.wBot.y - up.y * off },
      }
    }

    const patchColumn = (
      gestureKey: string,
      groupId: string,
      col: number,
      patch: { stagger?: number; splay?: number },
    ) => {
      const state = store.getState()
      const g = state.groups.find((g) => g.id === groupId)
      if (!g || g.layout.kind !== 'columns') return
      const layout = g.layout
      coalesceUndo(gestureKey, () =>
        state.updateGroupLayout(groupId, {
          ...layout,
          columns: layout.columns.map((cd, i) => (i === col ? { ...cd, ...patch } : cd)),
        }),
      )
    }

    const dragHandle = (
      e: PointerEvent,
      onMove: (ev: PointerEvent) => void,
      onEnd?: () => void,
    ) => {
      e.preventDefault()
      e.stopPropagation()
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      gizmoDragging = true
      const move = (ev: PointerEvent) => onMove(ev)
      const up = () => {
        gizmoDragging = false
        hideDragBadge()
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        onEnd?.()
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    }

    const startRotateDrag = (e: PointerEvent) => {
      const state = store.getState()
      const groups = groupMap(state.groups)
      const b = selectionBounds()
      if (!b) return
      const pivot = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
      const startPt = toMM(e.clientX, e.clientY)
      const a0 = Math.atan2(startPt.y - pivot.y, startPt.x - pivot.x)
      const whole = wholeSelectedGroup(state)
      const groupOrig = whole ? { x: whole.x, y: whole.y, r: whole.r } : null
      const keysOrig = whole
        ? []
        : state.keys
            .filter((k) => state.selection.has(k.id))
            .map((k) => ({
              id: k.id,
              r: k.r,
              frame: groupWorldXF(groups, k.groupId),
              world: keyWorldXF(k, groups),
            }))
      state.beginTransform()
      dragHandle(
        e,
        (ev) => {
          const pt = toMM(ev.clientX, ev.clientY)
          let deg =
            ((Math.atan2(pt.y - pivot.y, pt.x - pivot.x) - a0) * 180) / Math.PI
          deg = ev.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg)
          showDragBadge(ev, `${deg}°`)
          const rad = (deg * Math.PI) / 180
          const cos = Math.cos(rad)
          const sin = Math.sin(rad)
          const spin = (x: number, y: number) => ({
            x: pivot.x + (x - pivot.x) * cos - (y - pivot.y) * sin,
            y: pivot.y + (x - pivot.x) * sin + (y - pivot.y) * cos,
          })
          const patches: TransformPatches = { keys: new Map(), groups: new Map() }
          if (whole && groupOrig) {
            patches.groups!.set(whole.id, {
              ...spin(groupOrig.x, groupOrig.y),
              r: Math.round((groupOrig.r + deg) * 100) / 100,
            })
          } else {
            for (const o of keysOrig) {
              const w = spin(o.world.x, o.world.y)
              const local = worldToLocal(o.frame, w.x, w.y)
              patches.keys!.set(o.id, {
                x: local.x,
                y: local.y,
                r: Math.round((o.r + deg) * 100) / 100,
              })
            }
          }
          store.getState().transform(patches)
        },
        () => store.getState().endTransform(),
      )
    }

    const startStaggerDrag = (e: PointerEvent, groupId: string, col: number) => {
      const info = columnInfo(groupId, col)
      if (!info) return
      const start = toMM(e.clientX, e.clientY)
      const startStagger = info.layout.columns[col].stagger
      const rad = (info.wTop.r * Math.PI) / 180
      const up = { x: -Math.sin(rad), y: Math.cos(rad) }
      // Magnetic values: the other columns' staggers (and 0), so neighbours
      // line up without fiddling.
      const magnets = [
        0,
        ...info.layout.columns.filter((_, i) => i !== col).map((c) => c.stagger),
      ]
      const gkey = `gizmo${++gestureSeq}`
      let last = startStagger
      dragHandle(e, (ev) => {
        const pt = toMM(ev.clientX, ev.clientY)
        const d = (pt.x - start.x) * up.x + (pt.y - start.y) * up.y
        const step = ev.ctrlKey || ev.metaKey ? 1 : 0.1
        let stagger = Math.round((startStagger + d) / step) * step
        stagger = Math.round(stagger * 10) / 10
        const threshold = 6 / view.zoom
        let best = threshold
        for (const m of magnets) {
          const dist = Math.abs(stagger - m)
          if (dist < best) {
            best = dist
            stagger = m
          }
        }
        showDragBadge(ev, `${stagger.toFixed(1)} mm`)
        if (stagger === last) return
        last = stagger
        patchColumn(gkey, groupId, col, { stagger })
      })
    }

    const startSplayDrag = (e: PointerEvent, groupId: string, col: number) => {
      const info = columnInfo(groupId, col)
      if (!info) return
      const startSplay = info.layout.columns[col].splay
      const startX = e.clientX
      const gkey = `gizmo${++gestureSeq}`
      let last = startSplay
      dragHandle(e, (ev) => {
        // Handle sits above the splay pivot: dragging it right rotates the
        // column clockwise = negative splay, matching the pointer.
        const step = ev.ctrlKey || ev.metaKey ? 1 : 0.5
        const splay =
          Math.round((startSplay - (ev.clientX - startX) * 0.2) / step) * step
        showDragBadge(ev, `${splay}°`)
        if (splay === last) return
        last = splay
        patchColumn(gkey, groupId, col, { splay })
      })
    }

    const setColumnCount = (groupId: string, delta: number) => {
      const state = store.getState()
      const g = state.groups.find((g) => g.id === groupId)
      if (!g || g.layout.kind !== 'columns') return
      const layout = g.layout
      const n = layout.columns.length + delta
      if (n < 1 || n > 12) return
      const columns =
        delta > 0
          ? [...layout.columns, { ...(layout.columns.at(-1) ?? { stagger: 0, splay: 0 }) }]
          : layout.columns.slice(0, -1)
      state.updateGroupLayout(groupId, { ...layout, columns })
      // Keep the whole cluster selected so the gizmos stay up.
      const after = store.getState()
      after.setSelection(memberKeyIds(groupId, after.keys, after.groups))
    }

    const setRowCount = (groupId: string, delta: number) => {
      const state = store.getState()
      const g = state.groups.find((g) => g.id === groupId)
      if (!g || g.layout.kind !== 'columns') return
      const rows = g.layout.rows + delta
      if (rows < 1 || rows > 8) return
      state.updateGroupLayout(groupId, { ...g.layout, rows })
      const after = store.getState()
      after.setSelection(memberKeyIds(groupId, after.keys, after.groups))
    }

    const startCurveDrag = (e: PointerEvent, groupId: string) => {
      const state = store.getState()
      const g = state.groups.find((g) => g.id === groupId)
      if (!g || g.layout.kind !== 'stack') return
      const startCurve = g.layout.curve ?? 0
      const startX = e.clientX
      const gkey = `gizmo${++gestureSeq}`
      let last = startCurve
      dragHandle(e, (ev) => {
        const step = ev.ctrlKey || ev.metaKey ? 1 : 0.5
        const curve =
          Math.round((startCurve + (ev.clientX - startX) * 0.1) / step) * step
        showDragBadge(ev, `${curve}°/key`)
        if (curve === last) return
        last = curve
        const st = store.getState()
        const layout = st.groups.find((g) => g.id === groupId)?.layout
        if (!layout || layout.kind !== 'stack') return
        coalesceUndo(gkey, () => st.updateGroupLayout(groupId, { ...layout, curve }))
      })
    }

    const buildGizmos = (
      clusterId: string | null,
      columnCount: number,
      stackId: string | null,
    ) => {
      const rot = makeHandle(
        'gizmo-rotate',
        'Drag to rotate the selection (Shift while dragging: 15° steps; Shift-click: reset to 0°)',
      )
      rot.addEventListener('pointerdown', shiftResettable(resetRotation, startRotateDrag))
      const rotReset = makeHandle('gizmo-colbtn', 'Reset rotation to 0°')
      rotReset.textContent = '↺'
      rotReset.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      rotReset.addEventListener('click', resetRotation)
      gizmoPlacers.push(() => {
        const b = selectionBounds()
        rot.style.display = b ? '' : 'none'
        rotReset.style.display = b ? '' : 'none'
        if (!b) return
        placeEl(rot, (b.minX + b.maxX) / 2, b.maxY, -26)
        placeEl(rotReset, (b.minX + b.maxX) / 2, b.maxY, -26, 26)
        const zero = rotationIsZero()
        rot.classList.toggle('at-default', zero)
        rotReset.classList.toggle('at-default', zero)
      })

      // Quick key-width buttons under the selection.
      const sizeBar = document.createElement('div')
      sizeBar.className = 'gizmo-sizebar'
      gizmoLayer.appendChild(sizeBar)
      const sizeButtons: [HTMLButtonElement, number][] = []
      for (const v of [1, 1.25, 1.5, 2]) {
        const b = document.createElement('button')
        b.textContent = String(v)
        b.title = `Set key width to ${v}u`
        b.addEventListener('pointerdown', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        })
        b.addEventListener('click', () => store.getState().updateSelected({ w: v }))
        sizeBar.appendChild(b)
        sizeButtons.push([b, v])
      }
      if (clusterId) {
        const rc = document.createElement('button')
        rc.textContent = 'Reset'
        rc.title = 'Zero every column’s stagger and splay in this cluster'
        rc.addEventListener('pointerdown', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        })
        rc.addEventListener('click', () => {
          const st = store.getState()
          const layout = st.groups.find((g) => g.id === clusterId)?.layout
          if (layout && layout.kind === 'columns') {
            st.updateGroupLayout(clusterId, {
              ...layout,
              columns: layout.columns.map(() => ({ stagger: 0, splay: 0 })),
            })
          }
        })
        sizeBar.appendChild(rc)
      }
      gizmoPlacers.push(() => {
        const b = selectionBounds()
        sizeBar.style.display = b ? '' : 'none'
        if (!b) return
        const p = mmToPx((b.minX + b.maxX) / 2, b.minY)
        // Stagger handles hang below the cluster's bottom row, so clear the
        // lowest of them rather than the selection bounds alone.
        let lowest = p.y
        if (clusterId) {
          for (let col = 0; col < columnCount; col++) {
            const pts = columnHandlePoints(clusterId, col)
            if (!pts) continue
            lowest = Math.max(lowest, mmToPx(pts.stagger.x, pts.stagger.y).y + HANDLE_RADIUS_PX)
          }
        }
        sizeBar.style.left = `${p.x}px`
        sizeBar.style.top = `${lowest + 24}px`
        const st = store.getState()
        const widths = new Set(
          st.keys.filter((k) => st.selection.has(k.id)).map((k) => k.w),
        )
        const common = widths.size === 1 ? [...widths][0] : null
        for (const [btn, v] of sizeButtons) btn.classList.toggle('active', common === v)
      })

      if (stackId) {
        const curve = makeHandle(
          'gizmo-splay',
          'Drag sideways to curve the stack (°/key); Shift-click: reset',
        )
        curve.addEventListener(
          'pointerdown',
          shiftResettable(
            () => {
              const st = store.getState()
              const layout = st.groups.find((g) => g.id === stackId)?.layout
              if (layout && layout.kind === 'stack') {
                st.updateGroupLayout(stackId, { ...layout, curve: 0 })
              }
            },
            (e) => startCurveDrag(e, stackId),
          ),
        )
        gizmoPlacers.push(() => {
          const st = store.getState()
          const g = st.groups.find((g) => g.id === stackId)
          const b = selectionBounds()
          const show = b && g && g.layout.kind === 'stack'
          curve.style.display = show ? '' : 'none'
          if (!show || !b || !g || g.layout.kind !== 'stack') return
          if (g.layout.axis === 'x') {
            placeEl(curve, b.maxX + 4, (b.minY + b.maxY) / 2, 0, 10)
          } else {
            placeEl(curve, (b.minX + b.maxX) / 2, b.minY - 4, 10)
          }
          curve.classList.toggle('at-default', (g.layout.curve ?? 0) === 0)
        })
      }

      if (!clusterId) return
      for (let col = 0; col < columnCount; col++) {
        const stag = makeHandle(
          'gizmo-stagger',
          'Drag to adjust this column’s stagger; Shift-click: reset',
        )
        const splay = makeHandle(
          'gizmo-splay',
          'Drag sideways to splay this column; Shift-click: reset',
        )
        stag.addEventListener(
          'pointerdown',
          shiftResettable(
            () => patchColumn(`gizmo${++gestureSeq}`, clusterId, col, { stagger: 0 }),
            (e) => startStaggerDrag(e, clusterId, col),
          ),
        )
        splay.addEventListener(
          'pointerdown',
          shiftResettable(
            () => patchColumn(`gizmo${++gestureSeq}`, clusterId, col, { splay: 0 }),
            (e) => startSplayDrag(e, clusterId, col),
          ),
        )
        gizmoPlacers.push(() => {
          const pts = columnHandlePoints(clusterId, col)
          const info = pts?.info ?? null
          stag.style.display = info ? '' : 'none'
          splay.style.display = info ? '' : 'none'
          if (!pts || !info) return
          placeEl(splay, pts.splay.x, pts.splay.y)
          placeEl(stag, pts.stagger.x, pts.stagger.y)
          stag.classList.toggle('at-default', info.layout.columns[col].stagger === 0)
          splay.classList.toggle('at-default', info.layout.columns[col].splay === 0)
        })
      }
      const add = makeHandle('gizmo-colbtn', 'Add a column')
      add.textContent = '+'
      const rem = makeHandle('gizmo-colbtn', 'Remove the last column')
      rem.textContent = '−'
      for (const [el, delta] of [
        [add, 1],
        [rem, -1],
      ] as const) {
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
        })
        el.addEventListener('click', () => setColumnCount(clusterId, delta))
      }
      gizmoPlacers.push(() => {
        const state = store.getState()
        const g = state.groups.find((g) => g.id === clusterId)
        const info =
          g && g.layout.kind === 'columns'
            ? columnInfo(clusterId, g.layout.columns.length - 1)
            : null
        add.style.display = info ? '' : 'none'
        rem.style.display = info ? '' : 'none'
        if (!info) return
        const rad = (info.wTop.r * Math.PI) / 180
        const wx = info.wTop.x + Math.cos(rad) * info.pitchX * 1.05
        const wy = info.wTop.y + Math.sin(rad) * info.pitchX * 1.05
        placeEl(add, wx, wy, -11)
        placeEl(rem, wx, wy, 11)
      })
      const addRow = makeHandle('gizmo-colbtn', 'Add a row')
      addRow.textContent = '+'
      const remRow = makeHandle('gizmo-colbtn', 'Remove the last row')
      remRow.textContent = '−'
      for (const [el, delta] of [
        [addRow, 1],
        [remRow, -1],
      ] as const) {
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
        })
        el.addEventListener('click', () => setRowCount(clusterId, delta))
      }
      gizmoPlacers.push(() => {
        const info = columnInfo(clusterId, 0)
        addRow.style.display = info ? '' : 'none'
        remRow.style.display = info ? '' : 'none'
        if (!info) return
        const rad = (info.wBot.r * Math.PI) / 180
        const wx = info.wBot.x - Math.cos(rad) * info.pitchX * 1.05
        const wy = info.wBot.y - Math.sin(rad) * info.pitchX * 1.05
        placeEl(addRow, wx, wy, 11)
        placeEl(remRow, wx, wy, -11)
      })
    }

    /** World AABB of all keycaps, mirrored half included — cheap anchor for
     * the margin handles (the real outline recomputes throttled). */
    const capBounds = (unmirroredOnly = false) => {
      const state = store.getState()
      const groups = groupMap(state.groups)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      const note = (w: XForm, key: Key) => {
        const cap = capSize(key)
        const rad = (w.r * Math.PI) / 180
        const ex = (Math.abs(Math.cos(rad)) * cap.w + Math.abs(Math.sin(rad)) * cap.h) / 2
        const ey = (Math.abs(Math.sin(rad)) * cap.w + Math.abs(Math.cos(rad)) * cap.h) / 2
        minX = Math.min(minX, w.x - ex)
        maxX = Math.max(maxX, w.x + ex)
        minY = Math.min(minY, w.y - ey)
        maxY = Math.max(maxY, w.y + ey)
      }
      for (const key of state.keys) {
        const w = keyWorldXF(key, groups)
        note(w, key)
        if (!unmirroredOnly && state.mirror.enabled && isKeyMirrored(key, groups)) {
          note(mirrorXF(w, state.mirror.axis), key)
        }
      }
      return minX < maxX ? { minX, maxX, minY, maxY } : null
    }

    type MarginSide = 'top' | 'bottom' | 'left' | 'right'
    const MARGIN_FIELD: Record<MarginSide, 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight'> = {
      top: 'marginTop',
      bottom: 'marginBottom',
      left: 'marginLeft',
      right: 'marginRight',
    }

    const startMarginDrag = (e: PointerEvent, side: MarginSide) => {
      const start = toMM(e.clientX, e.clientY)
      const startVal = store.getState().bezel[MARGIN_FIELD[side]] ?? 0
      const gkey = `gizmo${++gestureSeq}`
      let last = startVal
      dragHandle(e, (ev) => {
        const pt = toMM(ev.clientX, ev.clientY)
        const d =
          side === 'top'
            ? pt.y - start.y
            : side === 'bottom'
              ? start.y - pt.y
              : side === 'left'
                ? start.x - pt.x
                : pt.x - start.x
        const step = ev.ctrlKey || ev.metaKey ? 1 : 0.5
        const val = Math.max(0, Math.round((startVal + d) / step) * step)
        showDragBadge(ev, `${val} mm`)
        if (val === last) return
        last = val
        const state = store.getState()
        const patch =
          (side === 'left' || side === 'right') && state.mirror.enabled
            ? { marginLeft: val, marginRight: val }
            : { [MARGIN_FIELD[side]]: val }
        coalesceUndo(gkey, () => state.setBezel(patch))
      })
    }

    const buildMarginHandles = () => {
      const defs: { side: MarginSide; cls: string }[] = [
        { side: 'top', cls: 'gizmo-margin-v' },
        { side: 'bottom', cls: 'gizmo-margin-v' },
        { side: 'left', cls: 'gizmo-margin-h' },
        { side: 'right', cls: 'gizmo-margin-h' },
      ]
      for (const { side, cls } of defs) {
        const el = makeHandle(
          cls,
          `Drag to adjust the ${side} case margin; Shift-click: reset`,
        )
        el.addEventListener(
          'pointerdown',
          shiftResettable(
            () => {
              const st = store.getState()
              const patch =
                (side === 'left' || side === 'right') && st.mirror.enabled
                  ? { marginLeft: 0, marginRight: 0 }
                  : { [MARGIN_FIELD[side]]: 0 }
              st.setBezel(patch)
            },
            (e) => startMarginDrag(e, side),
          ),
        )
        gizmoPlacers.push(() => {
          const state = store.getState()
          const b = capBounds()
          const show = state.bezel.enabled && b
          el.style.display = show ? '' : 'none'
          if (!show || !b) return
          const bz = state.bezel
          const pad = bz.outset + bz.width
          // On a split case, top/bottom handles center on the left half
          // instead of hovering over the seam.
          const split = state.mirror.enabled && state.mirror.split === true
          const hb = (split && capBounds(true)) || b
          const cx = (hb.minX + hb.maxX) / 2
          const cy = (b.minY + b.maxY) / 2
          if (side === 'top') placeEl(el, cx, hb.maxY + pad + (bz.marginTop ?? 0))
          else if (side === 'bottom') placeEl(el, cx, hb.minY - pad - (bz.marginBottom ?? 0))
          else if (side === 'left') placeEl(el, b.minX - pad - (bz.marginLeft ?? 0), cy)
          else placeEl(el, b.maxX + pad + (bz.marginRight ?? 0), cy)
          el.classList.toggle('at-default', (bz[MARGIN_FIELD[side]] ?? 0) === 0)
        })
      }
    }

    const positionGizmos = () => {
      for (const place of gizmoPlacers) place()
    }
    positionGizmosHook = positionGizmos

    const rebuildGizmos = () => {
      const state = store.getState()
      if (gizmoDragging) {
        positionGizmos()
        return
      }
      const whole = wholeSelectedGroup(state)
      const cluster = whole && whole.layout.kind === 'columns' ? whole : null
      const stack = whole && whole.layout.kind === 'stack' ? whole : null
      const sig =
        [...state.selection].sort().join(',') +
        '|' +
        (cluster && cluster.layout.kind === 'columns'
          ? `${cluster.id}:${cluster.layout.columns.length}`
          : '') +
        '|' +
        (stack ? `${stack.id}:stack` : '') +
        '|' +
        state.bezel.enabled
      if (sig !== gizmoSig) {
        gizmoSig = sig
        gizmoLayer.replaceChildren()
        gizmoPlacers = []
        if (state.selection.size > 0) {
          buildGizmos(
            cluster?.id ?? null,
            cluster && cluster.layout.kind === 'columns'
              ? cluster.layout.columns.length
              : 0,
            stack?.id ?? null,
          )
        }
        if (state.bezel.enabled) buildMarginHandles()
      }
      positionGizmos()
    }

    const sync = () => {
      const state = store.getState()
      const groups = groupMap(state.groups)
      const alive = new Set(state.keys.map((k) => k.id))

      for (const [id, v] of views) {
        if (!alive.has(id)) {
          scene.remove(v.group)
          disposeSprite(v)
          views.delete(id)
        }
      }
      const mirrored = new Set(
        state.mirror.enabled
          ? state.keys.filter((k) => isKeyMirrored(k, groups)).map((k) => k.id)
          : [],
      )
      for (const [id, v] of ghosts) {
        if (!mirrored.has(id)) {
          scene.remove(v.group)
          ghosts.delete(id)
        }
      }

      for (const key of state.keys) {
        const world = keyWorldXF(key, groups)
        const selected = state.selection.has(key.id)
        const v = views.get(key.id)
        if (!v) views.set(key.id, createView(key, world, selected))
        else updateView(v, key, world, selected, false)

        if (mirrored.has(key.id)) {
          const mw = mirrorXF(world, state.mirror.axis)
          const g = ghosts.get(key.id)
          if (!g) ghosts.set(key.id, createGhost(key, mw))
          else updateGhost(g, key, mw, false)
        }
      }

      axisLine.visible = state.mirror.enabled
      axisLine.position.x = state.mirror.axis

      scheduleOutlines()

      clearGroupBox()
      const whole = wholeSelectedGroup(state)
      if (whole) {
        // Bounds in the group's own frame, so the box rotates with the group.
        const frame = groupWorldXF(groups, whole.id)
        const members = new Set(memberKeyIds(whole.id, state.keys, state.groups))
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const key of state.keys) {
          if (!members.has(key.id)) continue
          const w = keyWorldXF(key, groups)
          const local = worldToLocal(frame, w.x, w.y)
          const size = keySize(key)
          const rel = ((w.r - frame.r) * Math.PI) / 180
          const ex = (Math.abs(Math.cos(rel)) * size.w + Math.abs(Math.sin(rel)) * size.h) / 2
          const ey = (Math.abs(Math.sin(rel)) * size.w + Math.abs(Math.cos(rel)) * size.h) / 2
          minX = Math.min(minX, local.x - ex)
          maxX = Math.max(maxX, local.x + ex)
          minY = Math.min(minY, local.y - ey)
          maxY = Math.max(maxY, local.y + ey)
        }
        if (minX < maxX) {
          const pad = 3
          const rad = (frame.r * Math.PI) / 180
          const cos = Math.cos(rad)
          const sin = Math.sin(rad)
          const corner = (lx: number, ly: number) =>
            new THREE.Vector3(
              frame.x + lx * cos - ly * sin,
              frame.y + lx * sin + ly * cos,
              0,
            )
          const geo = new THREE.BufferGeometry().setFromPoints([
            corner(minX - pad, minY - pad),
            corner(maxX + pad, minY - pad),
            corner(maxX + pad, maxY + pad),
            corner(minX - pad, maxY + pad),
          ])
          groupBox = new THREE.LineLoop(geo, materials.groupOutline)
          groupBox.computeLineDistances()
          groupBox.position.z = 0.5
          scene.add(groupBox)
        }
      }

      rebuildGizmos()
      invalidate()
    }

    // ---- Interaction ------------------------------------------------------

    interface DragUnit {
      groupsOrig: Map<string, { x: number; y: number }>
      keysOrig: Map<string, { x: number; y: number; frameR: number }>
      primaryWorld: { x: number; y: number }
      /** Half of the primary keycap's world-x extent, for mirror-axis snap. */
      primaryHalfW: number
      /** Selection bounds at drag start plus stationary-neighbour edge and
       * center coordinates, for magnetic snapping. */
      bounds0: { minX: number; maxX: number; minY: number; maxY: number } | null
      snapX: number[]
      snapY: number[]
      start: { x: number; y: number }
    }
    type Mode =
      | { kind: 'idle' }
      | { kind: 'pan'; lastX: number; lastY: number }
      | ({ kind: 'drag' } & DragUnit)
      | { kind: 'band'; startX: number; startY: number; shift: boolean }
    let mode: Mode = { kind: 'idle' }
    let spaceHeld = false

    const snap = (v: number) => {
      const step = store.getState().snapStep
      return step > 0 ? Math.round(v / step) * step : v
    }

    const pickKey = (x: number, y: number): Key | null => {
      const state = store.getState()
      const groups = groupMap(state.groups)
      for (let i = state.keys.length - 1; i >= 0; i--) {
        const key = state.keys[i]
        if (hitTest(key, keyWorldXF(key, groups), x, y)) return key
      }
      return null
    }

    const setCursor = () => {
      canvas.style.cursor =
        mode.kind === 'pan' ? 'grabbing' : spaceHeld ? 'grab' : 'default'
    }

    /** Build drag units from the current selection: fully-selected top-level
     * groups move as rigid bodies, remaining keys move within their frames. */
    const beginDrag = (primary: Key, start: { x: number; y: number }) => {
      const state = store.getState()
      const groups = groupMap(state.groups)
      const groupsOrig = new Map<string, { x: number; y: number }>()
      const keysOrig = new Map<string, { x: number; y: number; frameR: number }>()
      for (const key of state.keys) {
        if (!state.selection.has(key.id)) continue
        const top = topGroupOf(key, groups)
        if (top && !groupsOrig.has(top.id)) {
          const members = memberKeyIds(top.id, state.keys, state.groups)
          if (members.every((id) => state.selection.has(id))) {
            groupsOrig.set(top.id, { x: top.x, y: top.y })
            continue
          }
        }
        if (top && groupsOrig.has(top.id)) continue
        const frame = keyWorldXF(key, groups)
        keysOrig.set(key.id, { x: key.x, y: key.y, frameR: frame.r - key.r })
      }
      const primaryWorld = keyWorldXF(primary, groups)
      const cap = capSize(primary)
      const rad = (primaryWorld.r * Math.PI) / 180
      const primaryHalfW =
        (cap.w * Math.abs(Math.cos(rad)) + cap.h * Math.abs(Math.sin(rad))) / 2
      // Stationary neighbours' pitch-area edges and centers, snapped against
      // the dragged selection's bounds.
      const snapX: number[] = []
      const snapY: number[] = []
      for (const k of state.keys) {
        if (state.selection.has(k.id)) continue
        const w = keyWorldXF(k, groups)
        const size = keySize(k)
        const kr = (w.r * Math.PI) / 180
        const ex = (Math.abs(Math.cos(kr)) * size.w + Math.abs(Math.sin(kr)) * size.h) / 2
        const ey = (Math.abs(Math.sin(kr)) * size.w + Math.abs(Math.cos(kr)) * size.h) / 2
        snapX.push(w.x - ex, w.x + ex, w.x)
        snapY.push(w.y - ey, w.y + ey, w.y)
      }
      store.getState().beginTransform()
      mode = {
        kind: 'drag',
        groupsOrig,
        keysOrig,
        primaryWorld,
        primaryHalfW,
        bounds0: selectionBounds(),
        snapX,
        snapY,
        start,
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld)) {
        mode = { kind: 'pan', lastX: e.clientX, lastY: e.clientY }
        setCursor()
        return
      }
      if (e.button !== 0) return
      const pt = toMM(e.clientX, e.clientY)
      const hit = pickKey(pt.x, pt.y)
      if (!hit) {
        const rect = canvas.getBoundingClientRect()
        mode = {
          kind: 'band',
          startX: e.clientX - rect.left,
          startY: e.clientY - rect.top,
          shift: e.shiftKey,
        }
        return
      }
      const state = store.getState()
      const groups = groupMap(state.groups)
      // Ctrl-drag: duplicate the selection in place and drag the clones.
      if (e.ctrlKey || e.metaKey) {
        const top = e.altKey ? null : topGroupOf(hit, groups)
        if (e.altKey) state.setSelection([hit.id])
        else if (top) {
          const members = memberKeyIds(top.id, state.keys, state.groups)
          if (!members.every((id) => state.selection.has(id))) {
            state.setSelection(members)
          }
        } else if (!state.selection.has(hit.id)) {
          state.setSelection([hit.id])
        }
        store.getState().duplicateSelection(0, 0)
        const st = store.getState()
        const cloneGroups = groupMap(st.groups)
        const hw = keyWorldXF(hit, groups)
        let primary: Key | null = null
        for (const k of st.keys) {
          if (!st.selection.has(k.id)) continue
          const w = keyWorldXF(k, cloneGroups)
          if (Math.abs(w.x - hw.x) < 0.01 && Math.abs(w.y - hw.y) < 0.01) {
            primary = k
            break
          }
        }
        primary ??= st.keys.find((k) => st.selection.has(k.id)) ?? null
        if (primary) beginDrag(primary, pt)
        return
      }
      const top = e.altKey ? null : topGroupOf(hit, groups)
      if (e.altKey) {
        // Alt: isolate the individual key even inside a group.
        state.setSelection([hit.id])
        beginDrag(hit, pt)
        return
      }
      if (top) {
        const members = memberKeyIds(top.id, state.keys, state.groups)
        if (e.shiftKey) {
          if (members.every((id) => state.selection.has(id))) {
            state.removeFromSelection(members)
          } else {
            state.addToSelection(members)
          }
          return
        }
        if (!members.every((id) => state.selection.has(id))) {
          state.setSelection(members)
        }
        beginDrag(hit, pt)
      } else {
        if (e.shiftKey) {
          state.toggleSelected(hit.id)
          return
        }
        if (!state.selection.has(hit.id)) state.setSelection([hit.id])
        beginDrag(hit, pt)
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (mode.kind === 'pan') {
        view.cx -= (e.clientX - mode.lastX) / view.zoom
        view.cy += (e.clientY - mode.lastY) / view.zoom
        mode.lastX = e.clientX
        mode.lastY = e.clientY
        applyCamera()
      } else if (mode.kind === 'drag') {
        const pt = toMM(e.clientX, e.clientY)
        let dx = pt.x - mode.start.x
        let dy = pt.y - mode.start.y
        // Shift constrains the drag to the dominant axis.
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0
          else dx = 0
        }
        // Snap the primary key's resulting world position, move the rest rigidly.
        dx = snap(mode.primaryWorld.x + dx) - mode.primaryWorld.x
        dy = snap(mode.primaryWorld.y + dy) - mode.primaryWorld.y
        // Magnetic snap against stationary neighbours: edges and centers of
        // the dragged bounds pull toward theirs within a screen threshold.
        // The matched coordinate doubles as an alignment guide line.
        let guideX: number | null = null
        let guideY: number | null = null
        if (mode.bounds0) {
          const threshold = 8 / view.zoom
          const pull = (edges: number[], targets: number[]) => {
            let best: { d: number; at: number } | null = null
            for (const e of edges) {
              for (const c of targets) {
                const d = c - e
                if (Math.abs(d) < (best === null ? threshold : Math.abs(best.d))) {
                  best = { d, at: c }
                }
              }
            }
            return best
          }
          const b = mode.bounds0
          const ddx = pull(
            [b.minX + dx, b.maxX + dx, (b.minX + b.maxX) / 2 + dx],
            mode.snapX,
          )
          if (ddx !== null) {
            dx += ddx.d
            guideX = ddx.at
          }
          const ddy = pull(
            [b.minY + dy, b.maxY + dy, (b.minY + b.maxY) / 2 + dy],
            mode.snapY,
          )
          if (ddy !== null) {
            dy += ddy.d
            guideY = ddy.at
          }
        }
        // Ctrl: whole-millimeter positions.
        if (e.ctrlKey || e.metaKey) {
          dx = Math.round(mode.primaryWorld.x + dx) - mode.primaryWorld.x
          dy = Math.round(mode.primaryWorld.y + dy) - mode.primaryWorld.y
        }
        // A cap straddling the mirror line centers on it (shared middle key).
        const { mirror } = store.getState()
        if (
          mirror.enabled &&
          Math.abs(mode.primaryWorld.x + dx - mirror.axis) < mode.primaryHalfW
        ) {
          dx = mirror.axis - mode.primaryWorld.x
          guideX = mirror.axis
        }
        setSnapGuides(guideX, guideY)
        const patches: TransformPatches = {
          keys: new Map(),
          groups: new Map(),
        }
        for (const [id, o] of mode.groupsOrig) {
          patches.groups!.set(id, { x: o.x + dx, y: o.y + dy })
        }
        for (const [id, o] of mode.keysOrig) {
          const rad = (-o.frameR * Math.PI) / 180
          const cos = Math.cos(rad)
          const sin = Math.sin(rad)
          patches.keys!.set(id, {
            x: o.x + dx * cos - dy * sin,
            y: o.y + dx * sin + dy * cos,
          })
        }
        showDragBadge(
          e,
          `${(mode.primaryWorld.x + dx).toFixed(1)}, ${(mode.primaryWorld.y + dy).toFixed(1)}`,
        )
        useDocStore.getState().transform(patches)
      } else if (mode.kind === 'band') {
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const left = Math.min(x, mode.startX)
        const top = Math.min(y, mode.startY)
        band.style.display = 'block'
        band.style.left = `${left}px`
        band.style.top = `${top}px`
        band.style.width = `${Math.abs(x - mode.startX)}px`
        band.style.height = `${Math.abs(y - mode.startY)}px`
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      hideDragBadge()
      setSnapGuides(null, null)
      invalidate()
      if (mode.kind === 'drag') {
        useDocStore.getState().endTransform()
      } else if (mode.kind === 'band') {
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const left = Math.min(x, mode.startX)
        const right = Math.max(x, mode.startX)
        const top = Math.min(y, mode.startY)
        const bottom = Math.max(y, mode.startY)
        band.style.display = 'none'
        const state = store.getState()
        if (right - left < 3 && bottom - top < 3) {
          if (!mode.shift) state.clearSelection()
        } else {
          const groups = groupMap(state.groups)
          const inside = state.keys
            .filter((k) => {
              const w = keyWorldXF(k, groups)
              const p = mmToPx(w.x, w.y)
              return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
            })
            .map((k) => k.id)
          if (mode.shift) state.addToSelection(inside)
          else state.setSelection(inside)
        }
      }
      mode = { kind: 'idle' }
      setCursor()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const before = toMM(e.clientX, e.clientY)
      view.zoom = Math.min(40, Math.max(1.5, view.zoom * Math.exp(-e.deltaY * 0.0012)))
      const after = toMM(e.clientX, e.clientY)
      view.cx += before.x - after.x
      view.cy += before.y - after.y
      applyCamera()
    }

    const inTextField = (e: KeyboardEvent) => {
      const t = e.target
      return (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
      )
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (inTextField(e)) return
      const state = store.getState()
      const mod = e.ctrlKey || e.metaKey
      if (e.code === 'Space') {
        spaceHeld = true
        setCursor()
        e.preventDefault()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        state.deleteSelected()
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) state.redo()
        else state.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        state.redo()
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        state.selectAll()
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) state.ungroupSelection()
        else state.groupSelection()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        state.duplicateSelection()
      } else if (e.key === 'Escape') {
        state.clearSelection()
      } else if (e.key.toLowerCase() === 'r' && !mod) {
        state.rotateSelected(e.shiftKey ? -15 : 15)
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault()
        const step = e.shiftKey ? 0.1 : state.snapStep || 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0
        state.nudgeSelected(dx, dy)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld = false
        setCursor()
      }
    }

    const onContextMenu = (e: Event) => e.preventDefault()

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    // ---- Lifecycle --------------------------------------------------------

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = wrap
      renderer.setSize(w, h)
      applyCamera()
    }
    resize()
    fitToContent()
    applyCamera()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    const unsubscribe = store.subscribe(sync)
    sync()

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      if (!renderQueued) return
      renderQueued = false
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      clearTimeout(outlineTimer)
      wrap.removeChild(dragBadge)
      clearGroupBox()
      for (const line of bezelLines) line.geometry.dispose()
      screwCircleGeo.dispose()
      for (const v of views.values()) disposeSprite(v)
      for (const geo of geoCache.values()) geo.dispose()
      for (const m of Object.values(materials)) m.dispose()
      axisLine.geometry.dispose()
      guideV.geometry.dispose()
      guideH.geometry.dispose()
      grid.geometry.dispose()
      renderer.dispose()
      wrap.removeChild(canvas)
    }
  }, [])

  return (
    <div className="editor" ref={wrapRef}>
      <div className="select-band" ref={bandRef} />
      <div className="gizmo-layer" ref={gizmoRef} />
      <div className="dims-badge" ref={dimsRef} />
    </div>
  )
}
