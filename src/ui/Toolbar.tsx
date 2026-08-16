import { useRef, useState } from 'react'
import { deleteFile, listFiles, loadFile, saveFile } from '../model/files'
import { U, type Doc, type Key } from '../model/keys'
import { docOf, normalizeMaterials, useDocStore } from '../model/store'

const SNAP_OPTIONS = [
  { label: 'Snap: off', value: 0 },
  { label: 'Snap: 0.1 mm', value: 0.1 },
  { label: 'Snap: 1 mm', value: 1 },
  { label: 'Snap: ¼u', value: U / 4 },
  { label: 'Snap: ½u', value: U / 2 },
  { label: 'Snap: 1u', value: U },
]

const CURRENT_FILE_KEY = 'keebforge.file'

/** Current document in the export/save JSON shape.
 *
 * Everything the store treats as part of the document, and nothing else —
 * `docOf` is the list, so a setting group added there cannot be forgotten
 * here. Mounting and the controller were, and a board saved with a Pro Micro
 * in it came back empty. */
function serializeDoc() {
  return { version: 6, ...docOf(useDocStore.getState()) }
}

/** Validate and load a parsed layout; throws on malformed input. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyParsedDoc(parsed: any) {
  const keys = Array.isArray(parsed) ? parsed : parsed.keys
  if (!Array.isArray(keys)) throw new Error('no keys array')
  const valid = keys.every(
    (k: Key) =>
      typeof k.id === 'string' &&
      (k.type === 'mx' || k.type === 'choc') &&
      typeof k.x === 'number' &&
      typeof k.y === 'number',
  )
  if (!valid) throw new Error('malformed keys')
  useDocStore.getState().loadDoc({
    keys,
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    mirror:
      parsed.mirror && typeof parsed.mirror.axis === 'number'
        ? parsed.mirror
        : undefined,
    plate:
      parsed.plate && typeof parsed.plate.padding === 'number'
        ? parsed.plate
        : undefined,
    bezel:
      parsed.bezel && typeof parsed.bezel.width === 'number'
        ? parsed.bezel
        : undefined,
    bottom: parsed.bottom,
    mounting: parsed.mounting,
    controller: parsed.controller,
    tilt: typeof parsed.tilt === 'number' ? parsed.tilt : undefined,
    materials: normalizeMaterials(parsed.materials, parsed.colors),
  } as Partial<Doc>)
}

export function Toolbar() {
  const addKey = useDocStore((s) => s.addKey)
  const addColumnCluster = useDocStore((s) => s.addColumnCluster)
  const deleteSelected = useDocStore((s) => s.deleteSelected)
  const groupSelection = useDocStore((s) => s.groupSelection)
  const ungroupSelection = useDocStore((s) => s.ungroupSelection)
  const undo = useDocStore((s) => s.undo)
  const redo = useDocStore((s) => s.redo)
  const canUndo = useDocStore((s) => s.past.length > 0)
  const canRedo = useDocStore((s) => s.future.length > 0)
  const snapStep = useDocStore((s) => s.snapStep)
  const setSnapStep = useDocStore((s) => s.setSnapStep)
  const mirrorEnabled = useDocStore((s) => s.mirror.enabled)
  const setMirror = useDocStore((s) => s.setMirror)

  const hasSelection = useDocStore((s) => s.selection.size > 0)
  const canGroup = useDocStore(
    (s) =>
      s.selection.size >= 2 &&
      s.keys.every((k) => !s.selection.has(k.id) || !k.groupId),
  )
  const canUngroup = useDocStore((s) =>
    s.keys.some((k) => s.selection.has(k.id) && k.groupId),
  )

  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState(listFiles)
  const [fileName, setFileName] = useState(
    () => localStorage.getItem(CURRENT_FILE_KEY) ?? '',
  )

  const rememberName = (name: string) => {
    setFileName(name)
    try {
      localStorage.setItem(CURRENT_FILE_KEY, name)
    } catch {
      // best-effort persistence
    }
  }

  const saveNamed = () => {
    const name = window.prompt('Save layout as:', fileName || 'my-keyboard')?.trim()
    if (!name) return
    saveFile(name, serializeDoc())
    rememberName(name)
    setFiles(listFiles())
  }

  const loadNamed = (name: string) => {
    if (!name) return
    const parsed = loadFile(name)
    if (!parsed) return
    try {
      applyParsedDoc(parsed)
      rememberName(name)
    } catch (err) {
      alert(`Could not load "${name}": ${err instanceof Error ? err.message : err}`)
    }
  }

  const deleteNamed = () => {
    if (!fileName || !files.includes(fileName)) return
    if (!window.confirm(`Delete saved layout "${fileName}"?`)) return
    deleteFile(fileName)
    rememberName('')
    setFiles(listFiles())
  }

  const clearBoard = () => {
    useDocStore.getState().loadDoc({})
    rememberName('')
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(serializeDoc(), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName || 'keebforge-layout'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importJson = async (file: File) => {
    try {
      applyParsedDoc(JSON.parse(await file.text()))
      rememberName(file.name.replace(/\.json$/i, ''))
    } catch (err) {
      alert(`Could not import layout: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <div className="toolbar">
      <button onClick={() => addKey('mx')}>+ MX</button>
      <button onClick={() => addKey('choc')}>+ Choc</button>
      <button onClick={addColumnCluster} title="Add a column-staggered cluster">
        + Cluster
      </button>
      <button onClick={deleteSelected} disabled={!hasSelection}>
        Delete
      </button>
      <span className="toolbar-sep" />
      <button onClick={groupSelection} disabled={!canGroup} title="Ctrl+G">
        Group
      </button>
      <button onClick={ungroupSelection} disabled={!canUngroup} title="Ctrl+Shift+G">
        Ungroup
      </button>
      <span className="toolbar-sep" />
      <button onClick={undo} disabled={!canUndo} title="Ctrl+Z">
        Undo
      </button>
      <button onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">
        Redo
      </button>
      <span className="toolbar-sep" />
      <select
        value={snapStep}
        onChange={(e) => setSnapStep(Number(e.target.value))}
        title="Position snapping for drag and arrow keys"
      >
        {SNAP_OPTIONS.map((o) => (
          <option key={o.label} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        className={mirrorEnabled ? 'active' : ''}
        onClick={() => setMirror({ enabled: !mirrorEnabled })}
        title="Live mirror preview for split layouts"
      >
        Mirror
      </button>
      <span className="toolbar-sep" />
      <select
        value={files.includes(fileName) ? fileName : ''}
        onChange={(e) => loadNamed(e.target.value)}
        title="Load a layout saved in this browser"
      >
        {!files.includes(fileName) && <option value="">— layouts —</option>}
        {files.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <button onClick={saveNamed} title="Save the layout under a name in this browser">
        Save
      </button>
      <button
        onClick={deleteNamed}
        disabled={!fileName || !files.includes(fileName)}
        title="Delete the current saved layout"
      >
        🗑
      </button>
      <button onClick={clearBoard} title="Start an empty board (undoable)">
        Clear
      </button>
      <span className="toolbar-sep" />
      <button onClick={exportJson} title="Download the layout as a JSON file">
        Export
      </button>
      <button onClick={() => fileRef.current?.click()} title="Load a layout JSON file">
        Import
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) importJson(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
