import { useEffect, useRef, useState } from 'react'
import {
  isKeyMirrored,
  keyWorldXF,
  type Group,
  type GroupLayout,
  type Key,
  type KeyType,
} from '../model/keys'
import { alignmentItems, coalesceUndo, groupMap, useDocStore } from '../model/store'
import { useViewSettings } from '../preview/viewSettings'
import { bezelShape, FOAM_CLEARANCE, plateWithCutouts } from '../model/outline'
import { downloadText, toDXF } from '../export/dxf'

const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

let editSession = 0

/** Numeric field that commits live on every edit. Commits from one focus
 * session share an undo-coalescing key, so typing a value is a single undo
 * step instead of one per keystroke. */
function NumberField(props: {
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
    if (!session.current) session.current = `edit${++editSession}`
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
          session.current = `edit${++editSession}`
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

function TextField(props: {
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
          session.current = `edit${++editSession}`
        }}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value !== props.value) {
            if (!session.current) session.current = `edit${++editSession}`
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

function ColorField(props: {
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
        <label className="field field-check">
          <span>Mirror</span>
          <input
            type="checkbox"
            checked={group.mirror !== false}
            onChange={(e) => updateGroup(group.id, { mirror: e.target.checked })}
          />
        </label>
      </div>
      {layout.kind !== 'columns' && (
        <>
          <h3>Auto layout</h3>
          <div className="field-grid">
            <label className="field">
              <span>Layout</span>
              <select
                value={layout.kind === 'stack' ? `stack-${layout.axis}` : 'free'}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'free') updateGroupLayout(group.id, { kind: 'free' })
                  else
                    updateGroupLayout(group.id, {
                      kind: 'stack',
                      axis: v === 'stack-x' ? 'x' : 'y',
                      gap: layout.kind === 'stack' ? layout.gap : 0,
                    })
                }}
              >
                <option value="free">Free</option>
                <option value="stack-x">Stack X (row)</option>
                <option value="stack-y">Stack Y (column)</option>
              </select>
            </label>
            {layout.kind === 'stack' && (
              <NumberField
                label="Gap (mm)"
                value={layout.gap}
                step={0.5}
                onCommit={(gap) => updateGroupLayout(group.id, { ...layout, gap })}
              />
            )}
          </div>
          {layout.kind === 'stack' && (
            <p className="hint">
              Keys pack along the {layout.axis === 'x' ? 'row' : 'column'} in
              order, each taking up its own size. Drag a key within the stack
              to reorder; resizing re-packs automatically.
            </p>
          )}
        </>
      )}
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
            column relative to the previous one (°) and carries over, fanning
            the columns that follow. Layout changes regenerate key positions.
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
  const bezel = useDocStore((s) => s.bezel)
  const setBezel = useDocStore((s) => s.setBezel)
  const tilt = useDocStore((s) => s.tilt)
  const setTilt = useDocStore((s) => s.setTilt)
  const colors = useDocStore((s) => s.colors)
  const setColors = useDocStore((s) => s.setColors)
  const view = useViewSettings()
  const keyCount = useDocStore((s) => s.keys.length)
  const mirroredCount = useDocStore((s) =>
    s.mirror.enabled
      ? s.keys.filter((k) => isKeyMirrored(k, groupMap(s.groups))).length
      : 0,
  )

  const exportDXF = (clearance: number, filename: string) => {
    const { keys, groups, mirror, plate, bezel, tilt, colors } = useDocStore.getState()
    const shapes = plateWithCutouts(
      { keys, groups, mirror, plate, bezel, tilt, colors },
      clearance,
    )
    downloadText(filename, toDXF(shapes))
  }

  return (
    <>
      <h2>Document</h2>
      <p className="hint">
        {keyCount} keys
        {mirror.enabled ? ` (${keyCount + mirroredCount} with mirror)` : ''}
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
        <NumberField
          label="Tilt (°)"
          value={tilt}
          step={1}
          onCommit={setTilt}
        />
      </div>
      <p className="hint">
        Tilt is the typing angle shown in 3D: positive raises the back edge,
        pivoting on the front.
      </p>
      <h3>Plate &amp; foam</h3>
      <div className="field-grid">
        <NumberField
          label="Edge padding (mm)"
          value={plate.padding}
          step={0.5}
          onCommit={(padding) => setPlate({ padding: Math.max(0, padding) })}
        />
      </div>
      <h3>Bezel</h3>
      <div className="field-grid">
        <label className="field field-check">
          <span>Enabled</span>
          <input
            type="checkbox"
            checked={bezel.enabled}
            onChange={(e) => setBezel({ enabled: e.target.checked })}
          />
        </label>
        <label className="field">
          <span>Mode</span>
          <select
            value={bezel.mode}
            onChange={(e) => setBezel({ mode: e.target.value as 'box' | 'tight' })}
          >
            <option value="tight">Tight</option>
            <option value="box">Box</option>
          </select>
        </label>
        <NumberField
          label="Width (mm)"
          value={bezel.width}
          step={0.5}
          onCommit={(width) => setBezel({ width: Math.max(0, width) })}
        />
        <NumberField
          label="Outset (mm)"
          value={bezel.outset}
          step={0.25}
          onCommit={(outset) => setBezel({ outset: Math.max(0, outset) })}
        />
        <NumberField
          label="Height (mm)"
          value={bezel.height}
          step={0.5}
          onCommit={(height) => setBezel({ height: Math.max(0, height) })}
        />
        <NumberField
          label="Outer radius (mm)"
          value={bezel.radiusOuter}
          step={0.5}
          onCommit={(radiusOuter) => setBezel({ radiusOuter: Math.max(0, radiusOuter) })}
        />
        <NumberField
          label="Inner radius (mm)"
          value={bezel.radiusInner}
          step={0.5}
          onCommit={(radiusInner) => setBezel({ radiusInner: Math.max(0, radiusInner) })}
        />
        <NumberField
          label="Bevel (mm)"
          value={bezel.bevel}
          step={0.25}
          onCommit={(bevel) => setBezel({ bevel: Math.max(0, bevel) })}
        />
      </div>
      <p className="hint">
        A rim around the keycap opening: tight follows the keycap contour, box
        is a rectangular frame. Outset is the gap around keycaps, height is
        above the plate top.
      </p>
      <h3>Colors</h3>
      <div className="field-grid">
        <ColorField
          label="Case"
          value={colors.case}
          onCommit={(v) => setColors({ case: v })}
        />
        <ColorField
          label="Caps"
          value={colors.cap}
          onCommit={(v) => setColors({ cap: v })}
        />
        <ColorField
          label="Accent caps"
          value={colors.capAccent}
          onCommit={(v) => setColors({ capAccent: v })}
        />
      </div>
      <p className="hint">Unlabeled keys use the accent color.</p>
      <h3>3D view</h3>
      <div className="field-grid">
        <NumberField
          label="Camera FOV (°)"
          value={view.fov}
          step={5}
          onCommit={(fov) => view.update({ fov: Math.min(100, Math.max(10, fov)) })}
        />
        <label className="field">
          <span>Backdrop</span>
          <select
            value={view.backdrop}
            onChange={(e) =>
              view.update({ backdrop: e.target.value as 'table' | 'studio' })
            }
          >
            <option value="table">Table</option>
            <option value="studio">Studio</option>
          </select>
        </label>
        <ColorField
          label="Backdrop color"
          value={view.backdropColor}
          onCommit={(backdropColor) => view.update({ backdropColor })}
        />
        <NumberField
          label="Light angle (°)"
          value={view.lightAngle}
          step={15}
          onCommit={(lightAngle) => view.update({ lightAngle })}
        />
        <NumberField
          label="Key light"
          value={view.keyLight}
          step={0.2}
          onCommit={(keyLight) => view.update({ keyLight: Math.max(0, keyLight) })}
        />
        <NumberField
          label="Fill light"
          value={view.fillLight}
          step={0.1}
          onCommit={(fillLight) => view.update({ fillLight: Math.max(0, fillLight) })}
        />
        <NumberField
          label="Ambient"
          value={view.ambient}
          step={0.1}
          onCommit={(ambient) => view.update({ ambient: Math.max(0, ambient) })}
        />
      </div>
      <p className="hint">
        Camera and lighting are per-browser view settings; colors are part of
        the document.
      </p>
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
        <button
          disabled={!bezel.enabled}
          onClick={() => {
            const doc = useDocStore.getState()
            downloadText('keebforge-bezel.dxf', toDXF(bezelShape(doc)))
          }}
        >
          Bezel DXF
        </button>
      </div>
      <h3>Shortcuts</h3>
      <ul className="hint">
        <li>Click — select key's group; <kbd>Alt</kbd>-click — single key</li>
        <li><kbd>Ctrl+G</kbd> / <kbd>Ctrl+Shift+G</kbd> — group / ungroup</li>
        <li><kbd>Ctrl+D</kbd> — duplicate selection</li>
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
  const alignSelected = useDocStore((s) => s.alignSelected)
  const distributeSelected = useDocStore((s) => s.distributeSelected)

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
  const alignCount = alignmentItems({ keys, groups, selection }).length
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
        <label className="field field-check">
          <span>Mirror</span>
          <input
            type="checkbox"
            checked={primary.mirror !== false}
            onChange={(e) => updateSelected({ mirror: e.target.checked })}
          />
        </label>
      </div>
      {selected.length > 1 && (
        <p className="hint">
          Values show the first selected key; edits apply to all selected keys.
        </p>
      )}
      {alignCount > 1 && (
        <>
          <h3>Align</h3>
          <div className="align-rows">
            <div className="button-row">
              <button onClick={() => alignSelected('left')} title="Align left edges">
                Left
              </button>
              <button
                onClick={() => alignSelected('hcenter')}
                title="Align horizontal centers"
              >
                Center
              </button>
              <button onClick={() => alignSelected('right')} title="Align right edges">
                Right
              </button>
            </div>
            <div className="button-row">
              <button onClick={() => alignSelected('top')} title="Align top edges">
                Top
              </button>
              <button
                onClick={() => alignSelected('vcenter')}
                title="Align vertical centers"
              >
                Middle
              </button>
              <button
                onClick={() => alignSelected('bottom')}
                title="Align bottom edges"
              >
                Bottom
              </button>
            </div>
            {alignCount > 2 && (
              <div className="button-row">
                <button
                  onClick={() => distributeSelected('x')}
                  title="Space evenly left to right"
                >
                  Space H
                </button>
                <button
                  onClick={() => distributeSelected('y')}
                  title="Space evenly top to bottom"
                >
                  Space V
                </button>
              </div>
            )}
          </div>
          <p className="hint">
            Aligns in world space; a fully selected group moves as one piece.
          </p>
        </>
      )}
      {sharedGroup && <GroupPanel group={sharedGroup} />}
    </aside>
  )
}
