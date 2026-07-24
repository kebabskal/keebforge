export type KeyType = 'mx' | 'choc'

/** A single key. Position is the key center in millimeters, editor space is
 * x-right / y-up. Rotation is degrees, counter-clockwise, about the key center.
 * Width/height are in keyboard units (1u = one switch pitch). */
export interface Key {
  id: string
  type: KeyType
  x: number
  y: number
  r: number
  w: number
  h: number
  label: string
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

/** True if the point (in mm) falls inside the key's pitch area. */
export function hitTest(key: Key, x: number, y: number): boolean {
  const rad = (key.r * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - key.x
  const dy = y - key.y
  const lx = dx * cos + dy * sin
  const ly = -dx * sin + dy * cos
  const { w, h } = keySize(key)
  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2
}

let counter = 0

export function newId(): string {
  counter += 1
  return `k${Date.now().toString(36)}${counter.toString(36)}`
}

export function makeKey(type: KeyType, x: number, y: number, label = ''): Key {
  return { id: newId(), type, x, y, r: 0, w: 1, h: 1, label }
}

/** Starter document: left half of a 3×5+3 column-staggered ergo board. */
export function defaultKeys(): Key[] {
  const stagger = [0, 2, 6, 3, -1]
  const labels = [
    ['Q', 'W', 'E', 'R', 'T'],
    ['A', 'S', 'D', 'F', 'G'],
    ['Z', 'X', 'C', 'V', 'B'],
  ]
  const keys: Key[] = []
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 3; row++) {
      keys.push(makeKey('mx', col * U, stagger[col] - row * U, labels[row][col]))
    }
  }
  const thumbY = stagger[4] - 3 * U - 4
  for (let i = 0; i < 3; i++) {
    const key = makeKey('mx', 2.5 * U + i * U, thumbY - i * 3, '')
    key.r = -i * 12
    keys.push(key)
  }
  return keys
}
