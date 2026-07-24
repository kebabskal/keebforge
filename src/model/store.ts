import { create } from 'zustand'
import { defaultKeys, makeKey, U, type Key, type KeyType } from './keys'

const STORAGE_KEY = 'keebforge.doc.v1'
const MAX_HISTORY = 200

export interface DocState {
  keys: Key[]
  selection: Set<string>
  past: Key[][]
  future: Key[][]
  /** Position snap step in mm; 0 disables snapping. */
  snapStep: number

  setSnapStep: (step: number) => void
  setSelection: (ids: Iterable<string>) => void
  addToSelection: (ids: Iterable<string>) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  selectAll: () => void

  /** Apply a committed (undoable) change to the key list. */
  edit: (fn: (keys: Key[]) => Key[]) => void
  addKey: (type: KeyType) => void
  deleteSelected: () => void
  updateSelected: (patch: Partial<Omit<Key, 'id'>>) => void
  rotateSelected: (deg: number) => void
  nudgeSelected: (dx: number, dy: number) => void

  /** Transient transform: begin snapshots the doc, transform applies patches
   * relative to that snapshot (so drags don't accumulate error), end commits
   * the whole gesture as one undo step. */
  beginTransform: () => void
  transform: (patches: Map<string, Partial<Key>>) => void
  endTransform: () => void

  undo: () => void
  redo: () => void
  loadDoc: (keys: Key[]) => void
}

function loadSaved(): Key[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.keys)) return null
    return parsed.keys as Key[]
  } catch {
    return null
  }
}

let transformSnapshot: Key[] | null = null

export const useDocStore = create<DocState>((set, get) => {
  const commit = (keys: Key[]) => {
    const { keys: prev, past } = get()
    set({
      keys,
      past: [...past.slice(-MAX_HISTORY + 1), prev],
      future: [],
    })
  }

  return {
    keys: loadSaved() ?? defaultKeys(),
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
    toggleSelected: (id) => {
      const selection = new Set(get().selection)
      if (selection.has(id)) selection.delete(id)
      else selection.add(id)
      set({ selection })
    },
    clearSelection: () => set({ selection: new Set() }),
    selectAll: () => set({ selection: new Set(get().keys.map((k) => k.id)) }),

    edit: (fn) => commit(fn(get().keys)),

    addKey: (type) => {
      const { keys, selection } = get()
      const anchor =
        keys.filter((k) => selection.has(k.id)).at(-1) ?? keys.at(-1)
      const key = anchor
        ? makeKey(type, anchor.x + U, anchor.y)
        : makeKey(type, 0, 0)
      commit([...keys, key])
      set({ selection: new Set([key.id]) })
    },

    deleteSelected: () => {
      const { keys, selection } = get()
      if (selection.size === 0) return
      commit(keys.filter((k) => !selection.has(k.id)))
      set({ selection: new Set() })
    },

    updateSelected: (patch) => {
      const { keys, selection } = get()
      if (selection.size === 0) return
      commit(keys.map((k) => (selection.has(k.id) ? { ...k, ...patch } : k)))
    },

    rotateSelected: (deg) => {
      const { keys, selection } = get()
      if (selection.size === 0) return
      commit(
        keys.map((k) =>
          selection.has(k.id) ? { ...k, r: Math.round((k.r + deg) * 100) / 100 } : k,
        ),
      )
    },

    nudgeSelected: (dx, dy) => {
      const { keys, selection } = get()
      if (selection.size === 0) return
      commit(
        keys.map((k) =>
          selection.has(k.id) ? { ...k, x: k.x + dx, y: k.y + dy } : k,
        ),
      )
    },

    beginTransform: () => {
      transformSnapshot = get().keys
    },
    transform: (patches) => {
      if (!transformSnapshot) return
      set({
        keys: transformSnapshot.map((k) => {
          const patch = patches.get(k.id)
          return patch ? { ...k, ...patch } : k
        }),
      })
    },
    endTransform: () => {
      const snapshot = transformSnapshot
      transformSnapshot = null
      if (!snapshot || snapshot === get().keys) return
      const { past } = get()
      set({ past: [...past.slice(-MAX_HISTORY + 1), snapshot], future: [] })
    },

    undo: () => {
      const { keys, past, future } = get()
      const prev = past.at(-1)
      if (!prev) return
      set({
        keys: prev,
        past: past.slice(0, -1),
        future: [keys, ...future],
        selection: new Set(
          [...get().selection].filter((id) => prev.some((k) => k.id === id)),
        ),
      })
    },
    redo: () => {
      const { keys, past, future } = get()
      const next = future[0]
      if (!next) return
      set({
        keys: next,
        past: [...past, keys],
        future: future.slice(1),
        selection: new Set(
          [...get().selection].filter((id) => next.some((k) => k.id === id)),
        ),
      })
    },

    loadDoc: (keys) => {
      commit(keys)
      set({ selection: new Set() })
    },
  }
})

// Autosave to localStorage, debounced.
let saveTimer: ReturnType<typeof setTimeout> | undefined
useDocStore.subscribe((state, prev) => {
  if (state.keys === prev.keys) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, keys: state.keys }))
    } catch {
      // Storage full or unavailable — autosave is best-effort.
    }
  }, 400)
})
