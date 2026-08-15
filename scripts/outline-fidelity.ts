/** Guard against geometry regressions while optimizing outline generation.
 *
 *   bun scripts/outline-fidelity.ts capture before.json
 *   ...edit src/model/outline.ts...
 *   bun scripts/outline-fidelity.ts capture after.json
 *   bun scripts/outline-fidelity.ts compare before.json after.json
 *
 * Compare reports symmetric-difference area per shape: the fraction of the
 * shape that moved. Re-sampling a fillet with fewer segments shows up here, so
 * small numbers are expected when resolution changes deliberately; what
 * matters is that nothing jumps. */
import polygonClipping from 'polygon-clipping'
import {
  bezelShape,
  caseBottomOutline,
  caseShells,
  foamWithCutouts,
  pcbOutline,
  plateOutline,
  plateWithCutouts,
  screwPositions,
  setOutlineQuality,
  type MultiPolygon,
} from '../src/model/outline'
import type { Doc } from '../src/model/keys'
import { DOCS } from './testDocs'

const [, , cmd, a, b] = process.argv
if (process.argv.includes('--draft')) setOutlineQuality('draft')

function area(mp: MultiPolygon): number {
  let total = 0
  for (const poly of mp) {
    for (const [i, ring] of poly.entries()) {
      let s = 0
      for (let k = 0; k < ring.length - 1; k++) {
        s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
      }
      total += i === 0 ? Math.abs(s / 2) : -Math.abs(s / 2)
    }
  }
  return total
}

function verts(mp: MultiPolygon): number {
  let n = 0
  for (const poly of mp) for (const ring of poly) n += ring.length
  return n
}

/** Every generated shape a view or an export can ask for. */
function shapesOf(doc: Doc): Record<string, MultiPolygon> {
  const shells = caseShells(doc)
  return {
    plate: plateOutline(doc),
    bezel: bezelShape(doc),
    hull: shells.flatMap((s) => s.hull),
    interior: shells.flatMap((s) => s.interior),
    fit: shells.flatMap((s) => s.fit),
    inner: shells.flatMap((s) => s.inner),
    wall: shells.flatMap((s) => s.wall),
    rim: shells.flatMap((s) => s.rim),
    ridge: shells.flatMap((s) => s.ridge),
    plateCut: plateWithCutouts(doc),
    foam: foamWithCutouts(doc),
    pcb: pcbOutline(doc),
    bottom: caseBottomOutline(doc),
  }
}

/** A mirrored board has to come out symmetric about its axis, so its centroid
 * has to sit exactly on that axis. Reported in mm of offset — an exact
 * measure, computed straight from the ring integrals, with no sampling grid
 * and no call into the clipper (which is the thing under test here and throws
 * on some of these shapes). */
function centroidOffset(mp: MultiPolygon, axis: number): number {
  let sumA = 0
  let sumX = 0
  for (const poly of mp) {
    for (const [index, ring] of poly.entries()) {
      let a = 0
      let cx = 0
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i]
        const [x1, y1] = ring[i + 1]
        const cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
      }
      if (Math.abs(a) < 1e-9) continue
      // Holes carry negative weight regardless of the winding they came in.
      const signed = (index === 0 ? 1 : -1) * Math.abs(a / 2)
      sumA += signed
      sumX += signed * (cx / (3 * a))
    }
  }
  return Math.abs(sumA) < 1e-9 ? 0 : Math.abs(sumX / sumA - axis)
}

