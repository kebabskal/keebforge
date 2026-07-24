export type KeyType = 'mx' | 'choc'

/** A single key. Position is the key center in millimeters; if the key belongs
 * to a group, position/rotation are relative to the group's frame, otherwise
 * they are world coordinates. Editor space is x-right / y-up. Rotation is
 * degrees, counter-clockwise, about the key center. Width/height are in
 * keyboard units (1u = one switch pitch). */
export interface Key {
  id: string
  type: KeyType
  x: number
  y: number
  r: number
  w: number
  h: number
  label: string
  groupId?: string | null
  /** Slot in a column-layout group; used to keep identity across regeneration. */
  col?: number
  row?: number
  /** Include this key in the mirrored half (default true). */
  mirror?: boolean
}

export interface ColumnDef {
  /** Vertical offset of the column, mm (column stagger). */
  stagger: number
  /** Rotation of the column relative to the previous column, degrees CCW
   * (splay). The column pivots about the corner it shares with the previous
   * column, keeping the two tangent, and the rotation carries over to all
   * later columns, so the cluster fans without keys overlapping. */
  splay: number
}

export type GroupLayout =
  | { kind: 'free' }
  | { kind: 'columns'; rows: number; columns: ColumnDef[]; keyType: KeyType }
  /** Auto layout: pack the group's keys along one axis, each taking up its
   * pitch-area extent plus `gap` mm between neighbours. */
  | { kind: 'stack'; axis: 'x' | 'y'; gap: number }

/** A group of keys with its own frame. Groups can nest via parentId. */
export interface Group {
  id: string
  name: string
  parentId: string | null
  x: number
  y: number
  r: number
  layout: GroupLayout
  /** Include this group's keys in the mirrored half (default true). */
  mirror?: boolean
}

export interface MirrorSettings {
  /** Master toggle; individual keys/groups can opt out via their `mirror`
   * flag. */
  enabled: boolean
  /** X position of the vertical mirror axis, mm (world). */
  axis: number
}

export interface PlateSettings {
  /** Margin around each key's pitch area when generating the plate/foam
   * outline, mm. */
  padding: number
}

export const DEFAULT_PLATE: PlateSettings = { padding: 3 }

export interface Doc {
  keys: Key[]
  groups: Group[]
  mirror: MirrorSettings
  plate: PlateSettings
}

/** Switch pitch (center-to-center spacing) and keycap size per switch type, mm. */
export const SPEC: Record<
  KeyType,
  { pitchX: number; pitchY: number; capX: number; capY: number }
> = {
  mx: { pitchX: 19.05, pitchY: 19.05, capX: 18.1, capY: 18.1 },
  choc: { pitchX: 18, pitchY: 17, capX: 17.5, capY: 16.5 },
}

export const U = SPEC.mx.pitchX

const DEG = Math.PI / 180

// ---- Transforms -----------------------------------------------------------

/** A 2D rigid transform: translation in mm plus rotation in degrees CCW. */
export interface XForm {
  x: number
  y: number
  r: number
}

export const IDENTITY: XForm = { x: 0, y: 0, r: 0 }

export function composeXF(parent: XForm, child: XForm): XForm {
  const rad = parent.r * DEG
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: parent.x + child.x * cos - child.y * sin,
    y: parent.y + child.x * sin + child.y * cos,
    r: parent.r + child.r,
  }
}

/** World transform of a group's frame (walks up the parent chain). */
export function groupWorldXF(
  groups: Map<string, Group>,
  groupId: string | null | undefined,
): XForm {
  const chain: Group[] = []
  const visited = new Set<string>()
  let id = groupId ?? null
  while (id) {
    if (visited.has(id)) break
    visited.add(id)
    const g = groups.get(id)
    if (!g) break
    chain.push(g)
    id = g.parentId
  }
  let xf = IDENTITY
  for (let i = chain.length - 1; i >= 0; i--) {
    const g = chain[i]
    xf = composeXF(xf, { x: g.x, y: g.y, r: g.r })
  }
  return xf
}

/** World transform of a key's center. */
export function keyWorldXF(key: Key, groups: Map<string, Group>): XForm {
  return composeXF(groupWorldXF(groups, key.groupId), {
    x: key.x,
    y: key.y,
    r: key.r,
  })
}

