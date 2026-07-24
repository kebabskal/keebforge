import { EditorCanvas } from './editor/EditorCanvas'
import { Inspector } from './ui/Inspector'
import { Toolbar } from './ui/Toolbar'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>keebforge</h1>
        <Toolbar />
      </header>
      <main>
        <EditorCanvas />
        <Inspector />
      </main>
    </div>
  )
}
