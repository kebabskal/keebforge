import { useEffect, useState } from 'react'
import {
  keyWorldXF,
  type Group,
  type GroupLayout,
  type Key,
  type KeyType,
} from '../model/keys'
import { groupMap, useDocStore } from '../model/store'
import { FOAM_CLEARANCE, plateWithCutouts } from '../model/outline'
import { downloadText, toDXF } from '../export/dxf'

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

function GroupPanel({ group }: { group: Group }) {
  const updateGroup = useDocStore((s) => s.updateGroup)
  const updateGroupLayout = useDocStore((s) => s.updateGroupLayout)
  const ungroupSelection = useDocStore((s) => s.ungroupSelection)
  const layout = group.layout

  const patchLayout = (patch: Partial<Extract<GroupLayout, { kind: 'columns' }>>) => {
    if (layout.kind !== 'columns') return
    updateGroupLayout(group.id, { ...layout, ...patch })
  }

  const setColumnCount = (count: number) => {
    if (layout.kind !== 'columns') return
    const n = Math.max(1, Math.min(12, Math.round(count)))
    const columns = layout.columns.slice(0, n)
    while (columns.length < n) {
      columns.push({ ...(columns.at(-1) ?? { stagger: 0, splay: 0 }) })
    }
    patchLayout({ columns })
  }

  return (
    <>
      <h3>Group</h3>
      <div className="field-grid">
        <TextField
          label="Name"
          value={group.name}
          onCommit={(name) => updateGroup(group.id, { name })}
        />
        <NumberField
          label="Rotation (°)"
          value={group.r}
          step={5}
          onCommit={(r) => updateGroup(group.id, { r })}
        />
        <NumberField
          label="X (mm)"
          value={group.x}
          step={1}
          onCommit={(x) => updateGroup(group.id, { x })}
        />
        <NumberField
          label="Y (mm)"
          value={group.y}
          step={1}
          onCommit={(y) => updateGroup(group.id, { y })}
        />
      </div>
      {layout.kind === 'columns' && (
        <>
          <h3>Column layout</h3>
          <div className="field-grid">
            <NumberField
              label="Rows"
              value={layout.rows}
              step={1}
              onCommit={(rows) =>
                patchLayout({ rows: Math.max(1, Math.min(8, Math.round(rows))) })
              }
            />
            <NumberField
              label="Columns"
              value={layout.columns.length}
              step={1}
              onCommit={setColumnCount}
            />
            <label className="field">
              <span>Switch</span>
              <select
                value={layout.keyType}
                onChange={(e) => patchLayout({ keyType: e.target.value as KeyType })}
              >
                <option value="mx">MX</option>
                <option value="choc">Choc</option>
              </select>
            </label>
          </div>
          <div className="column-table">
            <div className="column-row column-head">
              <span>Col</span>
              <span>Stagger</span>
              <span>Splay</span>
            </div>
            {layout.columns.map((col, i) => (
              <div className="column-row" key={i}>
                <span>{i + 1}</span>
                <NumberField
                  label=""
                  value={col.stagger}
                  step={0.5}
                  onCommit={(stagger) =>
                    patchLayout({
                      columns: layout.columns.map((c, j) =>
                        j === i ? { ...c, stagger } : c,
                      ),
                    })
                  }
                />
                <NumberField
                  label=""
                  value={col.splay}
                  step={1}
                  onCommit={(splay) =>
                    patchLayout({
                      columns: layout.columns.map((c, j) =>
                        j === i ? { ...c, splay } : c,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>
          <p className="hint">
            Stagger is the column's vertical offset (mm); splay rotates the
            column about its top key (°). Layout changes regenerate key
            positions.
          </p>
        </>
      )}
      <button className="wide" onClick={ungroupSelection}>
        Ungroup
      </button>
    </>
  )
}

function DocumentPanel() {
  const mirror = useDocStore((s) => s.mirror)
  const setMirror = useDocStore((s) => s.setMirror)
  const plate = useDocStore((s) => s.plate)
  const setPlate = useDocStore((s) => s.setPlate)
  const keyCount = useDocStore((s) => s.keys.length)

  const exportDXF = (clearance: number, filename: string) => {
    const { keys, groups, mirror, plate } = useDocStore.getState()
    const shapes = plateWithCutouts({ keys, groups, mirror, plate }, clearance)
    downloadText(filename, toDXF(shapes))
  }

  return (
    <>
      <h2>Document</h2>
      <p className="hint">
        {keyCount} keys{mirror.enabled ? ` (${keyCount * 2} with mirror)` : ''}
      </p>
      <div className="field-grid">
        <label className="field field-check">
          <span>Mirror</span>
          <input
            type="checkbox"
            checked={mirror.enabled}
            onChange={(e) => setMirror({ enabled: e.target.checked })}
          />
        </label>
        <NumberField
          label="Axis X (mm)"
          value={mirror.axis}
          step={1}
          onCommit={(axis) => setMirror({ axis })}
        />
      </div>
      <h3>Plate &amp; foam</h3>
      <div className="field-grid">
        <NumberField
          label="Edge padding (mm)"
          value={plate.padding}
          step={0.5}
          onCommit={(padding) => setPlate({ padding: Math.max(0, padding) })}
        />
      </div>
      <p className="hint">
        The plate is the union of all key areas plus padding, with per-switch
        cutouts (14 mm MX, 13.8 mm Choc). Foam adds {FOAM_CLEARANCE} mm cutout
        clearance. Check the 3D view, then export for CAD:
      </p>
      <div className="button-row">
        <button onClick={() => exportDXF(0, 'keebforge-plate.dxf')}>Plate DXF</button>
        <button onClick={() => exportDXF(FOAM_CLEARANCE, 'keebforge-foam.dxf')}>
          Foam DXF
        </button>
      </div>
      <h3>Shortcuts</h3>
      <ul className="hint">
        <li>Click — select key's group; <kbd>Alt</kbd>-click — single key</li>
        <li><kbd>Ctrl+G</kbd> / <kbd>Ctrl+Shift+G</kbd> — group / ungroup</li>
        <li><kbd>R</kbd> / <kbd>Shift+R</kbd> — rotate ±15°</li>
        <li><kbd>Arrows</kbd> — nudge (Shift for 0.1 mm)</li>
        <li><kbd>Del</kbd> — delete selection</li>
        <li><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Shift+Z</kbd> — undo / redo</li>
        <li><kbd>Space</kbd>-drag, middle or right drag — pan</li>
        <li>Scroll — zoom</li>
      </ul>
    </>
  )
}

export function Inspector() {
  const keys = useDocStore((s) => s.keys)
  const groups = useDocStore((s) => s.groups)
  const selection = useDocStore((s) => s.selection)
  const updateSelected = useDocStore((s) => s.updateSelected)
  const updateSelectedWorld = useDocStore((s) => s.updateSelectedWorld)

  const selected = keys.filter((k) => selection.has(k.id))
  const primary: Key | undefined = selected[0]

  if (!primary) {
    return (
      <aside className="inspector">
        <DocumentPanel />
      </aside>
    )
  }

  const gmap = groupMap(groups)
  const world = keyWorldXF(primary, gmap)
  const sharedGroupId = selected.every((k) => k.groupId === primary.groupId)
    ? primary.groupId
    : null
  const sharedGroup = sharedGroupId ? gmap.get(sharedGroupId) : undefined

  return (
    <aside className="inspector">
      <h2>
        {selected.length === 1 ? '1 key' : `${selected.length} keys`} selected
      </h2>
      <div className="field-grid">
        <NumberField
          label="X (mm)"
          value={world.x}
          step={0.5}
          onCommit={(x) => updateSelectedWorld({ x })}
        />
        <NumberField
          label="Y (mm)"
          value={world.y}
          step={0.5}
          onCommit={(y) => updateSelectedWorld({ y })}
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
      {sharedGroup && <GroupPanel group={sharedGroup} />}
    </aside>
  )
}