/** Convert a world-space point into a frame's local coordinates. */
export function worldToLocal(frame: XForm, x: number, y: number): { x: number; y: number } {
  const rad = frame.r * DEG
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - frame.x
  const dy = y - frame.y
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos }
}

/** Rotate a world-space delta into a frame rotated by `deg`. */
export function rotateDelta(deg: number, dx: number, dy: number): { x: number; y: number } {
  const rad = deg * DEG
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos }
}

/** Mirror a world transform across the vertical line x = axis. */
export function mirrorXF(xf: XForm, axis: number): XForm {
  return { x: 2 * axis - xf.x, y: xf.y, r: -xf.r }
}

/** True if the key participates in the mirrored half: neither the key nor
 * any ancestor group has mirroring turned off. The document-level mirror
 * toggle still gates the whole feature. */
export function isKeyMirrored(key: Key, groups: Map<string, Group>): boolean {
  if (key.mirror === false) return false
  const visited = new Set<string>()
  let id = key.groupId ?? null
  while (id && !visited.has(id)) {
    visited.add(id)
    const g = groups.get(id)
    if (!g) break
    if (g.mirror === false) return false
    id = g.parentId
  }
  return true
}

// ---- Key geometry ---------------------------------------------------------

/** Footprint (pitch-area) size of a key in mm. */
export function keySize(key: Key): { w: number; h: number } {
  const spec = SPEC[key.type]
  return { w: key.w * spec.pitchX, h: key.h * spec.pitchY }
}

/** Keycap size of a key in mm. */
export function capSize(key: Key): { w: number; h: number } {
  const spec = SPEC[key.type]
  return {
    w: key.w * spec.pitchX - (spec.pitchX - spec.capX),
    h: key.h * spec.pitchY - (spec.pitchY - spec.capY),
  }
}

/** True if the world point falls inside the key's pitch area, given the key's
 * world transform. */
export function hitTest(key: Key, world: XForm, x: number, y: number): boolean {
  const local = worldToLocal(world, x, y)
  const { w, h } = keySize(key)
  return Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2
}

// ---- Column layout --------------------------------------------------------

export interface ColumnSlot {
  col: number
  row: number
  x: number
  y: number
  r: number
}

/** Group-local key positions for a column layout. Each column sits one pitch
 * to the right of the previous along the running (splayed) frame, offset by
 * its stagger along its own column axis. Splay accumulates: rotating a column
 * also rotates the frame the following columns are placed in, so columns with
 * the same cumulative angle stay exactly one pitch apart.
 *
 * A splayed column pivots about the corner of the boundary it shares with the
 * previous column — the top corner for positive splay, the bottom corner for
 * negative — so the wedge always opens away from the pivot and the two
 * columns' pitch areas stay tangent instead of overlapping. */
export function columnSlots(layout: Extract<GroupLayout, { kind: 'columns' }>): ColumnSlot[] {
  const spec = SPEC[layout.keyType]
  const colLen = (layout.rows - 1) * spec.pitchY
  const slots: ColumnSlot[] = []
  // Origin of the current column (top-key level before stagger) and the
  // cumulative angle of the frame it is placed in.
  let ox = 0
  let oy = 0
  let angle = 0
  for (let col = 0; col < layout.columns.length; col++) {
    const def = layout.columns[col]
    if (col > 0 && def.splay !== 0) {
      // Pivot on the boundary half a pitch left of this column's axis, level
      // with the higher of the two columns' top edges (positive splay) or the
      // lower of their bottom edges (negative splay), measured in the
      // previous column's frame. Rotating about that corner keeps every
      // point of this column on its own side of the boundary.
      const prev = layout.columns[col - 1]
      const pivotY =
        def.splay > 0
          ? Math.min(def.stagger, prev.stagger) + spec.pitchY / 2
          : Math.max(def.stagger, prev.stagger) - colLen - spec.pitchY / 2
      const rad0 = angle * DEG
      const qx = ox - (spec.pitchX / 2) * Math.cos(rad0) - pivotY * Math.sin(rad0)
      const qy = oy - (spec.pitchX / 2) * Math.sin(rad0) + pivotY * Math.cos(rad0)
      const rd = def.splay * DEG
      const dx = ox - qx
      const dy = oy - qy
      ox = qx + dx * Math.cos(rd) - dy * Math.sin(rd)
      oy = qy + dx * Math.sin(rd) + dy * Math.cos(rd)
    }
    angle += def.splay
    const rad = angle * DEG
    const sin = Math.sin(rad)
    const cos = Math.cos(rad)
    // Top key: column origin shifted by stagger along the column's own axis.
    const topX = ox - def.stagger * sin
    const topY = oy + def.stagger * cos
    for (let row = 0; row < layout.rows; row++) {
      const d = row * spec.pitchY
      slots.push({
        col,
        row,
        x: topX + d * sin,
        y: topY - d * cos,
        r: angle,
      })
    }
    // Advance one pitch along the rotated frame; stagger intentionally does
    // not carry over.
    ox += spec.pitchX * cos
    oy += spec.pitchX * sin
  }
  return slots
}

