import { useRef, useState, type ReactNode } from 'react'
import { EditorCanvas } from './editor/EditorCanvas'
import {
  fastEditing,
  meshDetail,
  setFastEditing,
  setMeshDetail,
  type Detail,
} from './model/editQuality'
import { Preview3D } from './preview/Preview3D'
import { Inspector } from './ui/Inspector'
import { useTheme } from './ui/theme'
import { Toolbar } from './ui/Toolbar'
import './App.css'

// Remembered across view switches within the session.
let lastSplit = 0.55

type ViewMode = '2d' | '3d' | 'split'
const VIEW_KEY = 'keebforge.viewmode'

function initialView(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    if (saved === '2d' || saved === '3d' || saved === 'split') return saved
  } catch {
    // fall through to default
  }
  return 'split'
}

/** Top/bottom panes with a draggable divider; fraction is the top pane's
 * share of the height. Both canvases watch their wrapper with a
 * ResizeObserver, so resizing the panes is enough. */
function SplitView({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const [frac, setFrac] = useState(lastSplit)
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div className="split-view" ref={ref}>
      <div className="split-pane" style={{ flexBasis: `${frac * 100}%` }}>
        {top}
      </div>
      <div
        className="split-divider"
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          const rect = ref.current!.getBoundingClientRect()
          const f = (e.clientY - rect.top) / rect.height
          lastSplit = Math.min(0.85, Math.max(0.15, f))
          setFrac(lastSplit)
        }}
      />
      <div className="split-pane">{bottom}</div>
    </div>
  )
}

export default function App() {
  const [view, setViewState] = useState<ViewMode>(initialView)
  const setView = (v: ViewMode) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // best-effort persistence
    }
  }
  const theme = useTheme((s) => s.theme)
  const toggleTheme = useTheme((s) => s.toggle)
  const [fast, setFast] = useState(fastEditing)
  const [detail, setDetail] = useState(meshDetail)

  return (
    <div className="app">
      <header>
        <h1>keebforge</h1>
        <nav className="view-toggle">
          <button className={view === '2d' ? 'active' : ''} onClick={() => setView('2d')}>
            2D
          </button>
          <button className={view === '3d' ? 'active' : ''} onClick={() => setView('3d')}>
            3D
          </button>
          <button
            className={view === 'split' ? 'active' : ''}
            onClick={() => setView('split')}
          >
            2D+3D
          </button>
        </nav>
        <Toolbar />
        <select
          className="detail-select"
          value={detail}
          onChange={(e) => {
            const next = e.target.value as Detail
            setMeshDetail(next)
            setDetail(next)
          }}
          title="Mesh detail: how finely fillets and openings are sampled, in both views and in every export"
        >
          <option value="low">Detail: low</option>
          <option value="medium">Detail: medium</option>
          <option value="high">Detail: high</option>
        </select>
        <button
          className={`theme-btn${fast ? ' active' : ''}`}
          onClick={() => {
            setFastEditing(!fast)
            setFast(!fast)
          }}
          title={
            fast
              ? 'Performance mode on: coarser fillets and no chamfers while you drag, full quality once you stop'
              : 'Performance mode off: always draw at full quality'
          }
        >
          ⚡
        </button>
        <button
          className="theme-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      <main>
        {/* Keyed by theme so the Three.js scenes rebuild with the new palette. */}
        {view === '2d' && <EditorCanvas key={theme} />}
        {view === '3d' && <Preview3D key={theme} />}
        {view === 'split' && (
          <SplitView
            top={<EditorCanvas key={theme} />}
            bottom={<Preview3D key={theme} />}
          />
        )}
        <Inspector />
      </main>
    </div>
  )
}
