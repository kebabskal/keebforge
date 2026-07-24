/** Dev script: render generated outlines (plate + bezel + caps) as SVG.
 * Run: bun scripts/render-outlines.ts [layout.json] [tight|box] > out.svg */
import {
  capSize,
  keyWorldXF,
  isKeyMirrored,
  DEFAULT_BEZEL,
  DEFAULT_MATERIALS,
  DEFAULT_PLATE,
  DEFAULT_TILT,
  U,
  type Doc,
} from '../src/model/keys'
import { groupMap } from '../src/model/store'
import { bezelShape, plateOutline, type MultiPolygon } from '../src/model/outline'

const path = process.argv[2] ?? `${import.meta.dir}/../examples/test.json`
const mode = (process.argv[3] as 'tight' | 'box') ?? undefined
const parsed = await Bun.file(path).json()
const doc: Doc = {
  keys: parsed.keys ?? [],
  groups: parsed.groups ?? [],
  mirror: parsed.mirror ?? { enabled: false, axis: 6 * U },
  plate: { ...DEFAULT_PLATE, ...parsed.plate },
  bezel: { ...DEFAULT_BEZEL, ...parsed.bezel, ...(mode ? { mode } : {}) },
  tilt: parsed.tilt ?? DEFAULT_TILT,
  materials: structuredClone(DEFAULT_MATERIALS),
}

const plate = plateOutline(doc)
const bezel = bezelShape(doc)

const pathOf = (mp: MultiPolygon) =>
  mp
    .map((poly) =>
      poly
        .map(
          (ring) =>
            'M' + ring.map(([x, y]) => `${x.toFixed(3)},${(-y).toFixed(3)}`).join('L') + 'Z',
        )
        .join(''),
    )
    .join('')

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
for (const mp of [plate, bezel]) {
  for (const poly of mp) {
    for (const [x, y] of poly[0]) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, -y)
      maxY = Math.max(maxY, -y)
    }
  }
}
const pad = 5
const vb = `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + 2 * pad).toFixed(1)} ${(maxY - minY + 2 * pad).toFixed(1)}`

const groups = groupMap(doc.groups)
const caps: string[] = []
for (const key of doc.keys) {
  const worlds = [keyWorldXF(key, groups)]
  if (doc.mirror.enabled && isKeyMirrored(key, groups)) {
    const w = worlds[0]
    worlds.push({ x: 2 * doc.mirror.axis - w.x, y: w.y, r: -w.r })
  }
  const { w, h } = capSize(key)
  for (const world of worlds) {
    caps.push(
      `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="1.5" transform="translate(${world.x},${-world.y}) rotate(${-world.r})" fill="#dfe8e4" stroke="#b8c4be" stroke-width="0.3"/>`,
    )
  }
}

console.log(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="1400">
<rect x="${minX - pad}" y="${minY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#f4f4f6"/>
<path d="${pathOf(bezel)}" fill="#c8cddb" fill-rule="evenodd" stroke="#5a6478" stroke-width="0.4"/>
<path d="${pathOf(plate)}" fill="none" stroke="#c06060" stroke-width="0.4"/>
${caps.join('\n')}
</svg>`)
