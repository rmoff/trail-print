// Elevation from the free, worldwide "Terrarium" tiles hosted on AWS Open Data
// (https://registry.opendata.aws/terrain-tiles/). Each PNG pixel encodes a height:
// metres = R * 256 + G + B / 256 - 32768.

export const TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const MAX_ZOOM = 15;

export function lonToX(lon, z) { return ((lon + 180) / 360) * 2 ** z; }
export function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Pick a zoom level whose pixels are about `metresPerPixel`, within a tile budget. */
export function chooseZoom(bounds, metresPerPixel, maxTiles = 48) {
  const lat = (bounds.south + bounds.north) / 2;
  let z = Math.round(Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / metresPerPixel));
  z = Math.max(1, Math.min(MAX_ZOOM, z));
  while (z > 1 && tileRange(bounds, z).count > maxTiles) z--;
  return z;
}

export function tileRange(b, z) {
  const x0 = Math.floor(lonToX(b.west, z)), x1 = Math.floor(lonToX(b.east, z));
  const y0 = Math.floor(latToY(b.north, z)), y1 = Math.floor(latToY(b.south, z));
  return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/** Bilinear sampler over a decoded grid. meta = { z, x0, y0, width, height } (x0/y0 in tiles). */
export function makeSampler(meta, grid) {
  const { z, width, height } = meta;
  const ox = meta.x0 * 256, oy = meta.y0 * 256;
  return (lat, lon) => {
    let px = lonToX(lon, z) * 256 - ox - 0.5, py = latToY(lat, z) * 256 - oy - 0.5;
    px = Math.max(0, Math.min(width - 1.001, px));
    py = Math.max(0, Math.min(height - 1.001, py));
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const i = iy * width + ix;
    const a = grid[i], b = grid[i + 1], c = grid[i + width], d = grid[i + width + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** One light 3x3 blur pass: hides the stair-steps of upsampled source data. */
export function smooth(grid, width, height) {
  const out = new Float32Array(grid.length);
  const k = [1, 2, 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0, w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          const kw = k[dx + 1] * k[dy + 1];
          s += grid[yy * width + xx] * kw; w += kw;
        }
      }
      out[y * width + x] = s / w;
    }
  }
  return out;
}

/** Browser only: download and decode the tiles covering `bounds`. */
export async function loadDem(bounds, metresPerPixel, { signal, onProgress } = {}) {
  const z = chooseZoom(bounds, metresPerPixel);
  const r = tileRange(bounds, z);
  const nx = r.x1 - r.x0 + 1, ny = r.y1 - r.y0 + 1;
  const width = nx * 256, height = ny * 256;
  const grid = new Float32Array(width * height);
  const jobs = [];
  for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) jobs.push([tx, ty]);
  let done = 0;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const worker = async () => {
    while (jobs.length) {
      const [tx, ty] = jobs.shift();
      const url = TILE_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      let blob;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, { signal, mode: 'cors' });
          if (!res.ok) throw new Error(`terrain tile ${res.status}`);
          blob = await res.blob();
          break;
        } catch (e) {
          if (signal?.aborted || attempt >= 2) throw e;
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      const bmp = await createImageBitmap(blob);
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const ox = (tx - r.x0) * 256, oy = (ty - r.y0) * 256;
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4;
          grid[(oy + y) * width + ox + x] = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
        }
      }
      done++;
      onProgress?.(done / r.count);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  return { meta: { z, x0: r.x0, y0: r.y0, width, height }, grid: smooth(grid, width, height) };
}
