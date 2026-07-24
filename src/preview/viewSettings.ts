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
  /** Per-part visibility in the 3D preview. */
  showCaps: boolean
  showSwitches: boolean
  showCase: boolean
  showPlate: boolean
  showFoam: boolean
}

export const DEFAULT_VIEW: ViewSettings = {
  fov: 40,
  backdrop: 'table',
  backdropColor: '#e9e6df',
  keyLight: 2.4,
  fillLight: 0.5,
  ambient: 0.75,
  lightAngle: 50,
  shadowBlur: 5,
  ssao: true,
  showCaps: true,
  showSwitches: true,
  showCase: true,
  showPlate: true,
  showFoam: true,
}

const STORAGE_KEY = 'keebforge.view'

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
