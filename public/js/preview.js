// Three.js preview of the printable parts.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

/** Read the start-screen model (public/demo/intro.bin, made by tools/make-intro-model.mjs). */
export async function loadIntroModel(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`intro model ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'TPI1') throw new Error('intro model: bad header');
  const n = dv.getUint32(4, true);
  let o = 8;
  const parts = [];
  for (let k = 0; k < n; k++) {
    const colour = '#' + [0, 1, 2].map(i => dv.getUint8(o + i).toString(16).padStart(2, '0')).join('');
    const scale = dv.getFloat32(o + 4, true), nv = dv.getUint32(o + 8, true), nt = dv.getUint32(o + 12, true);
    o += 16;
    const q = new Int16Array(buf.slice(o, o + nv * 6));
    o += nv * 6 + ((nv * 6) % 4 ? 2 : 0);
    const indices = new Uint32Array(new Uint16Array(buf.slice(o, o + nt * 6)));
    o += nt * 6 + ((nt * 6) % 4 ? 2 : 0);
    const positions = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) positions[i] = q[i] * scale;
    parts.push({ key: `intro${k}`, name: `intro${k}`, colour, positions, indices });
  }
  return parts;
}

export class Preview {
  /** spin: turn slowly on its own (start screen); not if the visitor prefers reduced motion. */
  constructor(container, { spin = false } = {}) {
    this.spin = spin && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    // Draw only when something changed (saves battery while the page sits idle).
    this.dirty = true;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    const loop = () => {
      this.controls.update();
      // Start screen: roll slowly over the north-south axis, so the back (and its text) comes round too.
      if (this.spin && this.group.children.length) { this.flip.rotation.z += 0.005; this.dirty = true; }
      this.seeThroughPlate();
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
    this.plateMaterials = [slab.material, g.children[g.children.length - 1].material];
    this.plateBelow = null; // re-applied on the next frame
    if (tower) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(35, 35, 18),
        new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
      box.position.set(tower.x, tower.y, 9);
      box.renderOrder = 10; // see-through: draw after everything else so nothing paints over it
      g.add(box);
    }
    g.visible = this.flip.rotation.z === 0;
    this.scene.add(g);
    this.plate = g;
    this.plateSize = Math.max(plate.w, plate.d);
    this.dirty = true; // the view is not re-framed: zoom stays where the visitor left it
  }

  /** Where the tile sits on the plate (mm from the plate centre, x east, y north). */
  setTileOffset(off) {
    this.tileOffset = off || { x: 0, y: 0 };
    this.placeTile();
  }
  placeTile() {
    const o = this.currentView === 'under' ? { x: 0, y: 0 } : (this.tileOffset || { x: 0, y: 0 });
    this.group.position.set(o.x, 0, -o.y); // model y (north) is scene -z
    this.dirty = true;
  }

  /** From below the plate, fade it so the text on the tile's underside shows through. */
  seeThroughPlate() {
    if (!this.plateMaterials) return;
    const below = this.camera.position.y < 0;
    if (below === this.plateBelow) return;
    this.plateBelow = below;
    // Only see-through while below: an opaque plate marked transparent is drawn late and
    // paints over the (see-through) purge tower.
    for (const m of this.plateMaterials) {
      m.transparent = below;
      m.opacity = below ? 0.15 : 1;
      m.depthWrite = !below;
      m.needsUpdate = true;
    }
    this.dirty = true;
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
    this.placeTile(); // the Underside view turns the tile over in the middle
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

  /** Stop drawing and give the browser its graphics memory back. */
  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  snapshot() { return this.renderer.domElement.toDataURL('image/png'); }
}
