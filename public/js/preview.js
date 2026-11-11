// Three.js preview of the printable parts.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

export class Preview {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50604f, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-1, 1.2, 1.6);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.6);
    fill.position.set(1, -0.5, -1);
    this.scene.add(fill);
    this.group = new THREE.Group();
    this.group.rotation.x = -Math.PI / 2; // model z-up -> scene y-up
    // "Turn over" pivot: rotating about the model's north-south axis shows the back
    // the way you'd see it holding the tile, text the right way round.
    this.flip = new THREE.Group();
    this.flip.add(this.group);
    this.scene.add(this.flip);
    this.size = 150;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    // Draw only when something changed (saves battery while the page sits idle).
    this.dirty = true;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    const loop = () => {
      this.controls.update();
      if (this.dirty) { this.dirty = false; this.renderer.render(this.scene, this.camera); }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /**
   * The printer's build plate under the tile, for scale: plate {w, d} in mm, and optionally
   * a see-through purge tower at {x, y} (centre, relative to the plate centre).
   */
  setPlate(plate, tower, { tooBig = false } = {}) {
    if (this.plate) {
      this.plate.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
      this.scene.remove(this.plate);
    }
    const g = new THREE.Group();
    g.rotation.x = -Math.PI / 2; // same axes as the model: x east, y north, z up
    const slab = new THREE.Mesh(new THREE.BoxGeometry(plate.w, plate.d, 2),
      new THREE.MeshStandardMaterial({ color: tooBig ? 0x6e2420 : 0x30353a, roughness: 0.85 }));
    slab.position.z = -1.05;
    g.add(slab);
    const pts = [];
    for (let x = 10; x < plate.w; x += 10) pts.push(x - plate.w / 2, -plate.d / 2, 0, x - plate.w / 2, plate.d / 2, 0);
    for (let y = 10; y < plate.d; y += 10) pts.push(-plate.w / 2, y - plate.d / 2, 0, plate.w / 2, y - plate.d / 2, 0);
    const grid = new THREE.BufferGeometry();
    grid.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: tooBig ? 0x9a3a33 : 0x4d555c })));
    if (tower) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(35, 35, 18),
        new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
      box.position.set(tower.x, tower.y, 9);
      g.add(box);
    }
    g.visible = this.flip.rotation.z === 0;
    this.scene.add(g);
    this.plate = g;
    this.plateSize = Math.max(plate.w, plate.d);
    this.dirty = true; // the view is not re-framed: zoom stays where the visitor left it
  }

  /** parts: [{ key, name, colour, positions, indices }] */
  setParts(parts, sizeMm) {
    const firstTime = !this.framed;
    for (const m of this.group.children) { m.geometry.dispose(); m.material.dispose(); }
    this.group.clear();
    for (const p of parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.colour || '#cccccc'),
        roughness: 0.75, metalness: 0, flatShading: p.key !== 'land',
        polygonOffset: p.key === 'land', polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = p.name;
      this.group.add(mesh);
    }
    this.size = sizeMm;
    this.dirty = true;
    if (firstTime) { this.framed = true; this.view('front'); }
  }

  view(which) {
    this.currentView = which;
    // Back off further on narrow (portrait) previews so the whole plate stays in view.
    const narrow = Math.max(1, 1.25 / (this.camera.aspect || 1));
    const d = Math.max(this.size, (this.plateSize || 0) * 0.9) * 2.3 * narrow;
    if (this.plate) this.plate.visible = which !== 'under';
    this.controls.target.set(0, this.size * 0.02, 0);
    this.flip.rotation.z = which === 'under' ? Math.PI : 0;
    this.flip.position.y = which === 'under' ? this.size * 0.06 : 0;
    if (which === 'top' || which === 'under') this.camera.position.set(0, d, 0.01);
    else this.camera.position.set(0, d * 0.62, d * 0.78);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.dirty = true;
  }

  snapshot() { return this.renderer.domElement.toDataURL('image/png'); }
}
