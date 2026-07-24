# keebforge

Visual designer for ergonomic keyboard layouts, in the browser.

**Live:** https://kebabskal.github.io/keebforge/

## Goals

- Per-key MX / Choc support
- Free move/rotate of keys, with snapping
- Groups with automatic layout (column stagger, splay) that can nest
- Live mirroring for split layouts
- Key labels
- Realistic 3D preview (PCB, switches, keycaps)
- Export: DXF/STEP for Fusion 360, KiCad PCB → gerbers for JLCPCB

## Development

```
bun install
bun dev
```

`bun run build` produces the static site in `dist/`. Pushes to `main` deploy to GitHub Pages automatically.

## Stack

Vite + React + TypeScript, Three.js for both the 2D editor and 3D preview, zustand for the document store.
