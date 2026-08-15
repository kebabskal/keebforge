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
  /** Convex (spacebar/modifier-style) cap top instead of the concave dish. */
  convex?: boolean
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
   * pitch-area extent plus `gap` mm between neighbours. `curve` fans the
   * stack like splay does for columns: each key turns that many degrees
   * relative to its neighbour, and the packing direction follows the fan. */
  | { kind: 'stack'; axis: 'x' | 'y'; gap: number; curve?: number }

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
  /** Split case: each half gets its own plate/bezel outlines instead of one
   * mono-block spanning both. */
  split?: boolean
  /** Tenting angle per half when split, degrees (3D preview). */
  tent?: number
  /** Yaw of each half around the vertical axis when split, degrees; positive
   * angles the back edges inward (3D preview). */
  rotation?: number
}

export const DEFAULT_TENT = 5

export interface PlateSettings {
  /** Margin around each key's pitch area when generating the plate/foam
   * outline, mm. */
  padding: number
}

export const DEFAULT_PLATE: PlateSettings = { padding: 3 }

export interface BezelSettings {
  enabled: boolean
  /** `tight` follows the keycap contour; `box` is a rectangular frame around
   * the whole board. */
  mode: 'box' | 'tight'
  /** Rim width from the opening's edge outward, mm. */
  width: number
  /** Clearance between keycap edges and the opening, mm. */
  outset: number
  /** Rim height above the plate top, mm. */
  height: number
  /** Corner radius of the outer bezel edge, mm. */
  radiusOuter: number
  /** Corner radius of the opening around the keys, mm. */
  radiusInner: number
  /** Chamfer on the bezel's top and bottom edges (3D preview), mm. */
  bevel: number
  /** Draft: how far the case's outer face pulls in between where the taper
   * starts and the top of the rim (3D preview), mm. The taper is continuous
   * across the wall and rim; the cavity stays vertical, so the plate still
   * drops in. */
  draft: number
  /** Height above the lid plane where the draft begins, mm. The face below
   * stays vertical, so this sets the break line around the case. */
  draftStart: number
  /** Extra outward case margins per world direction, mm. On split cases the
   * left/right margins apply to each half's outward edge only. */
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
}

export const DEFAULT_BEZEL: BezelSettings = {
  enabled: true,
  mode: 'tight',
  width: 6,
  outset: 1,
  height: 6,
  radiusOuter: 4,
  radiusInner: 1,
  bevel: 1.5,
  draft: 0,
  draftStart: 0,
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
}

export interface BottomSettings {
  enabled: boolean
  /** `tight` is a thin plate hugging the case underside, with posts holding
   * up whatever tilt/tent lift off the desk; `wedge` fills the whole gap down
   * to the desk as one solid. */
  mode: 'tight' | 'wedge'
  /** Bottom plate thickness (also the wedge's thickness at its thinnest
   * point), mm. */
  thickness: number
  /** Shrink the bottom's footprint inward from the case edge, mm — a recessed
   * bottom reads as a shadow line around the case. */
  inset: number
  /** Interior depth below the plate's underside, mm — room for the
   * below-plate switch bodies plus PCB/hotswap sockets or handwiring. */
  clearance: number
  /** Tray ridge: an inset rim running around the lid's edge, rising to the
   * plate's underside so the plate is sandwiched between it and the top
   * case's rim. Width in mm, inward from the case interior; 0 disables. */
  ridge: number
}

/** Clearance needed below the plate's underside per switch type, mm:
 * below-plate body (MX 5.0 / Choc 2.2 from the plate top) plus a 1.6 mm PCB
 * and hotswap socket (or the same room for handwired pins and wires). */
export const SWITCH_CLEARANCE: Record<KeyType, number> = { mx: 7, choc: 4.5 }

export const DEFAULT_BOTTOM: BottomSettings = {
  enabled: true,
  mode: 'tight',
  thickness: 2.5,
  inset: 0,
  clearance: SWITCH_CLEARANCE.mx,
  ridge: 2.5,
}

/** Case mounting: M2 self-tapping screws up through the bottom lid, biting
 * into pilot holes in the bezel wall. Screw positions are generated evenly
 * along the wall centerline, so mounting needs both bezel and bottom. */
export interface MountingSettings {
  enabled: boolean
  /** Target spacing between screws along the wall, mm. */
  spacing: number
}

