import { create } from 'zustand'
import {
  columnSlots,
  defaultDoc,
  groupWorldXF,
  isKeyMirrored,
  keyWorldAABB,
  keyWorldXF,
  makeKey,
  newId,
  rotateDelta,
  stackPositions,
  worldToLocal,
  U,
  type ColumnDef,
  type Doc,
  type Group,
  type GroupLayout,
  type BezelSettings,
  type BoardMaterial,
  type BoardMaterials,
  type MaterialSlot,
  MATERIAL_SLOTS,
  type Key,
  type KeyType,
  type MirrorSettings,
  type PlateSettings,
  DEFAULT_BEZEL,
  DEFAULT_MATERIALS,
  DEFAULT_PLATE,
  DEFAULT_TILT,
} from './keys'

const STORAGE_KEY = 'keebforge.doc.v1'
const SNAP_KEY = 'keebforge.snap'
const MAX_HISTORY = 200

function loadSnapStep(): number {
  try {
    const raw = localStorage.getItem(SNAP_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : U / 4
  } catch {
    return U / 4
  }
}

export interface TransformPatches {
  keys?: Map<string, Partial<Key>>
  groups?: Map<string, Partial<Group>>
}

export interface DocState extends Doc {
  selection: Set<string>
  past: Doc[]
  future: Doc[]
  /** Position snap step in mm; 0 disables snapping. */
  snapStep: number

  setSnapStep: (step: number) => void
  setSelection: (ids: Iterable<string>) => void
  addToSelection: (ids: Iterable<string>) => void
  removeFromSelection: (ids: Iterable<string>) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  selectAll: () => void

  addKey: (type: KeyType) => void
  addColumnCluster: () => void
  deleteSelected: () => void
  /** Clone the selection one unit down-right and select the clones.
   * Fully-selected top-level groups are cloned with their whole subtree;
   * other keys are cloned individually (keys from generated column layouts
   * become free keys, since regeneration would discard extras). */
  duplicateSelection: () => void
  /** Patch group-local key properties (type, size, label, rotation…). */
  updateSelected: (patch: Partial<Omit<Key, 'id'>>) => void
  /** Set world-space position; converted per key into its group frame. */
  updateSelectedWorld: (patch: { x?: number; y?: number }) => void
  /** Rotate the selection: the whole group when a full group is selected,
   * otherwise each key about its own center. */
  rotateSelected: (deg: number) => void
  /** Move the selection by a world-space delta (group-aware like rotate). */
  nudgeSelected: (dx: number, dy: number) => void
  /** Align the selection's edges/centers in world space. Fully-selected
   * top-level groups move as one rigid unit; other keys move individually. */
  alignSelected: (mode: AlignMode) => void
  /** Space the selection evenly along an axis; the outermost items stay put.
   * Group-aware like align. */
  distributeSelected: (axis: 'x' | 'y') => void

  /** Assign QWERTY alpha labels onto the board's structure: column clusters
   * provide exact col/row slots (with a digit row when a cluster has 4+
   * rows); otherwise 1u keys are banded into rows geometrically. Alphas hug
   * the middle — extra outer pinky columns are left alone, as are thumbs. */
  applyAlphaLabels: () => void

  groupSelection: () => void
  ungroupSelection: () => void
  updateGroup: (id: string, patch: Partial<Omit<Group, 'id' | 'layout'>>) => void
  updateGroupLayout: (id: string, layout: GroupLayout) => void
  setMirror: (patch: Partial<MirrorSettings>) => void
  setPlate: (patch: Partial<PlateSettings>) => void
  setBezel: (patch: Partial<BezelSettings>) => void
  setTilt: (deg: number) => void
  setMaterial: (slot: MaterialSlot, patch: Partial<BoardMaterial>) => void
  /** Toggle linked materials; enabling copies the case material everywhere. */
  setMaterialsLinked: (linked: boolean) => void

  /** Transient transform: begin snapshots the doc, transform applies patches
   * relative to that snapshot (so drags don't accumulate error), end commits
   * the whole gesture as one undo step. */
  beginTransform: () => void
  transform: (patches: TransformPatches) => void
  endTransform: () => void

  undo: () => void
  redo: () => void
  loadDoc: (doc: Partial<Doc>) => void
}

// ---- Group helpers (exported for UI/editor use) ---------------------------

export function groupMap(groups: Group[]): Map<string, Group> {
  return new Map(groups.map((g) => [g.id, g]))
}

/** Top-level ancestor group of a key, or null for ungrouped keys. */
export function topGroupOf(key: Key, groups: Map<string, Group>): Group | null {
  let g = key.groupId ? groups.get(key.groupId) : undefined
  const visited = new Set<string>()
  while (g && g.parentId && !visited.has(g.id)) {
    visited.add(g.id)
    const parent = groups.get(g.parentId)
    if (!parent) break
    g = parent
  }
  return g ?? null
}

/** Ids of all keys inside a group's subtree. */
export function memberKeyIds(groupId: string, keys: Key[], groups: Group[]): string[] {
  const inTree = new Set([groupId])
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) {
      if (g.parentId && inTree.has(g.parentId) && !inTree.has(g.id)) {
        inTree.add(g.id)
        grew = true
      }
    }
  }
  return keys.filter((k) => k.groupId && inTree.has(k.groupId)).map((k) => k.id)
}

