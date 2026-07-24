import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  capSize,
  hitTest,
  keySize,
  keyWorldXF,
  mirrorXF,
  type Key,
  type XForm,
} from '../model/keys'
import {
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
    ghost: 0x3b3f4d,
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
    ghost: 0xc4c9d3,
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

  useEffect(() => {
    const wrap = wrapRef.current
    const band = bandRef.current
    if (!wrap || !band) return

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
      for (const k of state.keys) {
        const w = keyWorldXF(k, groups)
        minX = Math.min(minX, w.x - 20)
        maxX = Math.max(maxX, w.x + 20)
        minY = Math.min(minY, w.y - 20)
        maxY = Math.max(maxY, w.y + 20)
      }
      if (state.mirror.enabled) maxX = Math.max(maxX, 2 * state.mirror.axis - minX)
      view.cx = (minX + maxX) / 2
      view.cy = (minY + maxY) / 2
      const { clientWidth: w, clientHeight: h } = wrap
      if (w > 0 && h > 0) {
        view.zoom = Math.min(w / (maxX - minX), h / (maxY - minY), 12) * 0.95
      }
    }

    const applyCamera = () => {
      const { clientWidth: w, clientHeight: h } = wrap
      camera.left = view.cx - w / 2 / view.zoom
      camera.right = view.cx + w / 2 / view.zoom
      camera.top = view.cy + h / 2 / view.zoom
      camera.bottom = view.cy - h / 2 / view.zoom
      camera.updateProjectionMatrix()
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
      const cacheKey = `${kind}:${w.toFixed(2)}x${h.toFixed(2)}`
      let geo = geoCache.get(cacheKey)
      if (!geo) {
        geo = new THREE.ShapeGeometry(roundedRect(w, h, r))
        geoCache.set(cacheKey, geo)
      }
      return geo
    }
    const outlineGeo = (w: number, h: number) => {
      const cacheKey = `outline:${w.toFixed(2)}x${h.toFixed(2)}`
      let geo = geoCache.get(cacheKey)
      if (!geo) {
        geo = new THREE.BufferGeometry().setFromPoints(
          roundedRect(w + 1.6, h + 1.6, 2).getPoints(4),
        )
        geoCache.set(cacheKey, geo)
      }
      return geo
    }

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
        v.base.geometry = shapeGeo('base', size.w, size.h, 0.8)
        v.cap.geometry = shapeGeo('cap', cap.w, cap.h, 1.6)
        v.outline.geometry = outlineGeo(size.w, size.h)
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
        v.base.geometry = shapeGeo('base', size.w, size.h, 0.8)
        v.cap.geometry = shapeGeo('cap', cap.w, cap.h, 1.6)
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

    // Dashed outline around a fully-selected group.
    let groupBox: THREE.LineLoop | null = null
    const clearGroupBox = () => {
      if (groupBox) {
        scene.remove(groupBox)
        groupBox.geometry.dispose()
        groupBox = null
      }
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
      for (const [id, v] of ghosts) {
        if (!alive.has(id) || !state.mirror.enabled) {
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

        if (state.mirror.enabled) {
          const mw = mirrorXF(world, state.mirror.axis)
          const g = ghosts.get(key.id)
          if (!g) ghosts.set(key.id, createGhost(key, mw))
          else updateGhost(g, key, mw, false)
        }
      }

      axisLine.visible = state.mirror.enabled
      axisLine.position.x = state.mirror.axis

      clearGroupBox()
      const whole = wholeSelectedGroup(state)
      if (whole) {
        const members = new Set(memberKeyIds(whole.id, state.keys, state.groups))
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const key of state.keys) {
          if (!members.has(key.id)) continue
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
        if (minX < maxX) {
          const pad = 3
          const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(minX - pad, minY - pad, 0),
            new THREE.Vector3(maxX + pad, minY - pad, 0),
            new THREE.Vector3(maxX + pad, maxY + pad, 0),
            new THREE.Vector3(minX - pad, maxY + pad, 0),
          ])
          groupBox = new THREE.LineLoop(geo, materials.groupOutline)
          groupBox.computeLineDistances()
          groupBox.position.z = 0.5
          scene.add(groupBox)
        }
      }
    }

    // ---- Interaction ------------------------------------------------------

    interface DragUnit {
      groupsOrig: Map<string, { x: number; y: number }>
      keysOrig: Map<string, { x: number; y: number; frameR: number }>
      primaryWorld: { x: number; y: number }
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
      store.getState().beginTransform()
      mode = { kind: 'drag', groupsOrig, keysOrig, primaryWorld, start }
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
        // Snap the primary key's resulting world position, move the rest rigidly.
        dx = snap(mode.primaryWorld.x + dx) - mode.primaryWorld.x
        dy = snap(mode.primaryWorld.y + dy) - mode.primaryWorld.y
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
      clearGroupBox()
      for (const v of views.values()) disposeSprite(v)
      for (const geo of geoCache.values()) geo.dispose()
      for (const m of Object.values(materials)) m.dispose()
      axisLine.geometry.dispose()
      grid.geometry.dispose()
      renderer.dispose()
      wrap.removeChild(canvas)
    }
  }, [])

  return (
    <div className="editor" ref={wrapRef}>
      <div className="select-band" ref={bandRef} />
    </div>
  )
}
