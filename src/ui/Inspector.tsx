import { useEffect, useState } from 'react'
import type { Key, KeyType } from '../model/keys'
import { useDocStore } from '../model/store'

const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

/** Numeric field that commits on blur/Enter so typing doesn't spam undo history. */
function NumberField(props: {
  label: string
  value: number
  step: number
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(fmt(props.value))
  useEffect(() => setText(fmt(props.value)), [props.value])

  const commit = () => {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && parsed !== props.value) props.onCommit(parsed)
    else setText(fmt(props.value))
  }

  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function TextField(props: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  const [text, setText] = useState(props.value)
  useEffect(() => setText(props.value), [props.value])
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== props.value) props.onCommit(text)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

export function Inspector() {
  const keys = useDocStore((s) => s.keys)
  const selection = useDocStore((s) => s.selection)
  const updateSelected = useDocStore((s) => s.updateSelected)

  const selected = keys.filter((k) => selection.has(k.id))
  const primary: Key | undefined = selected[0]

  if (!primary) {
    return (
      <aside className="inspector">
        <h2>Inspector</h2>
        <p className="hint">
          Click a key to select it. Drag to move, <kbd>R</kbd> to rotate,
          shift-click or drag on empty space for multi-select.
        </p>
        <h3>Shortcuts</h3>
        <ul className="hint">
          <li><kbd>R</kbd> / <kbd>Shift+R</kbd> — rotate ±15°</li>
          <li><kbd>Arrows</kbd> — nudge (Shift for 0.1 mm)</li>
          <li><kbd>Del</kbd> — delete selection</li>
          <li><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Shift+Z</kbd> — undo / redo</li>
          <li><kbd>Space</kbd>-drag, middle or right drag — pan</li>
          <li>Scroll — zoom</li>
        </ul>
      </aside>
    )
  }

  return (
    <aside className="inspector">
      <h2>
        {selected.length === 1 ? '1 key' : `${selected.length} keys`} selected
      </h2>
      <div className="field-grid">
        <NumberField
          label="X (mm)"
          value={primary.x}
          step={0.5}
          onCommit={(x) => updateSelected({ x })}
        />
        <NumberField
          label="Y (mm)"
          value={primary.y}
          step={0.5}
          onCommit={(y) => updateSelected({ y })}
        />
        <NumberField
          label="Rotation (°)"
          value={primary.r}
          step={5}
          onCommit={(r) => updateSelected({ r })}
        />
        <label className="field">
          <span>Switch</span>
          <select
            value={primary.type}
            onChange={(e) => updateSelected({ type: e.target.value as KeyType })}
          >
            <option value="mx">MX</option>
            <option value="choc">Choc</option>
          </select>
        </label>
        <NumberField
          label="Width (u)"
          value={primary.w}
          step={0.25}
          onCommit={(w) => updateSelected({ w: Math.max(0.25, w) })}
        />
        <NumberField
          label="Height (u)"
          value={primary.h}
          step={0.25}
          onCommit={(h) => updateSelected({ h: Math.max(0.25, h) })}
        />
        <TextField
          label="Label"
          value={primary.label}
          onCommit={(label) => updateSelected({ label })}
        />
      </div>
      {selected.length > 1 && (
        <p className="hint">
          Values show the first selected key; edits apply to all selected keys.
        </p>
      )}
    </aside>
  )
}
