import { create } from 'zustand'

/** 3D-preview presentation settings: camera, lighting, backdrop. Persisted
 * per browser, not part of the document (no undo history). */
export interface ViewSettings {
  /** Camera field of view, degrees. */
  fov: number
  /** `table` is a wooden desk; `studio` is a curved seamless backdrop. */
  backdrop: 'table' | 'studio'
  /** Studio backdrop color. */
  backdropColor: string
  /** Key (sun) light intensity. */
  keyLight: number
  /** Fill light intensity. */
  fillLight: number
  /** Hemisphere/ambient intensity. */
  ambient: number
  /** Key light azimuth around the board, degrees. */
  lightAngle: number
  /** Shadow penumbra blur radius (VSM), 0 = crisp. */
  shadowBlur: number
  /** Screen-space ambient occlusion. */
  ssao: boolean
  /** Exploded-view gap between adjacent parts, mm. 0 = assembled. */
  explode: number
  /** Per-part visibility in the 3D preview. */
  showCaps: boolean
  showSwitches: boolean
  showCase: boolean
  showPlate: boolean
  showPcb: boolean
  showFoam: boolean
  showBottom: boolean
  /** Hiding the screws exposes the countersunk holes they sit in. */
  showScrews: boolean
  /** Draw every triangle edge over the shaded surface. A diagnostic: banding,
   * stray fill and failed booleans all look like shading until you can see
   * the triangles they are made of. */
  wireframe: boolean
}

export const DEFAULT_VIEW: ViewSettings = {
  fov: 20,
  backdrop: 'studio',
  backdropColor: '#0d0d0d',
  keyLight: 2.4,
  fillLight: 0.5,
  ambient: 0.75,
  lightAngle: 50,
  shadowBlur: 25,
  ssao: true,
  explode: 0,
  showCaps: true,
  showSwitches: true,
  showCase: true,
  showPlate: true,
  showPcb: true,
  showFoam: true,
  showBottom: true,
  showScrews: true,
  wireframe: false,
}

// v2: re-seed everyone once with the studio-look defaults.
const STORAGE_KEY = 'keebforge.view.v2'

function load(): ViewSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_VIEW }
}

interface ViewStore extends ViewSettings {
  update: (patch: Partial<ViewSettings>) => void
}

export const useViewSettings = create<ViewStore>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch)
    const { update: _update, ...settings } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // best-effort persistence
    }
  },
}))

/** Where the camera was last left. Kept apart from ViewSettings: it changes
 * on every orbit rather than on a deliberate setting change, and it is tied
 * to a board's size rather than to a preference. */
export interface SavedCamera {
  px: number
  py: number
  pz: number
  tx: number
  ty: number
  tz: number
}

const CAMERA_KEY = 'keebforge.camera.v1'

export function loadCamera(): SavedCamera | null {
  try {
    const raw = localStorage.getItem(CAMERA_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as SavedCamera
    const ok = (['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const).every(
      (k) => typeof c?.[k] === 'number' && Number.isFinite(c[k]),
    )
    // A camera at the target has no direction to look in and would leave the
    // view black, so a degenerate pair is treated as nothing saved.
    if (!ok) return null
    const d = Math.hypot(c.px - c.tx, c.py - c.ty, c.pz - c.tz)
    return d > 1 ? c : null
  } catch {
    return null
  }
}

export function saveCamera(c: SavedCamera) {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(c))
  } catch {
    // best-effort persistence
  }
}
