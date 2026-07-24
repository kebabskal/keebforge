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
}

export interface ColumnDef {
  /** Vertical offset of the column, mm (column stagger). */
  stagger: number
  /** Rotation of the column about its top key, degrees CCW (splay). */
  splay: number
}

export type GroupLayout =
  | { kind: 'free' }
  | { kind: 'columns'; rows: number; columns: ColumnDef[]; keyType: KeyType }

/** A group of keys with its own frame. Groups can nest via parentId. */
export interface Group {
  id: string
  name: string
  parentId: string | null
  x: number
  y: number
  r: number
  layout: GroupLayout
}

export interface MirrorSettings {
  enabled: boolean
  /** X position of the vertical mirror axis, mm (world). */
  axis: number
}

export interface Doc {
  keys: Key[]
  groups: Group[]
  mirror: MirrorSettings
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
 * to the right of the previous, offset vertically by its stagger, and splayed
 * (rotated) about its top key. */
export function columnSlots(layout: Extract<GroupLayout, { kind: 'columns' }>): ColumnSlot[] {
  const spec = SPEC[layout.keyType]
  const slots: ColumnSlot[] = []
  for (let col = 0; col < layout.columns.length; col++) {
    const def = layout.columns[col]
    const rad = def.splay * DEG
    const ox = col * spec.pitchX
    const oy = def.stagger
    for (let row = 0; row < layout.rows; row++) {
      const d = row * spec.pitchY
      slots.push({
        col,
        row,
        x: ox + d * Math.sin(rad),
        y: oy - d * Math.cos(rad),
        r: def.splay,
      })
    }
  }
  return slots
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
  }
}
