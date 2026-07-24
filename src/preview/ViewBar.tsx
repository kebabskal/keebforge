import { useState } from 'react'
import { ColorField, SliderField } from '../ui/fields'
import { useViewSettings } from './viewSettings'

const PARTS = [
  ['showCaps', 'Caps'],
  ['showSwitches', 'Switches'],
  ['showCase', 'Case'],
  ['showPlate', 'Plate'],
  ['showFoam', 'Foam'],
  ['showBottom', 'Bottom'],
] as const

/** Overlay toolbar at the bottom of the 3D view: per-part visibility
 * toggles plus a flyout with camera/lighting settings. */
export function ViewBar() {
  const view = useViewSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="viewbar">
      {settingsOpen && (
        <div className="viewbar-panel">
          <SliderField
            label="Camera FOV"
            value={view.fov}
            min={10}
            max={100}
            step={1}
            unit="°"
            onCommit={(fov) => view.update({ fov })}
          />
          <div className="viewbar-panel-row">
            <label className="field">
              <span>Backdrop</span>
              <select
                value={view.backdrop}
                onChange={(e) =>
                  view.update({ backdrop: e.target.value as 'table' | 'studio' })
                }
              >
                <option value="table">Table</option>
                <option value="studio">Studio</option>
              </select>
            </label>
            <ColorField
              label="Color"
              value={view.backdropColor}
              onCommit={(backdropColor) => view.update({ backdropColor })}
            />
          </div>
          <SliderField
            label="Light angle"
            value={view.lightAngle}
            min={0}
            max={360}
            step={5}
            unit="°"
            onCommit={(lightAngle) => view.update({ lightAngle })}
          />
          <SliderField
            label="Key light"
            value={view.keyLight}
            min={0}
            max={5}
            step={0.1}
            onCommit={(keyLight) => view.update({ keyLight })}
          />
          <SliderField
            label="Fill light"
            value={view.fillLight}
            min={0}
            max={2}
            step={0.05}
            onCommit={(fillLight) => view.update({ fillLight })}
          />
          <SliderField
            label="Ambient"
            value={view.ambient}
            min={0}
            max={2}
            step={0.05}
            onCommit={(ambient) => view.update({ ambient })}
          />
          <SliderField
            label="Shadow blur"
            value={view.shadowBlur}
            min={1}
            max={25}
            step={1}
            onCommit={(shadowBlur) => view.update({ shadowBlur })}
          />
          <label className="field field-check">
            <span>Ambient occlusion</span>
            <input
              type="checkbox"
              checked={view.ssao}
              onChange={(e) => view.update({ ssao: e.target.checked })}
            />
          </label>
        </div>
      )}
      <div className="viewbar-row">
        {PARTS.map(([field, label]) => (
          <button
            key={field}
            className={view[field] ? 'active' : ''}
            onClick={() => view.update({ [field]: !view[field] })}
            title={view[field] ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          >
            {label}
          </button>
        ))}
        <span className="viewbar-sep" />
        <button
          className={settingsOpen ? 'active' : ''}
          onClick={() => setSettingsOpen((v) => !v)}
          title="Camera & lighting settings"
        >
          ⚙
        </button>
      </div>
    </div>
  )
}