export const DEFAULT_MOUNTING: MountingSettings = { enabled: true, spacing: 55 }

/** Typing angle in degrees: positive raises the back edge. 3D-preview only
 * for now (plate/foam exports are flat projections regardless). */
export const DEFAULT_TILT = 5

/** One 3D-preview material: color plus surface finish. `specular` (0–1)
 * drives how mirror-like the surface reflects (metalness in the PBR model);
 * `roughness` (0–1) how blurred those reflections are. */
export interface BoardMaterial {
  color: string
  roughness: number
  specular: number
}

export type MaterialSlot = 'plate' | 'case' | 'cap' | 'capAccent'

export const MATERIAL_SLOTS: MaterialSlot[] = ['plate', 'case', 'cap', 'capAccent']

export interface BoardMaterials {
  /** When set, editing any material applies to every slot. */
  linked: boolean
  plate: BoardMaterial
  case: BoardMaterial
  cap: BoardMaterial
  /** Unlabeled keys (thumbs etc.) render in the accent material. */
  capAccent: BoardMaterial
}

export const DEFAULT_MATERIALS: BoardMaterials = {
  linked: true,
  plate: { color: '#000000', roughness: 0.55, specular: 0.55 },
  case: { color: '#000000', roughness: 0.55, specular: 0.55 },
  cap: { color: '#000000', roughness: 0.55, specular: 0.55 },
  capAccent: { color: '#000000', roughness: 0.55, specular: 0.55 },
}

export interface MaterialPreset {
  name: string
  materials: BoardMaterials
}

/** One-click starting looks; rough color stories to tune from, not final. */
export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    name: 'Stealth',
    materials: {
      linked: false,
      plate: { color: '#1b1d22', roughness: 0.4, specular: 0.8 },
      case: { color: '#17181c', roughness: 0.6, specular: 0.35 },
      cap: { color: '#26282e', roughness: 0.85, specular: 0.1 },
      capAccent: { color: '#454a54', roughness: 0.85, specular: 0.1 },
    },
  },
  {
    name: 'Retro',
    materials: {
      linked: false,
      plate: { color: '#8a8f98', roughness: 0.35, specular: 0.85 },
      case: { color: '#d6cfc0', roughness: 0.55, specular: 0.15 },
      cap: { color: '#e9e4d4', roughness: 0.8, specular: 0.05 },
      capAccent: { color: '#d2603a', roughness: 0.8, specular: 0.05 },
    },
  },
  {
    name: 'Milkshake',
    materials: {
      linked: false,
      plate: { color: '#b9bec7', roughness: 0.3, specular: 0.9 },
      case: { color: '#eceae4', roughness: 0.45, specular: 0.2 },
      cap: { color: '#f4f2ec', roughness: 0.75, specular: 0.05 },
      capAccent: { color: '#7fbfa4', roughness: 0.75, specular: 0.05 },
    },
  },
  {
    name: 'Deep Sea',
    materials: {
      linked: false,
      plate: { color: '#b08d57', roughness: 0.35, specular: 0.9 },
      case: { color: '#2a3a52', roughness: 0.5, specular: 0.3 },
      cap: { color: '#dde3ea', roughness: 0.8, specular: 0.05 },
      capAccent: { color: '#e0a458', roughness: 0.8, specular: 0.05 },
    },
  },
  {
    name: 'Bubblegum',
    materials: {
      linked: false,
      plate: { color: '#d8d3de', roughness: 0.35, specular: 0.8 },
      case: { color: '#c9b6e4', roughness: 0.5, specular: 0.2 },
      cap: { color: '#f6f3f7', roughness: 0.75, specular: 0.05 },
      capAccent: { color: '#e2679c', roughness: 0.75, specular: 0.05 },
    },
  },
]