// ---- Stack layout ---------------------------------------------------------

/** Group-local centers for a stack layout: keys pack along the axis in their
 * current order along that axis (left-to-right for x, top-to-bottom for y),
 * each taking its pitch-area extent plus the layout gap, centered on the
 * group origin. Rotated keys take up their rotated bounding extent, so a
 * gap of 0 keeps footprints tangent exactly like a column cluster does. */
export function stackPositions(
  layout: Extract<GroupLayout, { kind: 'stack' }>,
  members: Key[],
): Map<string, { x: number; y: number }> {
  const ordered = [...members].sort((a, b) =>
    layout.axis === 'x' ? a.x - b.x : b.y - a.y,
  )
  const extents = ordered.map((k) => {
    const { w, h } = keySize(k)
    const cos = Math.abs(Math.cos(k.r * DEG))
    const sin = Math.abs(Math.sin(k.r * DEG))
    return layout.axis === 'x' ? w * cos + h * sin : w * sin + h * cos
  })
  const total =
    extents.reduce((s, e) => s + e, 0) + layout.gap * Math.max(0, ordered.length - 1)
  const out = new Map<string, { x: number; y: number }>()
  let cursor = -total / 2
  ordered.forEach((k, i) => {
    const center = cursor + extents[i] / 2
    out.set(k.id, layout.axis === 'x' ? { x: center, y: 0 } : { x: 0, y: -center })
    cursor += extents[i] + layout.gap
  })
  return out
}

// ---- Construction ---------------------------------------------------------

let counter = 0

export function newId(prefix = 'k'): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`
}

export function makeKey(type: KeyType, x: number, y: number, label = ''): Key {
  return { id: newId(), type, x, y, r: 0, w: 1, h: 1, label, groupId: null }
}

/** Starter document: a column-staggered 3×5 cluster plus a thumb arc, with
 * live mirroring enabled to preview the full split. */
export function defaultDoc(): Doc {
  const cluster: Group = {
    id: newId('g'),
    name: 'Fingers',
    parentId: null,
    x: 0,
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
  const labels = [
    ['Q', 'W', 'E', 'R', 'T'],
    ['A', 'S', 'D', 'F', 'G'],
    ['Z', 'X', 'C', 'V', 'B'],
  ]
  const keys: Key[] = columnSlots(cluster.layout as Extract<GroupLayout, { kind: 'columns' }>).map(
    (slot) => ({
      ...makeKey('mx', slot.x, slot.y, labels[slot.row][slot.col]),
      r: slot.r,
      groupId: cluster.id,
      col: slot.col,
      row: slot.row,
    }),
  )

  const thumbs: Group = {
    id: newId('g'),
    name: 'Thumbs',
    parentId: null,
    x: 2.5 * U,
    y: -3 * U - 5,
    r: -12,
    layout: { kind: 'free' },
  }
  for (let i = 0; i < 3; i++) {
    const key = makeKey('mx', i * U, -i * 2, '')
    key.r = -i * 10
    key.groupId = thumbs.id
    keys.push(key)
  }

  return {
    keys,
    groups: [cluster, thumbs],
    mirror: { enabled: true, axis: 6 * U },
    plate: { ...DEFAULT_PLATE },
  }
}
