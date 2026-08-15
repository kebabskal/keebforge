import { useDeferredValue, useMemo } from 'react'
import {
  DEFAULT_BEZEL,
  DEFAULT_BOTTOM,
  DEFAULT_CONTROLLER,
  DEFAULT_MOUNTING,
  DEFAULT_PLATE,
  DEFAULT_TENT,
  DEFAULT_TILT,
  isKeyMirrored,
  keyWorldXF,
  MATERIAL_PRESETS,
  MCU_PRESETS,
  SWITCH_CLEARANCE,
  USB_OPENING,
  type Group,
  type GroupLayout,
  type Key,
  type KeyType,
} from '../model/keys'
import { alignmentItems, coalesceUndo, docOf, groupMap, useDocStore } from '../model/store'
import {
  bezelShape,
  controllerOverlaps,
  controllerPortReaches,
  FOAM_CLEARANCE,
  foamWithCutouts,
  maxScrewInset,
  plateWithCutouts,
} from '../model/outline'
import { downloadText, toDXF } from '../export/dxf'
import { bottomSolids, downloadSTL, plateSolids, topCaseSolids } from '../export/stl'
import { NumberField, Section, SliderField, TextField } from './fields'

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
      <Section id="group" title="Group">
        <div className="field-grid">
          <TextField
            label="Name"
            value={group.name}
            onCommit={(name) => updateGroup(group.id, { name })}
          />
          <label className="field field-check">
            <span>Mirror</span>
            <input
              type="checkbox"
              checked={group.mirror !== false}
              onChange={(e) => updateGroup(group.id, { mirror: e.target.checked })}
            />
          </label>
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
          <SliderField
            label="Rotation"
            value={group.r}
            min={-180}
            max={180}
            step={1}
            unit="°"
            reset={0}
            onCommit={(r) => updateGroup(group.id, { r })}
          />
        </div>
        <button className="wide" onClick={ungroupSelection}>
          Ungroup
        </button>
      </Section>
      {layout.kind !== 'columns' && (
        <Section id="group-auto" title="Auto layout">
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
                <SliderField
                  label="Gap"
                  value={layout.gap}
                  min={-5}
                  max={20}
                  step={0.5}
                  unit="mm"
                  reset={0}
                  onCommit={(gap) => updateGroupLayout(group.id, { ...layout, gap })}
                />
                <SliderField
                  label="Curve"
                  value={layout.curve ?? 0}
                  min={-45}
                  max={45}
                  step={1}
                  unit="°/key"
                  reset={0}
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
        </Section>
      )}
      {layout.kind === 'columns' && (
        <Section id="group-columns" title="Column layout">
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
            +/− buttons beside the cluster.
          </p>
        </Section>
      )}
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
  const mounting = useDocStore((s) => s.mounting)
  const setMounting = useDocStore((s) => s.setMounting)
  const controller = useDocStore((s) => s.controller)
  const setController = useDocStore((s) => s.setController)
  const tilt = useDocStore((s) => s.tilt)
  const setTilt = useDocStore((s) => s.setTilt)
  const materials = useDocStore((s) => s.materials)
  const setMaterial = useDocStore((s) => s.setMaterial)
  const setMaterials = useDocStore((s) => s.setMaterials)
  const setMaterialsLinked = useDocStore((s) => s.setMaterialsLinked)
  const keyCount = useDocStore((s) => s.keys.length)
  const mirroredCount = useDocStore((s) =>
    s.mirror.enabled
      ? s.keys.filter((k) => isKeyMirrored(k, groupMap(s.groups))).length
      : 0,
  )
  // Both checks need the case outline, and a zustand selector runs on every
  // store update — which during a drag is every pointer move, synchronously.
  // Keyed on a deferred copy of the controller instead, so a drag is not
  // paying for a case rebuild per frame to keep a warning current.
  const deferredController = useDeferredValue(controller)
  const bezelEnabled = bezel.enabled
  const { portReaches, overlaps } = useMemo(() => {
    if (!deferredController.enabled) return { portReaches: true, overlaps: false }
    // The rest of the document is read live; only the controller is taken
    // from the deferred copy, so what is measured is what the deps say.
    const doc = { ...docOf(useDocStore.getState()), controller: deferredController }
    return {
      portReaches: bezelEnabled ? controllerPortReaches(doc) : true,
      overlaps: controllerOverlaps(doc),
    }
  }, [deferredController, bezelEnabled])
  const neededClearance = useDocStore((s) =>
    s.keys.reduce((m, k) => Math.max(m, SWITCH_CLEARANCE[k.type]), 0),
  )

  const exportDXF = (part: 'plate' | 'foam', filename: string) => {
    const { keys, groups, mirror, plate, bezel, bottom, mounting, controller, tilt, materials } =
      useDocStore.getState()
    const doc = { keys, groups, mirror, plate, bezel, bottom, mounting, controller, tilt, materials }
    const shapes = part === 'plate' ? plateWithCutouts(doc) : foamWithCutouts(doc)
    downloadText(filename, toDXF(shapes))
  }

  const exportSTL = (part: 'case' | 'bottom' | 'plate') => {
    const doc = useDocStore.getState()
    const solids =
      part === 'case'
        ? topCaseSolids(doc)
        : part === 'bottom'
          ? bottomSolids(doc)
          : plateSolids(doc)
    const name = { case: 'case-top', bottom: 'case-bottom', plate: 'plate' }[part]
    if (solids.length > 0) downloadSTL(`keebforge-${name}.stl`, solids)
  }

  return (
    <>
      <h2>Document</h2>
      <p className="hint">
        {keyCount} keys
        {mirror.enabled ? ` (${keyCount + mirroredCount} with mirror)` : ''}
      </p>
      <Section id="doc-layout" title="Layout">
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
              <SliderField
                label="Tent"
                value={mirror.tent ?? DEFAULT_TENT}
                min={0}
                max={60}
                step={1}
                unit="°"
                reset={DEFAULT_TENT}
                onCommit={(tent) => setMirror({ tent })}
              />
              <SliderField
                label="Half rotation"
                value={mirror.rotation ?? 0}
                min={-45}
                max={45}
                step={1}
                unit="°"
                reset={0}
                onCommit={(rotation) => setMirror({ rotation })}
              />
            </>
          )}
          <SliderField
            label="Tilt"
            value={tilt}
            min={-5}
            max={25}
            step={0.5}
            unit="°"
            reset={DEFAULT_TILT}
            onCommit={setTilt}
          />
        </div>
        <p className="hint">
          Tilt is the typing angle shown in 3D: positive raises the back edge,
          pivoting on the front. A split case gives each half its own outlines,
          tented about the outer edges.
        </p>
      </Section>
      <Section id="doc-plate" title="Plate & foam" defaultOpen={false}>
        <div className="field-grid">
          <SliderField
            label="Edge padding"
            value={plate.padding}
            min={0}
            max={12}
            step={0.5}
            unit="mm"
            reset={DEFAULT_PLATE.padding}
            onCommit={(padding) => setPlate({ padding })}
          />
        </div>
        <p className="hint">
          With a bezel the plate is cut to the case interior so it drops into
          the shell; without one it is the union of all key areas plus this
          padding. Per-switch cutouts are 14 mm MX / 13.8 mm Choc; foam adds{' '}
          {FOAM_CLEARANCE} mm cutout clearance and sits inside the lip.
        </p>
      </Section>
      <Section id="doc-bezel" title="Bezel" defaultOpen={false}>
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
          <SliderField
            label="Width"
            reset={DEFAULT_BEZEL.width}
            value={bezel.width}
            min={0}
            max={20}
            step={0.5}
            unit="mm"
            onCommit={(width) => setBezel({ width })}
          />
          <SliderField
            label="Outset"
            value={bezel.outset}
            min={0}
            max={5}
            step={0.25}
            unit="mm"
            reset={DEFAULT_BEZEL.outset}
            onCommit={(outset) => setBezel({ outset })}
          />
          <SliderField
            label="Height"
            value={bezel.height}
            min={0}
            max={15}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BEZEL.height}
            onCommit={(height) => setBezel({ height })}
          />
          <SliderField
            label="Outer radius"
            value={bezel.radiusOuter}
            min={0}
            max={15}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BEZEL.radiusOuter}
            onCommit={(radiusOuter) => setBezel({ radiusOuter })}
          />
          <SliderField
            label="Inner radius"
            value={bezel.radiusInner}
            min={0}
            max={10}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BEZEL.radiusInner}
            onCommit={(radiusInner) => setBezel({ radiusInner })}
          />
          <SliderField
            label="Bevel"
            value={bezel.bevel}
            min={0}
            max={5}
            step={0.25}
            unit="mm"
            reset={DEFAULT_BEZEL.bevel}
            onCommit={(bevel) => setBezel({ bevel })}
          />
          <SliderField
            label="Draft"
            value={bezel.draft ?? 0}
            min={0}
            max={6}
            step={0.1}
            unit="mm"
            reset={DEFAULT_BEZEL.draft}
            onCommit={(draft) => setBezel({ draft })}
          />
          <SliderField
            label="Draft start"
            value={bezel.draftStart ?? 0}
            min={0}
            max={20}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BEZEL.draftStart}
            onCommit={(draftStart) => setBezel({ draftStart })}
          />
          <SliderField
            label="Margin top"
            value={bezel.marginTop ?? 0}
            min={0}
            max={40}
            step={1}
            unit="mm"
            reset={DEFAULT_BEZEL.marginTop}
            onCommit={(v) => setBezel({ marginTop: v })}
          />
          <SliderField
            label="Margin bottom"
            value={bezel.marginBottom ?? 0}
            min={0}
            max={40}
            step={1}
            unit="mm"
            reset={DEFAULT_BEZEL.marginBottom}
            onCommit={(v) => setBezel({ marginBottom: v })}
          />
          {mirror.enabled ? (
            <SliderField
              label="Margin side"
              value={bezel.marginLeft ?? 0}
              min={0}
              max={40}
              step={1}
              unit="mm"
              reset={DEFAULT_BEZEL.marginLeft}
              onCommit={(v) => setBezel({ marginLeft: v, marginRight: v })}
            />
          ) : (
            <>
              <SliderField
                label="Margin left"
                value={bezel.marginLeft ?? 0}
                min={0}
                max={40}
                step={1}
                unit="mm"
                reset={DEFAULT_BEZEL.marginLeft}
                onCommit={(v) => setBezel({ marginLeft: v })}
              />
              <SliderField
                label="Margin right"
                value={bezel.marginRight ?? 0}
                min={0}
                max={40}
                step={1}
                unit="mm"
                reset={DEFAULT_BEZEL.marginRight}
                onCommit={(v) => setBezel({ marginRight: v })}
              />
            </>
          )}
        </div>
        <p className="hint">
          The hollow top shell: tight follows the keycap contour, box is a
          rectangular frame. Width is the wall thickness, outset the gap
          around keycaps, height the rim above the plate top. Draft tapers the
          outside of the case, pulling the top of the rim in by that much
          while the base keeps the outline — the cavity stays straight, so the
          plate still drops in. Draft start holds the face vertical for that
          many mm above the lid plane first, putting a break line around the
          case. Like bevel, both shape the 3D preview only; exported outlines
          are the footprint at the base.
        </p>
      </Section>
      <Section id="doc-bottom" title="Case bottom" defaultOpen={false}>
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
          <SliderField
            label="Thickness"
            value={bottom.thickness}
            min={0.5}
            max={10}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BOTTOM.thickness}
            onCommit={(thickness) => setBottom({ thickness })}
          />
          <SliderField
            label="Inset"
            value={bottom.inset ?? 0}
            min={0}
            max={10}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BOTTOM.inset}
            onCommit={(inset) => setBottom({ inset })}
          />
          <SliderField
            label="Clearance"
            value={bottom.clearance ?? 0}
            min={0}
            max={15}
            step={0.5}
            unit="mm"
            reset={neededClearance}
            onCommit={(clearance) => setBottom({ clearance })}
          />
          <SliderField
            label="Ridge"
            value={bottom.ridge ?? 0}
            min={0}
            max={6}
            step={0.5}
            unit="mm"
            reset={DEFAULT_BOTTOM.ridge}
            onCommit={(ridge) => setBottom({ ridge })}
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
          and adds little posts under whatever tilt and tent lift off the
          desk; wedge fills the whole gap down to the desk as one solid piece.
          Inset pulls the bottom's edge in from the case edge. Clearance is
          the interior depth below the plate for switch bodies plus
          PCB/hotswap sockets or handwiring — MX needs {SWITCH_CLEARANCE.mx}{' '}
          mm, Choc {SWITCH_CLEARANCE.choc} mm. Ridge turns the bottom into a
          tray: an inset rim rises to the plate's underside and supports it
          from below, sandwiching it against the top case.
        </p>
      </Section>
      <Section id="doc-mounting" title="Mounting" defaultOpen={false}>
        <div className="field-grid">
          <label className="field field-check">
            <span>Screws</span>
            <input
              type="checkbox"
              checked={mounting.enabled}
              onChange={(e) => setMounting({ enabled: e.target.checked })}
            />
          </label>
          <SliderField
            label="Spacing"
            value={mounting.spacing}
            min={30}
            max={100}
            step={5}
            unit="mm"
            reset={DEFAULT_MOUNTING.spacing}
            onCommit={(spacing) => setMounting({ spacing })}
          />
        </div>
        {mounting.enabled && (!bezel.enabled || !bottom.enabled) && (
          <p className="hint hint-warn">
            Screws need both a bezel (they bite into its wall) and a case
            bottom (they come up through it) — enable both to see them.
          </p>
        )}
        {mounting.enabled &&
          bezel.enabled &&
          bottom.enabled &&
          (bottom.inset ?? 0) > maxScrewInset(bezel.width) && (
            <p className="hint hint-warn">
              The bottom is inset too far to fasten: its edge sits inboard of
              every spot the wall can hold a pilot hole. Drop the inset to{' '}
              {Math.max(0, Math.floor(maxScrewInset(bezel.width) * 2) / 2)} mm
              or widen the bezel.
            </p>
          )}
        <p className="hint">
          M2 self-tapping screws go up through the bottom lid into pilot holes
          in the bezel wall, spaced evenly along the wall. Spacing sets the
          target distance between screws.
        </p>
      </Section>
      <Section id="doc-controller" title="Controller" defaultOpen={false}>
        <div className="field-grid">
          <label className="field field-check">
            <span>Enabled</span>
            <input
              type="checkbox"
              checked={controller.enabled}
              onChange={(e) => setController({ enabled: e.target.checked })}
            />
          </label>
          <label className="field">
            <span>Mode</span>
            <select
              value={controller.mode}
              onChange={(e) => setController({ mode: e.target.value as 'mcu' | 'pcb' })}
            >
              <option value="mcu">MCU module</option>
              <option value="pcb">On the PCB</option>
            </select>
          </label>
          {controller.mode === 'mcu' && (
            <label className="field">
              <span>Board</span>
              <select
                value={controller.preset}
                onChange={(e) => {
                  const preset = MCU_PRESETS.find((p) => p.id === e.target.value)
                  setController(
                    preset
                      ? {
                          preset: preset.id,
                          length: preset.length,
                          width: preset.width,
                          portWidth: USB_OPENING[preset.usb].width,
                          portHeight: USB_OPENING[preset.usb].height,
                        }
                      : { preset: 'custom' },
                  )
                }}
              >
                {MCU_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.length} × {preset.width})
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>
          )}
          {controller.mode === 'mcu' && controller.preset === 'custom' && (
            <>
              <SliderField
                label="Length"
                value={controller.length}
                min={10}
                max={80}
                step={0.1}
                unit="mm"
                reset={DEFAULT_CONTROLLER.length}
                onCommit={(length) => setController({ length })}
              />
              <SliderField
                label="Width"
                reset={DEFAULT_CONTROLLER.width}
                value={controller.width}
                min={8}
                max={40}
                step={0.1}
                unit="mm"
                onCommit={(width) => setController({ width })}
              />
            </>
          )}
          {controller.mode === 'mcu' && (
            <>
              <NumberField
                label="X (mm)"
                value={controller.x}
                step={1}
                onCommit={(x) => setController({ x })}
              />
              <NumberField
                label="Y (mm)"
                value={controller.y}
                step={1}
                onCommit={(y) => setController({ y })}
              />
              <SliderField
                label="Rotation"
                reset={DEFAULT_CONTROLLER.r}
                value={controller.r}
                min={-180}
                max={180}
                step={5}
                unit="°"
                onCommit={(r) => setController({ r })}
              />
              <SliderField
                label="Fit"
                value={controller.fit}
                min={0}
                max={1}
                step={0.05}
                unit="mm"
                reset={DEFAULT_CONTROLLER.fit}
                onCommit={(fit) => setController({ fit })}
              />
            </>
          )}
          <SliderField
            label="Port width"
            value={controller.portWidth}
            min={4}
            max={20}
            step={0.1}
            unit="mm"
            reset={DEFAULT_CONTROLLER.portWidth}
            onCommit={(portWidth) => setController({ portWidth })}
          />
          <SliderField
            label="Port height"
            value={controller.portHeight}
            min={2}
            max={12}
            step={0.1}
            unit="mm"
            reset={DEFAULT_CONTROLLER.portHeight}
            onCommit={(portHeight) => setController({ portHeight })}
          />
        </div>
        {controller.enabled && !bezel.enabled && (
          <p className="hint hint-warn">
            The opening is cut through the case wall, so it needs a bezel to
            cut through — enable one to see it.
          </p>
        )}
        {controller.enabled && overlaps && (
          <p className="hint hint-warn">
            The module runs into something sharing the cavity with it — a
            switch body hanging below the plate, or the tray ridge around the
            lid's edge. Drag it clear, or make room with a wider bezel margin.
          </p>
        )}
        {controller.enabled && bezel.enabled && !portReaches && (
          <p className="hint hint-warn">
            The connector opening does not break through: the board's port end
            has to sit inside the case with a wall in front of it. Move it
            along X and Y until it meets one, or turn it with Rotation — at 0°
            the connector points at the top of the board.
          </p>
        )}
        <p className="hint">
          {controller.mode === 'mcu'
            ? 'A controller module held by four corner brackets rising off the tray floor, with its connector opening cut through the case wall. Drag it in the 2D view to place it — where it sits relative to the wall is the whole point, so put the port end against one. Rotation 0 points the connector at the top of the board. Fit is the slack between the board and its brackets — printed brackets come out a little fat, and a board that has to be forced in cannot come out again.'
            : 'The controller sits on a full-size PCB under the plate, so only the connector opening is cut. Position it along the wall with X and Y.'}{' '}
          On a split board each half gets its own controller; a mirrored
          unibody keeps one.
        </p>
      </Section>
      <Section id="doc-materials" title="Materials" defaultOpen={false}>
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
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={m.roughness}
                  title={`Roughness ${m.roughness}`}
                  onChange={(e) => {
                    const roughness = Number(e.target.value)
                    coalesceUndo(`mat-${slot}-rough`, () =>
                      setMaterial(slot, { roughness }),
                    )
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={m.specular}
                  title={`Specular ${m.specular}`}
                  onChange={(e) => {
                    const specular = Number(e.target.value)
                    coalesceUndo(`mat-${slot}-spec`, () =>
                      setMaterial(slot, { specular }),
                    )
                  }}
                />
              </div>
            )
          })}
        </div>
        <p className="hint">
          Roughness blurs reflections (0 gloss – 1 matte); specular sets how
          strongly the surface reflects. Unlabeled keys use the accent
          material.
        </p>
      </Section>
      <Section id="doc-export" title="Export">
        <div className="button-row">
          <button onClick={() => exportDXF('plate', 'keebforge-plate.dxf')}>Plate DXF</button>
          <button onClick={() => exportDXF('foam', 'keebforge-foam.dxf')}>
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
        <div className="button-row">
          <button
            disabled={!bezel.enabled || bezel.width <= 0}
            title="Top case shell with screw pilots and draft, ready to print"
            onClick={() => exportSTL('case')}
          >
            Case STL
          </button>
          <button
            disabled={!bottom.enabled}
            title="Bottom tray with countersunk screw seats"
            onClick={() => exportSTL('bottom')}
          >
            Bottom STL
          </button>
          <button title="Switch plate as a printable solid" onClick={() => exportSTL('plate')}>
            Plate STL
          </button>
        </div>
        <p className="hint">
          DXF is 2D outlines for CAD; STL is print-ready solids (mm, Z up,
          resting on the bed) for a slicer. A split case exports both halves
          side by side. Wedge bottoms export as their flat tray — tilt,
          tenting and support posts are preview-only.
        </p>
      </Section>
      <Section id="doc-shortcuts" title="Shortcuts" defaultOpen={false}>
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
      </Section>
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
      <Section id="key" title="Key">
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
          <SliderField
            label="Rotation"
            value={primary.r}
            min={-180}
            max={180}
            step={1}
            unit="°"
            reset={0}
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
          <label
            className="field field-check"
            title="Spacebar/modifier-style rounded top"
          >
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
            Values show the first selected key; edits apply to all selected
            keys.
          </p>
        )}
      </Section>
      {alignCount > 1 && (
        <Section id="align" title="Align">
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
        </Section>
      )}
      {sharedGroup && <GroupPanel group={sharedGroup} />}
    </aside>
  )
}
