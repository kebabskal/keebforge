import type { MultiPolygon } from '../model/outline'

/** Serialize polygons (with holes) as a minimal DXF with closed LWPOLYLINEs,
 * in millimeters. Accepted by Fusion 360, KiCad, and most CAD importers. */
export function toDXF(shapes: MultiPolygon): string {
  const lines: string[] = [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$ACADVER',
    '1', 'AC1014',
    '9', '$INSUNITS',
    '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'ENTITIES',
  ]
  for (const polygon of shapes) {
    for (const ring of polygon) {
      // Rings repeat the first point at the end; drop it — 70=1 closes it.
      const pts = ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
          ? ring.slice(0, -1)
          : ring
      lines.push('0', 'LWPOLYLINE', '8', '0', '90', String(pts.length), '70', '1')
      for (const [x, y] of pts) {
        lines.push('10', x.toFixed(4), '20', y.toFixed(4))
      }
    }
  }
  lines.push('0', 'ENDSEC', '0', 'EOF')
  return lines.join('\n') + '\n'
}

export function downloadText(filename: string, text: string, type = 'application/dxf') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
