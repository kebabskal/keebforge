import { useRef } from 'react'
import { U, type Key } from '../model/keys'
import { useDocStore } from '../model/store'

const SNAP_OPTIONS = [
  { label: 'Snap: off', value: 0 },
  { label: 'Snap: 0.1 mm', value: 0.1 },
  { label: 'Snap: 1 mm', value: 1 },
  { label: 'Snap: ¼u', value: U / 4 },
  { label: 'Snap: ½u', value: U / 2 },
  { label: 'Snap: 1u', value: U },
]

export function Toolbar() {
  const addKey = useDocStore((s) => s.addKey)
  const deleteSelected = useDocStore((s) => s.deleteSelected)
  const undo = useDocStore((s) => s.undo)
  const redo = useDocStore((s) => s.redo)
  const canUndo = useDocStore((s) => s.past.length > 0)
  const canRedo = useDocStore((s) => s.future.length > 0)
  const hasSelection = useDocStore((s) => s.selection.size > 0)
  const snapStep = useDocStore((s) => s.snapStep)
  const setSnapStep = useDocStore((s) => s.setSnapStep)
  const fileRef = useRef<HTMLInputElement>(null)

  const exportJson = () => {
    const { keys } = useDocStore.getState()
    const blob = new Blob([JSON.stringify({ version: 1, keys }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'keebforge-layout.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text())
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
      useDocStore.getState().loadDoc(keys)
    } catch (err) {
      alert(`Could not import layout: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <div className="toolbar">
      <button onClick={() => addKey('mx')}>+ MX key</button>
      <button onClick={() => addKey('choc')}>+ Choc key</button>
      <button onClick={deleteSelected} disabled={!hasSelection}>
        Delete
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
      <span className="toolbar-sep" />
      <button onClick={exportJson}>Export</button>
      <button onClick={() => fileRef.current?.click()}>Import</button>
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
