import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import './App.css'

// Placeholder scene: a 1u keycap-proportioned block on a plate.
// Proves the Three.js + Pages pipeline end to end; replaced by the real editor in M0/M1.
function KeycapScene() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a1f)

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
    camera.position.set(30, 35, 45)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)

    const key = new THREE.Mesh(
      new THREE.BoxGeometry(18, 9, 18),
      new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.55 }),
    )
    key.position.y = 6.5
    scene.add(key)

    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(30, 1.5, 30),
      new THREE.MeshStandardMaterial({ color: 0x2f6f4f, roughness: 0.8 }),
    )
    scene.add(plate)

    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(20, 40, 25)
    scene.add(sun)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      key.rotation.y += 0.005
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div className="scene" ref={mountRef} />
}

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>keebforge</h1>
        <p>visual ergonomic keyboard designer — coming soon</p>
      </header>
      <KeycapScene />
    </div>
  )
}