export interface Doc {
  keys: Key[]
  groups: Group[]
  mirror: MirrorSettings
  plate: PlateSettings
  bezel: BezelSettings
  bottom: BottomSettings
  mounting: MountingSettings
  tilt: number
  materials: BoardMaterials
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

/** World axis-aligned bounding box of a key's pitch area. */
export function keyWorldAABB(
  key: Key,
  groups: Map<string, Group>,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const world = keyWorldXF(key, groups)
  const { w, h } = keySize(key)
  const cos = Math.abs(Math.cos(world.r * DEG))
  const sin = Math.abs(Math.sin(world.r * DEG))
  const ew = w * cos + h * sin
  const eh = w * sin + h * cos
  return {
    minX: world.x - ew / 2,
    minY: world.y - eh / 2,
    maxX: world.x + ew / 2,
    maxY: world.y + eh / 2,
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
 * each taking its pitch-area extent plus the layout gap.
 *
 * The first key along the axis stays put, at the group origin and unrotated,
 * and the rest are packed away from it. A thumb cluster is positioned by its
 * inboard key — the one that has to stay reachable from the home row — so
 * that is the one a curve or a gap change must not move; centering the run
 * instead slid the whole cluster every time it was adjusted.
 *
 * With a non-zero curve the keys lie on a genuine circular arc, `curve`
 * being the angle a 1u key turns through. Each key takes the angle its own
 * width earns at the arc's tight radius, so a 2u key turns through twice as
 * much as a 1u one and the curvature stays constant across a run of mixed
 * sizes — the fan is a property of the arc, not of how many keys are on it.
 * Keys' own rotations are overridden in that case, since each has to sit
 * tangent to the arc.
 *
 * `gap` is clearance at the tight side of the arc, where neighbours are
 * closest, so a gap of 0 keeps footprints tangent exactly like a column
 * cluster does however hard the arc bends. */
export function stackPositions(
  layout: Extract<GroupLayout, { kind: 'stack' }>,
  members: Key[],
): Map<string, { x: number; y: number; r?: number }> {
  const ordered = [...members].sort((a, b) =>
    layout.axis === 'x' ? a.x - b.x : b.y - a.y,
  )
  const curve = layout.curve ?? 0
  const n = ordered.length
  const out = new Map<string, { x: number; y: number; r?: number }>()
  if (n === 0) return out

  /** Extent along the packing direction, and across it. */
  const along = (k: Key) => (layout.axis === 'x' ? keySize(k).w : keySize(k).h)
  const across = (k: Key) => (layout.axis === 'x' ? keySize(k).h : keySize(k).w)
  // Forward is the packing direction; left is forward turned 90° CCW, which
  // is the side the arc's centre sits on for a positive curve.
  const fwd = layout.axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: -1 }
  const left = layout.axis === 'x' ? { x: 0, y: 1 } : { x: 1, y: 0 }

  if (curve === 0) {
    // Unrotated keys take their own extent; a key carrying a rotation of its
    // own takes the extent of its rotated bounding box, so it still cannot
    // collide with its neighbours.
    const extents = ordered.map((k) => {
      const { w, h } = keySize(k)
      const cos = Math.abs(Math.cos(k.r * DEG))
      const sin = Math.abs(Math.sin(k.r * DEG))
      return layout.axis === 'x' ? w * cos + h * sin : w * sin + h * cos
    })
    let cursor = 0
    ordered.forEach((k, i) => {
      if (i > 0) cursor += extents[i - 1] / 2 + layout.gap + extents[i] / 2
      out.set(k.id, { x: fwd.x * cursor, y: fwd.y * cursor })
    })
    return out
  }

  const dir = Math.sign(curve)
  // Radius at which a 1u key subtends `curve` degrees. Steps are measured
  // here, at the inside of the bend, because that is where neighbouring
  // footprints close on each other.
  const tight = U / (Math.abs(curve) * DEG)
  const halfAcross = Math.max(...ordered.map((k) => across(k) / 2))
  // Centre-line radius, signed so the arc bends left for a positive curve.
  const radius = dir * (tight + halfAcross)

  let angle = 0
  ordered.forEach((k, i) => {
    if (i > 0) {
      const step = along(ordered[i - 1]) / 2 + layout.gap + along(k) / 2
      angle += (dir * step) / tight
    }
    const advance = radius * Math.sin(angle)
    const sweep = radius * (1 - Math.cos(angle))
    out.set(k.id, {
      x: fwd.x * advance + left.x * sweep,
      y: fwd.y * advance + left.y * sweep,
      r: Math.round((angle / DEG) * 100) / 100,
    })
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
    bezel: { ...DEFAULT_BEZEL },
    bottom: { ...DEFAULT_BOTTOM },
    mounting: { ...DEFAULT_MOUNTING },
    tilt: DEFAULT_TILT,
    materials: structuredClone(DEFAULT_MATERIALS),
  }
}