/** If the selection is exactly the member keys of a single top-level group,
 * return that group. */
export function wholeSelectedGroup(state: {
  keys: Key[]
  groups: Group[]
  selection: Set<string>
}): Group | null {
  if (state.selection.size === 0) return null
  const groups = groupMap(state.groups)
  const first = state.keys.find((k) => state.selection.has(k.id))
  if (!first) return null
  const top = topGroupOf(first, groups)
  if (!top) return null
  const members = memberKeyIds(top.id, state.keys, state.groups)
  if (members.length !== state.selection.size) return null
  return members.every((id) => state.selection.has(id)) ? top : null
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

export interface AlignItem {
  /** Fully-selected top-level group moved as one rigid unit, or null when the
   * item is a single key. */
  group: Group | null
  keys: Key[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Break the selection into alignable units: each fully-selected top-level
 * group is one unit, every other selected key is its own unit. Bounds are
 * world-space AABBs of the pitch areas. */
export function alignmentItems(state: {
  keys: Key[]
  groups: Group[]
  selection: Set<string>
}): AlignItem[] {
  const groups = groupMap(state.groups)
  const items: AlignItem[] = []
  const consumed = new Set<string>()
  const topsSeen = new Set<string>()
  const makeItem = (group: Group | null, keys: Key[]): AlignItem => {
    const item = {
      group,
      keys,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    }
    for (const k of keys) {
      const b = keyWorldAABB(k, groups)
      item.minX = Math.min(item.minX, b.minX)
      item.minY = Math.min(item.minY, b.minY)
      item.maxX = Math.max(item.maxX, b.maxX)
      item.maxY = Math.max(item.maxY, b.maxY)
    }
    return item
  }
  for (const key of state.keys) {
    if (!state.selection.has(key.id) || consumed.has(key.id)) continue
    const top = topGroupOf(key, groups)
    if (top && !topsSeen.has(top.id)) {
      topsSeen.add(top.id)
      const members = memberKeyIds(top.id, state.keys, state.groups)
      if (members.every((id) => state.selection.has(id))) {
        const memberSet = new Set(members)
        for (const id of members) consumed.add(id)
        items.push(makeItem(top, state.keys.filter((k) => memberSet.has(k.id))))
        continue
      }
    }
    items.push(makeItem(null, [key]))
  }
  return items
}

/** Regenerate a column-layout group's keys from its layout definition. Keys
 * keep their identity (and label/size tweaks) via their col/row slot. The
 * layout's keyType is stamped onto every member so slot spacing and switch
 * type can never drift apart. */
function regenerateGroup(group: Group, keys: Key[]): Key[] {
  if (group.layout.kind !== 'columns') return keys
  const layout = group.layout
  const slots = columnSlots(layout)
  const bySlot = new Map<string, Key>()
  for (const k of keys) {
    if (k.groupId === group.id) bySlot.set(`${k.col},${k.row}`, k)
  }
  const result = keys.filter((k) => k.groupId !== group.id)
  for (const slot of slots) {
    const existing = bySlot.get(`${slot.col},${slot.row}`)
    if (existing) {
      result.push({ ...existing, type: layout.keyType, x: slot.x, y: slot.y, r: slot.r })
    } else {
      result.push({
        ...makeKey(layout.keyType, slot.x, slot.y),
        r: slot.r,
        groupId: group.id,
        col: slot.col,
        row: slot.row,
      })
    }
  }
  return result
}

/** Re-pack the keys of every stack-layout group along its axis. Preserves
 * object identity when nothing moves, so no-op commits stay cheap. */
function relayoutStacks(keys: Key[], groups: Group[]): Key[] {
  let result = keys
  for (const g of groups) {
    if (g.layout.kind !== 'stack') continue
    const members = result.filter((k) => k.groupId === g.id)
    if (members.length === 0) continue
    const pos = stackPositions(g.layout, members)
    let changed = false
    const next = result.map((k) => {
      const p = pos.get(k.id)
      if (!p) return k
      const r = p.r ?? k.r
      if (k.x === p.x && k.y === p.y && k.r === r) return k
      changed = true
      return { ...k, x: p.x, y: p.y, r }
    })
    if (changed) result = next
  }
  return result
}

// ---- Auto labels ----------------------------------------------------------

const ALPHA_ROWS = {
  left: [
    ['Q', 'W', 'E', 'R', 'T'],
    ['A', 'S', 'D', 'F', 'G'],
    ['Z', 'X', 'C', 'V', 'B'],
  ],
  right: [
    ['Y', 'U', 'I', 'O', 'P'],
    ['H', 'J', 'K', 'L', ';'],
    ['N', 'M', ',', '.', '/'],
  ],
}
const DIGIT_ROW = {
  left: ['1', '2', '3', '4', '5'],
  right: ['6', '7', '8', '9', '0'],
}

// ---- Persistence ----------------------------------------------------------

/** Fill in defaults; docs saved before the radius split carry a single
 * `radius`, which maps onto the outer radius. */
export function normalizeBezel(raw: unknown): BezelSettings {
  if (!raw || typeof raw !== 'object' || typeof (raw as BezelSettings).width !== 'number') {
    return { ...DEFAULT_BEZEL }
  }
  const legacy = raw as BezelSettings & { radius?: number }
  const migrated =
    typeof legacy.radius === 'number' && legacy.radiusOuter === undefined
      ? { radiusOuter: legacy.radius, radiusInner: legacy.radius }
      : {}
  const { radius: _radius, ...rest } = legacy
  return { ...DEFAULT_BEZEL, ...migrated, ...rest }
}

/** Fill in defaults; docs saved before surface finishes carried a `colors`
 * map of plain hex strings, which migrate onto the default finishes. */
export function normalizeMaterials(raw: unknown, legacyColors?: unknown): BoardMaterials {
  const result = structuredClone(DEFAULT_MATERIALS)
  if (raw && typeof raw === 'object') {
    for (const slot of MATERIAL_SLOTS) {
      const m = (raw as Record<string, Partial<BoardMaterial>>)[slot]
      if (m && typeof m.color === 'string') result[slot] = { ...result[slot], ...m }
    }
    const linked = (raw as BoardMaterials).linked
    if (typeof linked === 'boolean') result.linked = linked
  } else if (legacyColors && typeof legacyColors === 'object') {
    for (const slot of MATERIAL_SLOTS) {
      const color = (legacyColors as Record<string, string>)[slot]
      if (typeof color === 'string') result[slot].color = color
    }
  }
  return result
}

function loadSaved(): Doc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.keys)) return null
    return {
      keys: parsed.keys as Key[],
      groups: Array.isArray(parsed.groups) ? (parsed.groups as Group[]) : [],
      mirror:
        parsed.mirror && typeof parsed.mirror.axis === 'number'
          ? (parsed.mirror as MirrorSettings)
          : { enabled: false, axis: 6 * U },
      plate:
        parsed.plate && typeof parsed.plate.padding === 'number'
          ? (parsed.plate as PlateSettings)
          : { ...DEFAULT_PLATE },
      bezel: normalizeBezel(parsed.bezel),
      tilt: typeof parsed.tilt === 'number' ? parsed.tilt : DEFAULT_TILT,
      materials: normalizeMaterials(parsed.materials, parsed.colors),
    }
  } catch {
    return null
  }
}

