import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { capSize, hitTest, keySize, type Key } from '../model/keys'
import { useDocStore } from '../model/store'

const COLORS = {
  bg: 0x16171d,
  grid: 0x23252e,
  gridCenter: 0x30333f,
  base: 0x1e2028,
  baseSelected: 0x263248,
  capMx: 0x4c505f,
  capChoc: 0x46605d,
  capSelected: 0x5f6a8c,
  outline: 0x6aa6ff,
  label: '#e8eaf0',
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

function makeLabelTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.font = '600 72px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLORS.label
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
    const fitToKeys = (keys: Key[]) => {
      if (keys.length === 0) return
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const k of keys) {
        minX = Math.min(minX, k.x - 20)
        maxX = Math.max(maxX, k.x + 20)
        minY = Math.min(minY, k.y - 20)
        maxY = Math.max(maxY, k.y + 20)
      }
      view.cx = (minX + maxX) / 2
      view.cy = (minY + maxY) / 2
      const { clientWidth: w, clientHeight: h } = wrap
      if (w > 0 && h > 0) {
        view.zoom = Math.min(w / (maxX - minX), h / (maxY - minY), 12)
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

    const updateView = (v: KeyView, key: Key, selected: boolean) => {
      const sizeChanged =
        v.key.type !== key.type || v.key.w !== key.w || v.key.h !== key.h
      if (sizeChanged || v.key === key) {
        const size = keySize(key)
        const cap = capSize(key)
        v.base.geometry = shapeGeo('base', size.w, size.h, 0.8)
        v.cap.geometry = shapeGeo('cap', cap.w, cap.h, 1.6)
        v.outline.geometry = outlineGeo(size.w, size.h)
      }
      v.group.position.set(key.x, key.y, 0)
      v.group.rotation.z = (key.r * Math.PI) / 180
      v.base.material = selected ? materials.baseSelected : materials.base
      v.cap.material = selected
        ? materials.capSelected
        : key.type === 'mx'
          ? materials.capMx
          : materials.capChoc
      v.outline.visible = selected
      if (v.key.label !== key.label || v.key === key) {
        if (v.sprite) {
          v.group.remove(v.sprite)
          ;(v.sprite.material.map as THREE.Texture)?.dispose()
          v.sprite.material.dispose()
          v.sprite = null
        }
        if (key.label) {
          const material = new THREE.SpriteMaterial({
            map: makeLabelTexture(key.label),
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
      v.key = key
      v.selected = selected
    }

    const createView = (key: Key): KeyView => {
      const group = new THREE.Group()
      const base = new THREE.Mesh()
      base.position.z = 0
      const cap = new THREE.Mesh()
      cap.position.z = 0.2
      const outline = new THREE.LineLoop(undefined, materials.outline)
      outline.position.z = 0.4
      group.add(base, cap, outline)
      scene.add(group)
      const v: KeyView = { group, base, cap, outline, sprite: null, key, selected: false }
      updateView(v, key, false)
      return v
    }

    const sync = () => {
      const { keys, selection } = store.getState()
      const alive = new Set(keys.map((k) => k.id))
      for (const [id, v] of views) {
        if (!alive.has(id)) {
          scene.remove(v.group)
          if (v.sprite) {
            ;(v.sprite.material.map as THREE.Texture)?.dispose()
            v.sprite.material.dispose()
          }
          views.delete(id)
        }
      }
      for (const key of keys) {
        const v = views.get(key.id)
        if (!v) views.set(key.id, createView(key))
        else if (v.key !== key || v.selected !== selection.has(key.id)) {
          updateView(v, key, selection.has(key.id))
        }
      }
      // Re-apply selection state for newly created views.
      for (const key of keys) {
        const v = views.get(key.id)!
        if (v.selected !== selection.has(key.id)) updateView(v, key, selection.has(key.id))
      }
    }

    // ---- Interaction ------------------------------------------------------

    type Mode =
      | { kind: 'idle' }
      | { kind: 'pan'; lastX: number; lastY: number }
      | {
          kind: 'drag'
          start: { x: number; y: number }
          primary: Key
          originals: Map<string, { x: number; y: number }>
        }
      | { kind: 'band'; startX: number; startY: number; shift: boolean }
    let mode: Mode = { kind: 'idle' }
    let spaceHeld = false

    const snap = (v: number) => {
      const step = store.getState().snapStep
      return step > 0 ? Math.round(v / step) * step : v
    }

    const pickKey = (x: number, y: number): Key | null => {
      const { keys } = store.getState()
      for (let i = keys.length - 1; i >= 0; i--) {
        if (hitTest(keys[i], x, y)) return keys[i]
      }
      return null
    }

    const setCursor = () => {
      canvas.style.cursor =
        mode.kind === 'pan' ? 'grabbing' : spaceHeld ? 'grab' : 'default'
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
      if (hit) {
        const state = store.getState()
        if (e.shiftKey) {
          state.toggleSelected(hit.id)
          return
        }
        if (!state.selection.has(hit.id)) state.setSelection([hit.id])
        const { keys, selection } = store.getState()
        const originals = new Map<string, { x: number; y: number }>()
        for (const k of keys) {
          if (selection.has(k.id)) originals.set(k.id, { x: k.x, y: k.y })
        }
        store.getState().beginTransform()
        mode = { kind: 'drag', start: pt, primary: hit, originals }
      } else {
        const rect = canvas.getBoundingClientRect()
        mode = {
          kind: 'band',
          startX: e.clientX - rect.left,
          startY: e.clientY - rect.top,
          shift: e.shiftKey,
        }
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
        // Snap the primary key's resulting position, move the rest rigidly.
        const orig = mode.originals.get(mode.primary.id)!
        dx = snap(orig.x + dx) - orig.x
        dy = snap(orig.y + dy) - orig.y
        const patches = new Map<string, Partial<Key>>()
        for (const [id, o] of mode.originals) {
          patches.set(id, { x: o.x + dx, y: o.y + dy })
        }
        store.getState().transform(patches)
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
        store.getState().endTransform()
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
          const inside = state.keys
            .filter((k) => {
              const p = mmToPx(k.x, k.y)
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
    fitToKeys(store.getState().keys)
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
      for (const v of views.values()) {
        if (v.sprite) {
          ;(v.sprite.material.map as THREE.Texture)?.dispose()
          v.sprite.material.dispose()
        }
      }
      for (const geo of geoCache.values()) geo.dispose()
      for (const m of Object.values(materials)) m.dispose()
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
