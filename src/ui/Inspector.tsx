import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_TENT,
  isKeyMirrored,
  keyWorldXF,
  MATERIAL_PRESETS,
  SWITCH_CLEARANCE,
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
              <>
                <NumberField
                  label="Gap (mm)"
                  value={layout.gap}
                  step={0.5}
                  onCommit={(gap) => updateGroupLayout(group.id, { ...layout, gap })}
                />
                <NumberField
                  label="Curve (°/key)"
                  value={layout.curve ?? 0}
                  step={1}
                  onCommit={(curve) => updateGroupLayout(group.id, { ...layout, curve })}
                />
              </>
            )}
          </div>
          {layout.kind === 'stack' && (
            <p className="hint">
              Keys pack along the {layout.axis === 'x' ? 'row' : 'column'} in
              order, each taking up its own size. Curve fans the stack that
              many degrees per key (a thumb arc) and overrides key rotations.
              Drag a key within the stack to reorder; resizing re-packs
              automatically.
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
            the columns that follow. You can also drag the handles above
            (stagger) and below (splay) each column in the editor, and use the
            +/− buttons beside the cluster. Layout changes regenerate key
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
  const bezel = useDocStore((s) => s.bezel)
  const setBezel = useDocStore((s) => s.setBezel)
  const bottom = useDocStore((s) => s.bottom)
  const setBottom = useDocStore((s) => s.setBottom)
  const tilt = useDocStore((s) => s.tilt)
  const setTilt = useDocStore((s) => s.setTilt)
  const materials = useDocStore((s) => s.materials)
  const setMaterial = useDocStore((s) => s.setMaterial)
  const setMaterials = useDocStore((s) => s.setMaterials)
  const setMaterialsLinked = useDocStore((s) => s.setMaterialsLinked)
  const view = useViewSettings()
  const keyCount = useDocStore((s) => s.keys.length)
  const mirroredCount = useDocStore((s) =>
    s.mirror.enabled
      ? s.keys.filter((k) => isKeyMirrored(k, groupMap(s.groups))).length
      : 0,
  )
  const neededClearance = useDocStore((s) =>
    s.keys.reduce((m, k) => Math.max(m, SWITCH_CLEARANCE[k.type]), 0),
  )

  const exportDXF = (clearance: number, filename: string) => {
    const { keys, groups, mirror, plate, bezel, bottom, tilt, materials } =
      useDocStore.getState()
    const shapes = plateWithCutouts(
      { keys, groups, mirror, plate, bezel, bottom, tilt, materials },
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
      <div className="button-row">
        <button
          onClick={() => useDocStore.getState().applyAlphaLabels()}
          title="QWERTY onto the column structure: 5 alpha columns per hand hugging the middle, digits on a 4th row; thumbs and extra pinky columns are left alone"
        >
          Auto-label alphas
        </button>
      </div>
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
        <label
          className="field field-check"
          title="Separate case per half instead of one mono-block"
        >
          <span>Split case</span>
          <input
            type="checkbox"
            disabled={!mirror.enabled}
            checked={mirror.enabled && mirror.split === true}
            onChange={(e) => setMirror({ split: e.target.checked })}
          />
        </label>
        {mirror.enabled && mirror.split === true && (
          <>
            <NumberField
              label="Tent (°)"
              value={mirror.tent ?? DEFAULT_TENT}
              step={1}
              onCommit={(tent) => setMirror({ tent })}
            />
            <NumberField
              label="Rotation (°)"
              value={mirror.rotation ?? 0}
              step={1}
              onCommit={(rotation) => setMirror({ rotation })}
            />
          </>
        )}
        <NumberField
          label="Tilt (°)"
          value={tilt}
          step={1}
          onCommit={setTilt}
        />
      </div>
      <p className="hint">
        Tilt is the typing angle shown in 3D: positive raises the back edge,
        pivoting on the front. A split case gives each half its own outlines,
        tented about the outer edges.
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
        <NumberField
          label="Margin top (mm)"
          value={bezel.marginTop ?? 0}
          step={1}
          onCommit={(v) => setBezel({ marginTop: Math.max(0, v) })}
        />
        <NumberField
          label="Margin bottom (mm)"
          value={bezel.marginBottom ?? 0}
          step={1}
          onCommit={(v) => setBezel({ marginBottom: Math.max(0, v) })}
        />
        {mirror.enabled ? (
          <NumberField
            label="Margin side (mm)"
            value={bezel.marginLeft ?? 0}
            step={1}
            onCommit={(v) =>
              setBezel({ marginLeft: Math.max(0, v), marginRight: Math.max(0, v) })
            }
          />
        ) : (
          <>
            <NumberField
              label="Margin left (mm)"
              value={bezel.marginLeft ?? 0}
              step={1}
              onCommit={(v) => setBezel({ marginLeft: Math.max(0, v) })}
            />
            <NumberField
              label="Margin right (mm)"
              value={bezel.marginRight ?? 0}
              step={1}
              onCommit={(v) => setBezel({ marginRight: Math.max(0, v) })}
            />
          </>
        )}
      </div>
      <p className="hint">
        A rim around the keycap opening: tight follows the keycap contour, box
        is a rectangular frame. Outset is the gap around keycaps, height is
        above the plate top.
      </p>
      <h3>Bottom</h3>
      <div className="field-grid">
        <label className="field field-check">
          <span>Enabled</span>
          <input
            type="checkbox"
            checked={bottom.enabled}
            onChange={(e) => setBottom({ enabled: e.target.checked })}
          />
        </label>
        <label className="field">
          <span>Mode</span>
          <select
            value={bottom.mode}
            onChange={(e) => setBottom({ mode: e.target.value as 'tight' | 'wedge' })}
          >
            <option value="tight">Tight</option>
            <option value="wedge">Wedge</option>
          </select>
        </label>
        <NumberField
          label="Thickness (mm)"
          value={bottom.thickness}
          step={0.5}
          onCommit={(thickness) => setBottom({ thickness: Math.max(0.5, thickness) })}
        />
        <NumberField
          label="Inset (mm)"
          value={bottom.inset ?? 0}
          step={0.5}
          onCommit={(inset) => setBottom({ inset: Math.max(0, inset) })}
        />
        <NumberField
          label="Clearance (mm)"
          value={bottom.clearance ?? 0}
          step={0.5}
          onCommit={(clearance) => setBottom({ clearance: Math.max(0, clearance) })}
        />
      </div>
      {bottom.enabled && neededClearance > (bottom.clearance ?? 0) && (
        <p className="hint hint-warn">
          Too shallow: this board's switches plus hotswap sockets/handwiring
          need at least {neededClearance} mm of clearance.
        </p>
      )}
      <p className="hint">
        Closes the case underneath. Tight hugs the underside as a thin plate
        and adds little posts under whatever tilt and tent lift off the desk;
        wedge fills the whole gap down to the desk as one solid piece. Inset
        pulls the bottom's edge in from the case edge. Clearance is the
        interior depth below the plate for switch bodies plus PCB/hotswap
        sockets or handwiring — MX needs {SWITCH_CLEARANCE.mx} mm, Choc{' '}
        {SWITCH_CLEARANCE.choc} mm.
      </p>
      <h3>Materials</h3>
      <div className="preset-row">
        {MATERIAL_PRESETS.map((preset) => (
          <button
            key={preset.name}
            title={preset.name}
            onClick={() => setMaterials(structuredClone(preset.materials))}
          >
            <span
              className="preset-dot"
              style={{ background: preset.materials.case.color }}
            />
            <span
              className="preset-dot"
              style={{ background: preset.materials.cap.color }}
            />
            <span
              className="preset-dot"
              style={{ background: preset.materials.capAccent.color }}
            />
          </button>
        ))}
      </div>
      <label className="field field-check">
        <span>Link (one material for everything)</span>
        <input
          type="checkbox"
          checked={materials.linked}
          onChange={(e) => setMaterialsLinked(e.target.checked)}
        />
      </label>
      <div className="material-table">
        <div className="material-row material-head">
          <span />
          <span />
          <span>Rough</span>
          <span>Spec</span>
        </div>
        {(materials.linked
          ? ([['case', 'All']] as const)
          : ([
              ['plate', 'Plate'],
              ['case', 'Case'],
              ['cap', 'Caps'],
              ['capAccent', 'Accent'],
            ] as const)
        ).map(([slot, label]) => {
          const m = materials[slot]
          const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
          return (
            <div className="material-row" key={slot}>
              <span>{label}</span>
              <input
                type="color"
                value={m.color}
                onChange={(e) => {
                  const color = e.target.value
                  coalesceUndo(`mat-${slot}`, () => setMaterial(slot, { color }))
                }}
              />
              <NumberField
                label=""
                value={m.roughness}
                step={0.05}
                onCommit={(roughness) =>
                  setMaterial(slot, { roughness: clamp01(roughness) })
                }
              />
              <NumberField
                label=""
                value={m.specular}
                step={0.05}
                onCommit={(specular) =>
                  setMaterial(slot, { specular: clamp01(specular) })
                }
              />
            </div>
          )
        })}
      </div>
      <p className="hint">
        Roughness blurs reflections (0 gloss – 1 matte); specular sets how
        strongly the surface reflects. Unlabeled keys use the accent material.
      </p>
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
        <NumberField
          label="Shadow blur"
          value={view.shadowBlur}
          step={1}
          onCommit={(shadowBlur) =>
            view.update({ shadowBlur: Math.max(1, Math.min(25, shadowBlur)) })
          }
        />
        <label className="field field-check">
          <span>SSAO</span>
          <input
            type="checkbox"
            checked={view.ssao}
            onChange={(e) => view.update({ ssao: e.target.checked })}
          />
        </label>
      </div>
      <h3>Parts</h3>
      <div className="layer-list">
        {(
          [
            ['showCaps', 'Keycaps'],
            ['showSwitches', 'Switches'],
            ['showCase', 'Case'],
            ['showPlate', 'Plate'],
            ['showFoam', 'Foam'],
            ['showBottom', 'Bottom'],
          ] as const
        ).map(([field, label]) => (
          <button
            key={field}
            className={`layer-row${view[field] ? '' : ' layer-off'}`}
            onClick={() => view.update({ [field]: !view[field] })}
            title={view[field] ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          >
            <span className="layer-eye">{view[field] ? '👁' : ''}</span>
            <span>{label}</span>
          </button>
        ))}
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
        <li><kbd>Shift</kbd>-drag — constrain movement to one axis</li>
        <li><kbd>Ctrl</kbd>-drag — duplicate the selection and drag the copy</li>
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
        <label className="field field-check" title="Spacebar/modifier-style rounded top">
          <span>Convex cap</span>
          <input
            type="checkbox"
            checked={primary.convex === true}
            onChange={(e) => updateSelected({ convex: e.target.checked })}
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