if (cmd === 'capture') {
  const out: Record<string, Record<string, { area: number; verts: number; mp: MultiPolygon }>> = {}
  const screws: Record<string, [number, number][]> = {}
  const skew: Record<string, Record<string, number>> = {}
  let totalVerts = 0
  for (const [name, make] of DOCS) {
    const doc = make()
    out[name] = {}
    skew[name] = {}
    for (const [key, mp] of Object.entries(shapesOf(doc))) {
      out[name][key] = { area: area(mp), verts: verts(mp), mp }
      totalVerts += verts(mp)
      if (doc.mirror.enabled) skew[name][key] = centroidOffset(mp, doc.mirror.axis)
    }
    screws[name] = screwPositions(doc)
  }
  // Screw placement has to be a property of the shape, not of how finely it
  // was sampled — `draft` is what every drag rebuilds at, so a layout that
  // depends on resolution is one that jumps around while you edit. Needs no
  // baseline: the two qualities are checked against each other.
  const altQuality = process.argv.includes('--draft') ? 'fine' : 'draft'
  setOutlineQuality(altQuality)
  const drift: string[] = []
  for (const [name, make] of DOCS) {
    const alt = screwPositions(make())
    const ref = screws[name]
    if (alt.length !== ref.length) {
      drift.push(`  ${name}: count ${ref.length} -> ${alt.length} at ${altQuality}`)
      continue
    }
    let worst = 0
    for (const [x, y] of ref) {
      let nearest = Infinity
      for (const [ax, ay] of alt) nearest = Math.min(nearest, Math.hypot(ax - x, ay - y))
      worst = Math.max(worst, nearest)
    }
    // Positions are spread along the ring as tessellated, so a coarser ring
    // slides them a little; that is a refinement along the wall centreline,
    // not a different layout. A changed count, or a screw that has moved to
    // somewhere else entirely, is what this is looking for.
    if (worst > 2) drift.push(`  ${name}: moved ${worst.toFixed(3)} mm at ${altQuality}`)
  }
  setOutlineQuality(process.argv.includes('--draft') ? 'draft' : 'fine')
  console.log(
    drift.length
      ? `SCREW PHASE — ${drift.length} doc(s) depend on resolution:\n${drift.join('\n')}`
      : 'SCREW PHASE — every layout is identical at both qualities',
  )

  const bad = Object.entries(skew).flatMap(([d, s]) =>
    Object.entries(s)
      .filter(([, v]) => v > 0.02 || Number.isNaN(v))
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `  ${d}/${k}: centroid ${v.toFixed(3)} mm off axis`),
  )
  console.log(
    bad.length
      ? `MIRROR SYMMETRY — ${bad.length} shape(s) off axis:\n${bad.join('\n')}`
      : 'MIRROR SYMMETRY — every mirrored shape is centred on its axis',
  )
  await Bun.write(a, JSON.stringify({ shapes: out, screws }))
  console.log(`captured ${DOCS.length} docs, ${totalVerts} total vertices -> ${a}`)
} else if (cmd === 'compare') {
  const before = await Bun.file(a).json()
  const after = await Bun.file(b).json()
  let worst = 0
  let worstName = ''
  let vertsBefore = 0
  let vertsAfter = 0
  const rows: string[] = []
  for (const docName of Object.keys(before.shapes)) {
    for (const shapeName of Object.keys(before.shapes[docName])) {
      const x = before.shapes[docName][shapeName]
      const y = after.shapes[docName]?.[shapeName]
      if (!y) {
        rows.push(`${docName}/${shapeName}: MISSING in after`)
        continue
      }
      vertsBefore += x.verts
      vertsAfter += y.verts
      let diffFrac = 0
      if (x.area > 1e-9 || y.area > 1e-9) {
        try {
          const xorArea = Math.abs(area(polygonClipping.xor(x.mp, y.mp) as MultiPolygon))
          diffFrac = xorArea / Math.max(x.area, y.area, 1e-9)
        } catch {
          diffFrac = Math.abs(x.area - y.area) / Math.max(x.area, y.area, 1e-9)
          rows.push(`${docName}/${shapeName}: xor failed, fell back to area delta`)
        }
      }
      if (diffFrac > worst) {
        worst = diffFrac
        worstName = `${docName}/${shapeName}`
      }
      if (diffFrac > 0.001) {
        rows.push(
          `${(docName + '/' + shapeName).padEnd(28)} moved ${(diffFrac * 100).toFixed(3).padStart(7)}%  ` +
            `verts ${String(x.verts).padStart(5)} -> ${String(y.verts).padStart(5)}`,
        )
      }
    }
    const sb = (before.screws[docName] ?? []) as [number, number][]
    const sa = (after.screws[docName] ?? []) as [number, number][]
    if (sb.length !== sa.length) {
      rows.push(`${docName}/screws: count ${sb.length} -> ${sa.length}`)
    } else {
      let maxMove = 0
      for (let i = 0; i < sb.length; i++) {
        maxMove = Math.max(maxMove, Math.hypot(sb[i][0] - sa[i][0], sb[i][1] - sa[i][1]))
      }
      if (maxMove > 0.05) rows.push(`${docName}/screws: moved up to ${maxMove.toFixed(3)} mm`)
    }
  }
  console.log(rows.join('\n') || 'no shape moved more than 0.1%')
  console.log(
    `\nworst deviation: ${(worst * 100).toFixed(4)}%  (${worstName})` +
      `\nvertices: ${vertsBefore} -> ${vertsAfter} ` +
      `(${(((vertsAfter - vertsBefore) / vertsBefore) * 100).toFixed(1)}%)`,
  )
} else {
  console.log('usage: bun scripts/outline-fidelity.ts capture <file> | compare <before> <after>')
  process.exit(1)
}