// ---- Store ----------------------------------------------------------------

let transformSnapshot: Doc | null = null

/** Undo coalescing: commits made inside `coalesceUndo` with the same key as
 * the immediately preceding commit collapse into one undo step, so live
 * editing a field doesn't record every keystroke. Any commit outside
 * `coalesceUndo` (or with a different key) starts a fresh step. */
let pendingCoalesceKey: string | null = null
let lastCoalesceKey: string | null = null

export function coalesceUndo<T>(key: string, fn: () => T): T {
  pendingCoalesceKey = key
  try {
    return fn()
  } finally {
    pendingCoalesceKey = null
  }
}

const docOf = (s: Doc): Doc => ({
  keys: s.keys,
  groups: s.groups,
  mirror: s.mirror,
  plate: s.plate,
  bezel: s.bezel,
  tilt: s.tilt,
  materials: s.materials,
})

export const useDocStore = create<DocState>((set, get) => {
  const commit = (patch: Partial<Doc>) => {
    const state = get()
    const prev = docOf(state)
    const pushPast = pendingCoalesceKey === null || pendingCoalesceKey !== lastCoalesceKey
    lastCoalesceKey = pendingCoalesceKey
    let keys = patch.keys ?? state.keys
    let groups = patch.groups ?? state.groups
    // Garbage-collect groups that lost all their keys and child groups.
    for (;;) {
      const empty = groups.filter(
        (g) =>
          !keys.some((k) => k.groupId === g.id) &&
          !groups.some((c) => c.parentId === g.id),
      )
      if (empty.length === 0) break
      const dead = new Set(empty.map((g) => g.id))
      groups = groups.filter((g) => !dead.has(g.id))
    }
    keys = relayoutStacks(keys, groups)
    const alive = new Set(keys.map((k) => k.id))
    set({
      keys,
      groups,
      mirror: patch.mirror ?? state.mirror,
      plate: patch.plate ?? state.plate,
      bezel: patch.bezel ?? state.bezel,
      tilt: patch.tilt ?? state.tilt,
      materials: patch.materials ?? state.materials,
      past: pushPast ? [...state.past.slice(-MAX_HISTORY + 1), prev] : state.past,
      future: [],
      selection: new Set([...state.selection].filter((id) => alive.has(id))),
    })
  }

  /** Move alignment items by world-space deltas and commit once. Group units
   * are top-level, so the world delta applies to the group origin directly;
   * loose keys get the delta rotated into their group frame. */
  const applyItemMoves = (moves: { item: AlignItem; dx: number; dy: number }[]) => {
    const state = get()
    const groups = groupMap(state.groups)
    const groupDelta = new Map<string, { dx: number; dy: number }>()
    const keyDelta = new Map<string, { dx: number; dy: number }>()
    for (const { item, dx, dy } of moves) {
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue
      if (item.group) groupDelta.set(item.group.id, { dx, dy })
      else for (const k of item.keys) keyDelta.set(k.id, { dx, dy })
    }
    if (groupDelta.size === 0 && keyDelta.size === 0) return
    commit({
      keys: state.keys.map((k) => {
        const d = keyDelta.get(k.id)
        if (!d) return k
        const frame = groupWorldXF(groups, k.groupId)
        const local = rotateDelta(frame.r, d.dx, d.dy)
        return { ...k, x: k.x + local.x, y: k.y + local.y }
      }),
      groups: state.groups.map((g) => {
        const d = groupDelta.get(g.id)
        return d ? { ...g, x: g.x + d.dx, y: g.y + d.dy } : g
      }),
    })
  }

  return {
    ...(loadSaved() ?? defaultDoc()),
    selection: new Set(),
    past: [],
    future: [],
    snapStep: loadSnapStep(),

    setSnapStep: (step) => {
      set({ snapStep: step })
      try {
        localStorage.setItem(SNAP_KEY, String(step))
      } catch {
        // Storage full or unavailable — persistence is best-effort.
      }
    },
    setSelection: (ids) => set({ selection: new Set(ids) }),
    addToSelection: (ids) => {
      const selection = new Set(get().selection)
      for (const id of ids) selection.add(id)
      set({ selection })
    },
    removeFromSelection: (ids) => {
      const selection = new Set(get().selection)
      for (const id of ids) selection.delete(id)
      set({ selection })
    },
    toggleSelected: (id) => {
      const selection = new Set(get().selection)
      if (selection.has(id)) selection.delete(id)
      else selection.add(id)
      set({ selection })
    },
    clearSelection: () => set({ selection: new Set() }),
    selectAll: () => set({ selection: new Set(get().keys.map((k) => k.id)) }),

    addKey: (type) => {
      const { keys, selection } = get()
      const anchor = keys.filter((k) => selection.has(k.id)).at(-1) ?? keys.at(-1)
      const key =
        anchor && !anchor.groupId
          ? makeKey(type, anchor.x + U, anchor.y)
          : makeKey(type, 0, 0)
      commit({ keys: [...keys, key] })
      set({ selection: new Set([key.id]) })
    },

    addColumnCluster: () => {
      const state = get()
      const groups = groupMap(state.groups)
      let maxX = 0
      let minXMirrored = 0
      for (const k of state.keys) {
        const wx = keyWorldXF(k, groups).x
        maxX = Math.max(maxX, wx)
        if (isKeyMirrored(k, groups)) minXMirrored = Math.min(minXMirrored, wx)
      }
      // Keep clear of the mirrored half too.
      if (state.mirror.enabled) maxX = Math.max(maxX, 2 * state.mirror.axis - minXMirrored)
      const group: Group = {
        id: newId('g'),
        name: `Cluster ${state.groups.length + 1}`,
        parentId: null,
        x: state.keys.length > 0 ? maxX + 2 * U : 0,
        y: 0,
        r: 0,
        layout: {
          kind: 'columns',
          rows: 3,
          columns: [
            { stagger: 0, splay: 0 },
            { stagger: 2, splay: 0 },
            { stagger: 6, splay: 0 },
            { stagger: 3, splay: 0 },
            { stagger: -1, splay: 0 },
          ],
          keyType: 'mx',
        },
      }
      const keys = regenerateGroup(group, state.keys)
      commit({ keys, groups: [...state.groups, group] })
      set({ selection: new Set(memberKeyIds(group.id, keys, [...state.groups, group])) })
    },

    deleteSelected: () => {
      const { keys, selection } = get()
      if (selection.size === 0) return
      commit({ keys: keys.filter((k) => !selection.has(k.id)) })
    },

    duplicateSelection: () => {
      const state = get()
      if (state.selection.size === 0) return
      const groups = groupMap(state.groups)
      const dx = U
      const dy = -U
      const newKeys: Key[] = []
      const newGroups: Group[] = []
      const cloned = new Set<string>()

      // Fully-selected top-level groups: clone the whole subtree.
      const topsSeen = new Set<string>()
      for (const key of state.keys) {
        if (!state.selection.has(key.id)) continue
        const top = topGroupOf(key, groups)
        if (!top || topsSeen.has(top.id)) continue
        topsSeen.add(top.id)
        const members = memberKeyIds(top.id, state.keys, state.groups)
        if (!members.every((id) => state.selection.has(id))) continue
        const inTree = new Set([top.id])
        let grew = true
        while (grew) {
          grew = false
          for (const g of state.groups) {
            if (g.parentId && inTree.has(g.parentId) && !inTree.has(g.id)) {
              inTree.add(g.id)
              grew = true
            }
          }
        }
        const idMap = new Map<string, string>()
        for (const gid of inTree) idMap.set(gid, newId('g'))
        for (const g of state.groups) {
          if (!inTree.has(g.id)) continue
          newGroups.push({
            ...g,
            id: idMap.get(g.id)!,
            parentId: g.parentId && idMap.has(g.parentId) ? idMap.get(g.parentId)! : null,
            x: g.id === top.id ? g.x + dx : g.x,
            y: g.id === top.id ? g.y + dy : g.y,
          })
        }
        const memberSet = new Set(members)
        for (const k of state.keys) {
          if (!memberSet.has(k.id)) continue
          cloned.add(k.id)
          newKeys.push({ ...k, id: newId(), groupId: idMap.get(k.groupId!)! })
        }
      }

      // Remaining selected keys: clone individually.
      for (const key of state.keys) {
        if (!state.selection.has(key.id) || cloned.has(key.id)) continue
        const g = key.groupId ? groups.get(key.groupId) : undefined
        if (g && g.layout.kind === 'columns') {
          const world = keyWorldXF(key, groups)
          newKeys.push({
            ...key,
            id: newId(),
            x: world.x + dx,
            y: world.y + dy,
            r: world.r,
            groupId: null,
            col: undefined,
            row: undefined,
          })
        } else {
          const frame = groupWorldXF(groups, key.groupId)
          const local = rotateDelta(frame.r, dx, dy)
          newKeys.push({ ...key, id: newId(), x: key.x + local.x, y: key.y + local.y })
        }
      }

      commit({
        keys: [...state.keys, ...newKeys],
        groups: [...state.groups, ...newGroups],
      })
      set({ selection: new Set(newKeys.map((k) => k.id)) })
    },

    updateSelected: (patch) => {
      const state = get()
      if (state.selection.size === 0) return
      let keys = state.keys.map((k) =>
        state.selection.has(k.id) ? { ...k, ...patch } : k,
      )
      let groups = state.groups
      if (patch.type) {
        // Switch type inside a column cluster is a group-level property:
        // retarget the layout and regenerate so slot spacing follows.
        const affected = new Set(
          state.keys
            .filter((k) => state.selection.has(k.id) && k.groupId)
            .map((k) => k.groupId as string),
        )
        groups = groups.map((g) =>
          affected.has(g.id) &&
          g.layout.kind === 'columns' &&
          g.layout.keyType !== patch.type
            ? { ...g, layout: { ...g.layout, keyType: patch.type! } }
            : g,
        )
        for (const g of groups) {
          if (g.layout.kind === 'columns' && affected.has(g.id)) {
            keys = regenerateGroup(g, keys)
          }
        }
      }
      commit({ keys, groups })
    },

    updateSelectedWorld: (patch) => {
      const state = get()
      if (state.selection.size === 0) return
      const groups = groupMap(state.groups)
      commit({
        keys: state.keys.map((k) => {
          if (!state.selection.has(k.id)) return k
          const world = keyWorldXF(k, groups)
          const frame = groupWorldXF(groups, k.groupId)
          const local = worldToLocal(frame, patch.x ?? world.x, patch.y ?? world.y)
          return { ...k, x: local.x, y: local.y }
        }),
      })
    },

    rotateSelected: (deg) => {
      const state = get()
      if (state.selection.size === 0) return
      const whole = wholeSelectedGroup(state)
      if (whole) {
        commit({
          groups: state.groups.map((g) =>
            g.id === whole.id ? { ...g, r: Math.round((g.r + deg) * 100) / 100 } : g,
          ),
        })
      } else {
        commit({
          keys: state.keys.map((k) =>
            state.selection.has(k.id)
              ? { ...k, r: Math.round((k.r + deg) * 100) / 100 }
              : k,
          ),
        })
      }
    },

    nudgeSelected: (dx, dy) => {
      const state = get()
      if (state.selection.size === 0) return
      const whole = wholeSelectedGroup(state)
      if (whole) {
        commit({
          groups: state.groups.map((g) =>
            g.id === whole.id ? { ...g, x: g.x + dx, y: g.y + dy } : g,
          ),
        })
      } else {
        const groups = groupMap(state.groups)
        commit({
          keys: state.keys.map((k) => {
            if (!state.selection.has(k.id)) return k
            const frame = groupWorldXF(groups, k.groupId)
            const local = rotateDelta(frame.r, dx, dy)
            return { ...k, x: k.x + local.x, y: k.y + local.y }
          }),
        })
      }
    },

    alignSelected: (mode) => {
      const items = alignmentItems(get())
      if (items.length < 2) return
      const minX = Math.min(...items.map((i) => i.minX))
      const maxX = Math.max(...items.map((i) => i.maxX))
      const minY = Math.min(...items.map((i) => i.minY))
      const maxY = Math.max(...items.map((i) => i.maxY))
      applyItemMoves(
        items.map((item) => {
          let dx = 0
          let dy = 0
          // Editor space is y-up, so "top" is max Y.
          switch (mode) {
            case 'left':
              dx = minX - item.minX
              break
            case 'hcenter':
              dx = (minX + maxX) / 2 - (item.minX + item.maxX) / 2
              break
            case 'right':
              dx = maxX - item.maxX
              break
            case 'top':
              dy = maxY - item.maxY
              break
            case 'vcenter':
              dy = (minY + maxY) / 2 - (item.minY + item.maxY) / 2
              break
            case 'bottom':
              dy = minY - item.minY
              break
          }
          return { item, dx, dy }
        }),
      )
    },

    distributeSelected: (axis) => {
      const items = alignmentItems(get())
      if (items.length < 3) return
      const sorted = [...items].sort((a, b) =>
        axis === 'x'
          ? a.minX + a.maxX - (b.minX + b.maxX)
          : a.minY + a.maxY - (b.minY + b.maxY),
      )
      const lo = axis === 'x' ? sorted[0].minX : sorted[0].minY
      const hi = axis === 'x' ? sorted.at(-1)!.maxX : sorted.at(-1)!.maxY
      const extents = sorted.map((i) =>
        axis === 'x' ? i.maxX - i.minX : i.maxY - i.minY,
      )
      const gap =
        (hi - lo - extents.reduce((s, e) => s + e, 0)) / (sorted.length - 1)
      let cursor = lo
      applyItemMoves(
        sorted.map((item, i) => {
          const d = cursor - (axis === 'x' ? item.minX : item.minY)
          cursor += extents[i] + gap
          return { item, dx: axis === 'x' ? d : 0, dy: axis === 'x' ? 0 : d }
        }),
      )
    },

    applyAlphaLabels: () => {
      const state = get()
      const groups = groupMap(state.groups)
      const labels = new Map<string, string>()

      // Column clusters carry exact col/row slots — merge every cluster's
      // columns into one left-to-right list per hand.
      interface AlphaCol {
        x: number
        byRow: Map<number, Key>
        /** 1 when the cluster has a 4th row: row 0 becomes a digit row. */
        rowOffset: number
      }
      const cols: AlphaCol[] = []
      for (const g of state.groups) {
        if (g.layout.kind !== 'columns') continue
        const byCol = new Map<number, Key[]>()
        for (const k of state.keys) {
          if (k.groupId !== g.id || k.col === undefined || k.row === undefined) continue
          const list = byCol.get(k.col) ?? []
          list.push(k)
          byCol.set(k.col, list)
        }
        for (const keys of byCol.values()) {
          cols.push({
            x: keys.reduce((s, k) => s + keyWorldXF(k, groups).x, 0) / keys.length,
            byRow: new Map(keys.map((k) => [k.row!, k])),
            rowOffset: g.layout.rows >= 4 ? 1 : 0,
          })
        }
      }

      /** Split a left-to-right list into hands at the widest gap (mirrored
       * docs describe the left half only). */
      const splitHands = <T,>(items: T[], xOf: (t: T) => number) => {
        if (state.mirror.enabled) return [{ side: 'left' as const, items }]
        let splitAt = -1
        let widest = 1.2 * U
        for (let i = 1; i < items.length; i++) {
          const gap = xOf(items[i]) - xOf(items[i - 1])
          if (gap > widest) {
            widest = gap
            splitAt = i
          }
        }
        if (splitAt < 0) splitAt = Math.ceil(items.length / 2)
        return [
          { side: 'left' as const, items: items.slice(0, splitAt) },
          { side: 'right' as const, items: items.slice(splitAt) },
        ]
      }

      if (cols.length > 0) {
        cols.sort((a, b) => a.x - b.x)
        for (const hand of splitHands(cols, (c) => c.x)) {
          // Alphas hug the middle; extra outer (pinky) columns stay as-is.
          const n = Math.min(5, hand.items.length)
          const picked =
            hand.side === 'left' ? hand.items.slice(-n) : hand.items.slice(0, n)
          picked.forEach((col, i) => {
            for (const [row, key] of col.byRow) {
              if (col.rowOffset === 1 && row === 0) {
                labels.set(key.id, DIGIT_ROW[hand.side][i])
              } else {
                const r = row - col.rowOffset
                if (r >= 0 && r < 3) labels.set(key.id, ALPHA_ROWS[hand.side][r][i])
              }
            }
          })
        }
      } else {
        // Geometric fallback: band unrotated 1u keys into rows and label the
        // three fullest bands (thumb arcs are rotated or sparse, so they
        // fall out naturally).
        const cands = state.keys
          .filter((k) => k.w <= 1.25 && k.h <= 1.25)
          .map((k) => ({ k, w: keyWorldXF(k, groups) }))
          .filter(({ w }) => {
            const a = ((w.r % 360) + 360) % 360
            return Math.min(a, 360 - a) <= 20
          })
          .sort((a, b) => b.w.y - a.w.y)
        const bands: { y: number; items: typeof cands }[] = []
        for (const c of cands) {
          const band = bands[bands.length - 1]
          if (band && band.y - c.w.y < 0.55 * U) band.items.push(c)
          else bands.push({ y: c.w.y, items: [c] })
        }
        const rows = [...bands]
          .sort((a, b) => b.items.length - a.items.length)
          .slice(0, 3)
          .sort((a, b) => b.y - a.y)
        rows.forEach((band, r) => {
          const items = [...band.items].sort((a, b) => a.w.x - b.w.x)
          for (const hand of splitHands(items, (c) => c.w.x)) {
            const n = Math.min(5, hand.items.length)
            const picked =
              hand.side === 'left' ? hand.items.slice(-n) : hand.items.slice(0, n)
            picked.forEach((c, i) => labels.set(c.k.id, ALPHA_ROWS[hand.side][r][i]))
          }
        })
      }

      if (labels.size === 0) return
      commit({
        keys: state.keys.map((k) => {
          const label = labels.get(k.id)
          return label !== undefined && k.label !== label ? { ...k, label } : k
        }),
      })
    },

    groupSelection: () => {
      const state = get()
      const selected = state.keys.filter((k) => state.selection.has(k.id))
      if (selected.length < 2 || selected.some((k) => k.groupId)) return
      const cx = selected.reduce((s, k) => s + k.x, 0) / selected.length
      const cy = selected.reduce((s, k) => s + k.y, 0) / selected.length
      const group: Group = {
        id: newId('g'),
        name: `Group ${state.groups.length + 1}`,
        parentId: null,
        x: cx,
        y: cy,
        r: 0,
        layout: { kind: 'free' },
      }
      commit({
        keys: state.keys.map((k) =>
          state.selection.has(k.id)
            ? { ...k, x: k.x - cx, y: k.y - cy, groupId: group.id }
            : k,
        ),
        groups: [...state.groups, group],
      })
    },

    ungroupSelection: () => {
      const state = get()
      const groups = groupMap(state.groups)
      const targets = new Set<string>()
      for (const k of state.keys) {
        if (state.selection.has(k.id)) {
          const top = topGroupOf(k, groups)
          if (top) targets.add(top.id)
        }
      }
      if (targets.size === 0) return
      const doomed = new Set<string>()
      for (const id of targets) {
        doomed.add(id)
        for (const g of state.groups) {
          const top = topGroupOf({ groupId: g.parentId } as Key, groups)
          if (g.parentId && (targets.has(g.parentId) || (top && targets.has(top.id)))) {
            doomed.add(g.id)
          }
        }
      }
      commit({
        keys: state.keys.map((k) => {
          if (!k.groupId || !doomed.has(topGroupOf(k, groups)?.id ?? '')) return k
          const world = keyWorldXF(k, groups)
          return { ...k, x: world.x, y: world.y, r: world.r, groupId: null, col: undefined, row: undefined }
        }),
        groups: state.groups.filter((g) => !doomed.has(g.id)),
      })
    },

    updateGroup: (id, patch) => {
      commit({
        groups: get().groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
      })
    },

    updateGroupLayout: (id, layout) => {
      const state = get()
      const group = state.groups.find((g) => g.id === id)
      if (!group) return
      const updated = { ...group, layout }
      let keys = regenerateGroup(updated, state.keys)
      // A curved stack owns its members' rotations; clearing the curve (or
      // leaving stack layout) would otherwise strand the fan rotations.
      const hadCurve =
        group.layout.kind === 'stack' && (group.layout.curve ?? 0) !== 0
      const hasCurve = layout.kind === 'stack' && (layout.curve ?? 0) !== 0
      if (hadCurve && !hasCurve) {
        keys = keys.map((k) =>
          k.groupId === id && k.r !== 0 ? { ...k, r: 0 } : k,
        )
      }
      commit({
        keys,
        groups: state.groups.map((g) => (g.id === id ? updated : g)),
      })
    },

    setMirror: (patch) => {
      commit({ mirror: { ...get().mirror, ...patch } })
    },

    setPlate: (patch) => {
      commit({ plate: { ...get().plate, ...patch } })
    },

    setBezel: (patch) => {
      commit({ bezel: { ...get().bezel, ...patch } })
    },

    setTilt: (deg) => {
      commit({ tilt: deg })
    },

    setMaterial: (slot, patch) => {
      const materials = get().materials
      const next = { ...materials }
      for (const s of materials.linked ? MATERIAL_SLOTS : [slot]) {
        next[s] = { ...materials[s], ...patch }
      }
      commit({ materials: next })
    },

    setMaterialsLinked: (linked) => {
      const materials = get().materials
      const next = { ...materials, linked }
      if (linked) {
        for (const s of MATERIAL_SLOTS) next[s] = { ...materials.case }
      }
      commit({ materials: next })
    },

    beginTransform: () => {
      transformSnapshot = docOf(get())
    },
    transform: (patches) => {
      if (!transformSnapshot) return
      const snap = transformSnapshot
      set({
        keys: patches.keys
          ? snap.keys.map((k) => {
              const p = patches.keys!.get(k.id)
              return p ? { ...k, ...p } : k
            })
          : snap.keys,
        groups: patches.groups
          ? snap.groups.map((g) => {
              const p = patches.groups!.get(g.id)
              return p ? { ...g, ...p } : g
            })
          : snap.groups,
      })
    },
    endTransform: () => {
      const snapshot = transformSnapshot
      transformSnapshot = null
      if (!snapshot) return
      const now = get()
      if (snapshot.keys === now.keys && snapshot.groups === now.groups) return
      lastCoalesceKey = null
      set({
        // Re-pack stacks so dragging a key within one reorders it on drop.
        keys: relayoutStacks(now.keys, now.groups),
        past: [...now.past.slice(-MAX_HISTORY + 1), snapshot],
        future: [],
      })
    },

    undo: () => {
      const state = get()
      const prev = state.past.at(-1)
      if (!prev) return
      lastCoalesceKey = null
      const alive = new Set(prev.keys.map((k) => k.id))
      set({
        ...prev,
        past: state.past.slice(0, -1),
        future: [docOf(state), ...state.future],
        selection: new Set([...state.selection].filter((id) => alive.has(id))),
      })
    },
    redo: () => {
      const state = get()
      const next = state.future[0]
      if (!next) return
      lastCoalesceKey = null
      const alive = new Set(next.keys.map((k) => k.id))
      set({
        ...next,
        past: [...state.past, docOf(state)],
        future: state.future.slice(1),
        selection: new Set([...state.selection].filter((id) => alive.has(id))),
      })
    },

    loadDoc: (doc) => {
      commit({
        keys: doc.keys ?? [],
        groups: doc.groups ?? [],
        mirror: doc.mirror ?? { enabled: false, axis: 6 * U },
        plate: doc.plate ?? { ...DEFAULT_PLATE },
        bezel: normalizeBezel(doc.bezel),
        tilt: doc.tilt ?? DEFAULT_TILT,
        materials: normalizeMaterials(doc.materials),
      })
      set({ selection: new Set() })
    },
  }
})

export type { ColumnDef }

// Autosave to localStorage, debounced.
let saveTimer: ReturnType<typeof setTimeout> | undefined
useDocStore.subscribe((state, prev) => {
  if (
    state.keys === prev.keys &&
    state.groups === prev.groups &&
    state.mirror === prev.mirror &&
    state.plate === prev.plate &&
    state.bezel === prev.bezel &&
    state.tilt === prev.tilt &&
    state.materials === prev.materials
  )
    return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 4,
          keys: state.keys,
          groups: state.groups,
          mirror: state.mirror,
          plate: state.plate,
          bezel: state.bezel,
          tilt: state.tilt,
          materials: state.materials,
        }),
      )
    } catch {
      // Storage full or unavailable — autosave is best-effort.
    }
  }, 400)
})
