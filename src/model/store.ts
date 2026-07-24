import { create } from 'zustand'
import {
  columnSlots,
  defaultDoc,
  groupWorldXF,
  keyWorldXF,
  makeKey,
  newId,
  rotateDelta,
  worldToLocal,
  U,
  type ColumnDef,
  type Doc,
  type Group,
  type GroupLayout,
  type Key,
  type KeyType,
  type MirrorSettings,
  type PlateSettings,
  DEFAULT_PLATE,
} from './keys'

const STORAGE_KEY = 'keebforge.doc.v1'
const MAX_HISTORY = 200

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
  /** Patch group-local key properties (type, size, label, rotation…). */
  updateSelected: (patch: Partial<Omit<Key, 'id'>>) => void
  /** Set world-space position; converted per key into its group frame. */
  updateSelectedWorld: (patch: { x?: number; y?: number }) => void
  /** Rotate the selection: the whole group when a full group is selected,
   * otherwise each key about its own center. */
  rotateSelected: (deg: number) => void
  /** Move the selection by a world-space delta (group-aware like rotate). */
  nudgeSelected: (dx: number, dy: number) => void

  groupSelection: () => void
  ungroupSelection: () => void
  updateGroup: (id: string, patch: Partial<Omit<Group, 'id' | 'layout'>>) => void
  updateGroupLayout: (id: string, layout: GroupLayout) => void
  setMirror: (patch: Partial<MirrorSettings>) => void
  setPlate: (patch: Partial<PlateSettings>) => void

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

/** Regenerate a column-layout group's keys from its layout definition. Keys
 * keep their identity (and label/type tweaks) via their col/row slot. */
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
      result.push({ ...existing, x: slot.x, y: slot.y, r: slot.r })
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

// ---- Persistence ----------------------------------------------------------

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
    }
  } catch {
    return null
  }
}

// ---- Store ----------------------------------------------------------------

let transformSnapshot: Doc | null = null

const docOf = (s: Doc): Doc => ({ keys: s.keys, groups: s.groups, mirror: s.mirror, plate: s.plate })

export const useDocStore = create<DocState>((set, get) => {
  const commit = (patch: Partial<Doc>) => {
    const state = get()
    const prev = docOf(state)
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
    const alive = new Set(keys.map((k) => k.id))
    set({
      keys,
      groups,
      mirror: patch.mirror ?? state.mirror,
      plate: patch.plate ?? state.plate,
      past: [...state.past.slice(-MAX_HISTORY + 1), prev],
      future: [],
      selection: new Set([...state.selection].filter((id) => alive.has(id))),
    })
  }

  return {
    ...(loadSaved() ?? defaultDoc()),
    selection: new Set(),
    past: [],
    future: [],
    snapStep: U / 4,

    setSnapStep: (step) => set({ snapStep: step }),
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
      let minX = 0
      for (const k of state.keys) {
        const wx = keyWorldXF(k, groups).x
        maxX = Math.max(maxX, wx)
        minX = Math.min(minX, wx)
      }
      // Keep clear of the mirrored half too.
      if (state.mirror.enabled) maxX = Math.max(maxX, 2 * state.mirror.axis - minX)
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

    updateSelected: (patch) => {
      const { keys, selection } = get()
      if (selection.size === 0) return
      commit({
        keys: keys.map((k) => (selection.has(k.id) ? { ...k, ...patch } : k)),
      })
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
      commit({
        keys: regenerateGroup(updated, state.keys),
        groups: state.groups.map((g) => (g.id === id ? updated : g)),
      })
    },

    setMirror: (patch) => {
      commit({ mirror: { ...get().mirror, ...patch } })
    },

    setPlate: (patch) => {
      commit({ plate: { ...get().plate, ...patch } })
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
      set({ past: [...now.past.slice(-MAX_HISTORY + 1), snapshot], future: [] })
    },

    undo: () => {
      const state = get()
      const prev = state.past.at(-1)
      if (!prev) return
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
    state.plate === prev.plate
  )
    return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 3,
          keys: state.keys,
          groups: state.groups,
          mirror: state.mirror,
          plate: state.plate,
        }),
      )
    } catch {
      // Storage full or unavailable — autosave is best-effort.
    }
  }, 400)
})
