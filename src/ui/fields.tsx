import { useEffect, useRef, useState, type ReactNode } from 'react'
import { coalesceUndo } from '../model/store'

const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

let editSession = 0
const newSession = () => `edit${++editSession}`

/** Numeric field that commits live on every edit. Commits from one focus
 * session share an undo-coalescing key, so typing a value is a single undo
 * step instead of one per keystroke. */
export function NumberField(props: {
  label: string
  value: number
  step: number
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(fmt(props.value))
  const session = useRef('')
  // Sync from external changes (undo, drags), but leave the text alone while
  // it still parses to the current value so typing "5." isn't clobbered.
  useEffect(() => {
    setText((t) => (Number(t) === props.value ? t : fmt(props.value)))
  }, [props.value])

  const commit = (raw: string) => {
    if (raw.trim() === '') return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed === props.value) return
    if (!session.current) session.current = newSession()
    coalesceUndo(session.current, () => props.onCommit(parsed))
  }

  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step}
        value={text}
        onFocus={() => {
          session.current = newSession()
        }}
        onChange={(e) => {
          setText(e.target.value)
          commit(e.target.value)
        }}
        onBlur={() => setText(fmt(props.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

/** Range slider with a live value readout. Commits on every input; one
 * drag/scrub (or keyboard adjustment burst) coalesces into one undo step. */
export function SliderField(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** Unit suffix for the readout, e.g. "mm" or "°". */
  unit?: string
  onCommit: (value: number) => void
}) {
  const session = useRef('')
  return (
    <label className="field field-slider">
      <span>
        {props.label}
        <em>
          {fmt(props.value)}
          {props.unit ?? ''}
        </em>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onPointerDown={() => {
          session.current = newSession()
        }}
        onFocus={() => {
          session.current = newSession()
        }}
        onChange={(e) => {
          const value = Number(e.target.value)
          if (!session.current) session.current = newSession()
          coalesceUndo(session.current, () => props.onCommit(value))
        }}
      />
    </label>
  )
}

export function TextField(props: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  const [text, setText] = useState(props.value)
  const session = useRef('')
  useEffect(() => setText(props.value), [props.value])
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="text"
        value={text}
        onFocus={() => {
          session.current = newSession()
        }}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value !== props.value) {
            if (!session.current) session.current = newSession()
            const value = e.target.value
            coalesceUndo(session.current, () => props.onCommit(value))
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

export function ColorField(props: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="color"
        value={props.value}
        onChange={(e) => {
          const value = e.target.value
          // One undo step per field while scrubbing the picker.
          coalesceUndo(`color-${props.label}`, () => props.onCommit(value))
        }}
      />
    </label>
  )
}

// ---- Collapsible panels ---------------------------------------------------

const PANEL_KEY = 'keebforge.panels.v1'

let panelState: Record<string, boolean> = {}
try {
  panelState = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}')
} catch {
  panelState = {}
}
function savePanelState() {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panelState))
  } catch {
    // best-effort persistence
  }
}

/** Collapsible inspector panel. Open state persists per browser under the
 * given id. */
export function Section(props: {
  id: string
  title: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(panelState[props.id] ?? props.defaultOpen ?? true)
  return (
    <section className="panel">
      <button
        type="button"
        className="panel-head"
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          panelState[props.id] = next
          savePanelState()
        }}
      >
        <span className={`panel-chev${open ? ' open' : ''}`}>▸</span>
        {props.title}
      </button>
      {open && <div className="panel-body">{props.children}</div>}
    </section>
  )
}
