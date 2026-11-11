// Minimal triangle-mesh builder plus checks used by the tests and the exporters.

export class Mesh {
  constructor(name) {
    this.name = name;
    this.v = [];
    this.t = [];
  }
  get vertexCount() { return this.v.length / 3; }
  get triangleCount() { return this.t.length / 3; }
  add(x, y, z) { this.v.push(x, y, z); return this.v.length / 3 - 1; }
  tri(a, b, c) { if (a !== b && b !== c && a !== c) this.t.push(a, b, c); }

  normal(a, b, c) {
    const v = this.v;
    const ux = v[3 * b] - v[3 * a], uy = v[3 * b + 1] - v[3 * a + 1], uz = v[3 * b + 2] - v[3 * a + 2];
    const wx = v[3 * c] - v[3 * a], wy = v[3 * c + 1] - v[3 * a + 1], wz = v[3 * c + 2] - v[3 * a + 2];
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  }
  /** Add a triangle whose normal points along (nx, ny, nz). */
  triFacing(a, b, c, nx, ny, nz) {
    const [x, y, z] = this.normal(a, b, c);
    if (x * nx + y * ny + z * nz < 0) this.tri(a, c, b); else this.tri(a, b, c);
  }
  /** Add a triangle whose normal points away from point r (for convex pieces). */
  triAway(a, b, c, rx, ry, rz) {
    const v = this.v;
    const cx = (v[3 * a] + v[3 * b] + v[3 * c]) / 3 - rx;
    const cy = (v[3 * a + 1] + v[3 * b + 1] + v[3 * c + 1]) / 3 - ry;
    const cz = (v[3 * a + 2] + v[3 * b + 2] + v[3 * c + 2]) / 3 - rz;
    this.triFacing(a, b, c, cx, cy, cz);
  }
  /** Append another mesh's geometry. */
  append(other) {
    const off = this.vertexCount;
    for (const x of other.v) this.v.push(x);
    for (const i of other.t) this.t.push(i + off);
    return this;
  }
  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.v.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (this.v[i + k] < min[k]) min[k] = this.v[i + k];
        if (this.v[i + k] > max[k]) max[k] = this.v[i + k];
      }
    }
    return { min, max };
  }
  /** Signed volume (positive when every shell is closed and faces outward). */
  volume() {
    const v = this.v, t = this.t;
    let s = 0;
    for (let i = 0; i < t.length; i += 3) {
      const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
      s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1])
         - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c])
         + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
    }
    return s / 6;
  }
  /**
   * Watertight check: every directed edge must be matched by exactly one reverse edge.
   * Returns the number of unmatched or over-used edges (0 = closed and consistently oriented).
   */
  openEdges() {
    const n = this.vertexCount;
    const t = this.t;
    const keys = new Float64Array(t.length);
    for (let i = 0; i < t.length; i += 3) {
      for (let k = 0; k < 3; k++) keys[i + k] = t[i + k] * n + t[i + (k + 1) % 3];
    }
    keys.sort();
    const has = x => {
      let lo = 0, hi = keys.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] < x) lo = mid + 1; else if (keys[mid] > x) hi = mid - 1; else return true; }
      return false;
    };
    let bad = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const dup = (i > 0 && keys[i - 1] === k) || (i + 1 < keys.length && keys[i + 1] === k);
      const a = Math.floor(k / n), b = k - a * n;
      if (dup || !has(b * n + a)) bad++;
    }
    return bad;
  }
}
