import { useState } from 'react'
import { EditorCanvas } from './editor/EditorCanvas'
import { Preview3D } from './preview/Preview3D'
import { Inspector } from './ui/Inspector'
import { Toolbar } from './ui/Toolbar'
import './App.css'

export default function App() {
  const [view, setView] = useState<'2d' | '3d'>('2d')

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
      </header>
      <main>
        {view === '2d' ? <EditorCanvas /> : <Preview3D />}
        <Inspector />
      </main>
    </div>
  )
}
