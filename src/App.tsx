import { useState } from 'react'
import { EditorCanvas } from './editor/EditorCanvas'
import { Preview3D } from './preview/Preview3D'
import { Inspector } from './ui/Inspector'
import { useTheme } from './ui/theme'
import { Toolbar } from './ui/Toolbar'
import './App.css'

export default function App() {
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const theme = useTheme((s) => s.theme)
  const toggleTheme = useTheme((s) => s.toggle)

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
        </nav>
        <Toolbar />
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
        {view === '2d' ? <EditorCanvas key={theme} /> : <Preview3D key={theme} />}
        <Inspector />
      </main>
    </div>
  )
}
