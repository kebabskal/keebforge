/** Shared document set for the dev benchmark and fidelity scripts: the
 * default board plus the configurations that stress outline generation
 * (splay, split halves, large corner radii, margins). */
import {
  DEFAULT_BEZEL,
  DEFAULT_BOTTOM,
  DEFAULT_CONTROLLER,
  DEFAULT_MATERIALS,
  DEFAULT_MOUNTING,
  DEFAULT_PLATE,
  DEFAULT_TILT,
  columnSlots,
  defaultDoc,
  makeKey,
  stackPositions,
  U,
  type Doc,
} from '../src/model/keys'

const parsed = await Bun.file(`${import.meta.dir}/../examples/test.json`).json()

export function fromExample(over: Partial<Doc> = {}): Doc {
  return {
    keys: structuredClone(parsed.keys ?? []),
    groups: structuredClone(parsed.groups ?? []),
    mirror: structuredClone(parsed.mirror ?? { enabled: false, axis: 6 * U }),
    plate: { ...DEFAULT_PLATE, ...parsed.plate },
    bezel: { ...DEFAULT_BEZEL, ...parsed.bezel },
    bottom: { ...DEFAULT_BOTTOM, ...parsed.bottom },
    mounting: { ...DEFAULT_MOUNTING, ...parsed.mounting },
    controller: { ...DEFAULT_CONTROLLER, ...parsed.controller },
    tilt: parsed.tilt ?? DEFAULT_TILT,
    materials: structuredClone(DEFAULT_MATERIALS),
    ...over,
  }
}

/** Rebuild a column group's keys from its layout — the store does this on
 * every layout edit, and key positions are what the outline is built from, so
 * changing `columns` without it would leave the board untouched. */
function regenerate(doc: Doc): Doc {
  for (const g of doc.groups) {
    if (g.layout.kind !== 'columns') continue
    const layout = g.layout
    doc.keys = doc.keys.filter((k) => k.groupId !== g.id)
    for (const slot of columnSlots(layout)) {
      doc.keys.push({
        ...makeKey(layout.keyType, slot.x, slot.y),
        r: slot.r,
        groupId: g.id,
        col: slot.col,
        row: slot.row,
      })
    }
  }
  return doc
}

/** Splay the finger columns, which is what makes outlines hard: angled pitch
 * areas cross and leave the nubs and wedges the pipeline exists to clean up. */
export function splayed(deg: number, rows = 3): Doc {
  const doc = defaultDoc()
  for (const g of doc.groups) {
    if (g.layout.kind !== 'columns') continue
    g.layout.rows = rows
    g.layout.columns = g.layout.columns.map((c, i) => ({ ...c, splay: (i - 2) * deg }))
  }
  return regenerate(doc)
}

/** A curved thumb stack of mixed key widths, which is the shape the arc band
 * in outline.ts exists for. `gap` matters: with the keys tangent the union of
 * their footprints is already smooth and the band changes nothing, but once
 * they are held apart the junctions notch, and at 4 mm they cut 17 mm into
 * the outline. Nothing else in this set exercises a stack layout at all. */
export function thumbArc(curve: number, gap: number): Doc {
  const doc = defaultDoc()
  const thumbs = doc.groups.find((g) => g.layout.kind === 'free')
  if (!thumbs) return doc
  thumbs.layout = { kind: 'stack', axis: 'x', gap, curve }
  const made = [1, 1.25, 1.5, 1, 1].map((w, i) => ({
    ...makeKey('mx', i * U, 0),
    w,
    groupId: thumbs.id,
  }))
  const placed = stackPositions(thumbs.layout, made)
  doc.keys = [
    ...doc.keys.filter((k) => k.groupId !== thumbs.id),
    ...made.map((k) => {
      const p = placed.get(k.id)
      return p ? { ...k, x: p.x, y: p.y, r: p.r ?? k.r } : k
    }),
  ]
  return doc
}

/** A wide board: more keys means a longer outline, which is what the clipper's
 * cost actually scales with. */
export function wide(cols: number, rows: number): Doc {
  const doc = defaultDoc()
  for (const g of doc.groups) {
    if (g.layout.kind !== 'columns') continue
    g.layout.rows = rows
    g.layout.columns = Array.from({ length: cols }, (_, i) => ({
      stagger: [0, 2, 6, 3, -1][i % 5],
      splay: 0,
    }))
  }
  return regenerate(doc)
}

/** Name → factory, so each benchmark run can build a pristine document (the
 * outline caches key on object identity). */
export const DOCS: [string, () => Doc][] = [
  ['default(tight)', () => defaultDoc()],
  ['default(box)', () => ({ ...defaultDoc(), bezel: { ...DEFAULT_BEZEL, mode: 'box' } })],
  [
    'default(split)',
    () => {
      const d = defaultDoc()
      return { ...d, mirror: { ...d.mirror, split: true, tent: 8, rotation: 10 } }
    },
  ],
  [
    'default(r0)',
    () => ({ ...defaultDoc(), bezel: { ...DEFAULT_BEZEL, radiusOuter: 0, radiusInner: 0 } }),
  ],
  [
    'default(r6)',
    () => ({ ...defaultDoc(), bezel: { ...DEFAULT_BEZEL, radiusOuter: 6, radiusInner: 4 } }),
  ],
  [
    'default(margins)',
    () => ({
      ...defaultDoc(),
      bezel: { ...DEFAULT_BEZEL, marginTop: 8, marginBottom: 12, marginLeft: 5, marginRight: 5 },
    }),
  ],
  [
    'default(inset)',
    () => {
      const d = defaultDoc()
      return { ...d, bottom: { ...d.bottom, inset: 1.5 } }
    },
  ],
  [
    'default(noridge)',
    () => {
      const d = defaultDoc()
      return { ...d, bottom: { ...d.bottom, ridge: 0 } }
    },
  ],
  [
    'default(nobezel)',
    () => ({ ...defaultDoc(), bezel: { ...DEFAULT_BEZEL, enabled: false } }),
  ],
  ['thumbarc(gap4)', () => thumbArc(12, 4)],
  ['splay8', () => splayed(8)],
  ['splay20', () => splayed(20)],
  ['wide(8x4)', () => wide(8, 4)],
  ['example(tight)', () => fromExample({ bezel: { ...DEFAULT_BEZEL, ...parsed.bezel, mode: 'tight' } })],
  ['example(box)', () => fromExample({ bezel: { ...DEFAULT_BEZEL, ...parsed.bezel, mode: 'box' } })],
]
