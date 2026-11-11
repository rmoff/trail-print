// 3MF and STL writers.
//
// Two 3MF layouts, because the slicers disagree about multi-part objects:
//
// write3mfBambu  - Bambu Studio's own project layout (also read by OrcaSlicer): an assembly
//   object in 3D/3dmodel.model whose components live in 3D/Objects/object_1.model, plus
//   Metadata/model_settings.config naming each part, assigning its filament slot and placing
//   it on plate 1. The Application tag says BambuStudio: Bambu Studio only honours part
//   filaments and plate data for files it recognises as its own; a third-party 3MF goes
//   down a "geometry and colour only" path that can leave the object unprintable.
//   No project settings are included, so Bambu loads the geometry with the user's own
//   printer and adds filaments to match the slots.
//
// write3mfPrusa  - PrusaSlicer's layout (core 3MF, one object, one mesh) with the parts as
//   triangle ranges in Metadata/Slic3r_PE_model.config. Cura and others read it as one body.

import { zipSync, strToU8 } from '../vendor/fflate.js';

const num = x => {
  const s = (Math.round(x * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};
// XML-escape, dropping characters XML 1.0 does not allow (a GPX name could contain them).
const esc = s => String(s)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const BBS_NS = 'http://schemas.bambulab.com/package/2021';
const REL_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="config" ContentType="text/xml"/>\n</Types>\n';
const rels = target => `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="${target}" Id="rel-1" Type="${REL_MODEL}"/>\n</Relationships>\n`;
// A Bambu Studio version old enough not to trigger "made by a newer version" warnings,
// new enough (>= 2.0) to skip its conversions for old projects.
const BAMBU_APP = 'BambuStudio-02.00.00.00';

const uuid = (prefix, n) => `${prefix}${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

/** Append <vertices>/<triangles> of a mesh (vertex index offset `off`) to chunks. */
function meshBody(mesh, chunks) {
  const v = mesh.v;
  let buf = [];
  for (let i = 0; i < v.length; i += 3) {
    buf.push(`     <vertex x="${num(v[i])}" y="${num(v[i + 1])}" z="${num(v[i + 2])}"/>\n`);
    if (buf.length > 5000) { chunks.push(buf.join('')); buf = []; }
  }
  chunks.push(buf.join(''));
}
function triBody(mesh, chunks, off = 0) {
  const t = mesh.t;
  let buf = [];
  for (let i = 0; i < t.length; i += 3) {
    buf.push(`     <triangle v1="${t[i] + off}" v2="${t[i + 1] + off}" v3="${t[i + 2] + off}"/>\n`);
    if (buf.length > 5000) { chunks.push(buf.join('')); buf = []; }
  }
  chunks.push(buf.join(''));
}

/** Centre parts on the plate (x, y) for slicers that do not auto-arrange. */
function bedOffset(parts, opts) {
  const bw = opts.bedW || opts.bed || 180, bd = opts.bedD || opts.bed || 180;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    const b = p.mesh.bounds();
    minX = Math.min(minX, b.min[0]); minY = Math.min(minY, b.min[1]);
    maxX = Math.max(maxX, b.max[0]); maxY = Math.max(maxY, b.max[1]);
  }
  return [bw / 2 + (opts.tileX || 0) - (minX + maxX) / 2, bd / 2 + (opts.tileY || 0) - (minY + maxY) / 2];
}

const toBytes = chunks => {
  const enc = new TextEncoder();
  return concat(chunks.map(c => enc.encode(c)));
};

/** Bambu Studio / OrcaSlicer project. parts: [{ name, slot, mesh }] */
export function write3mfBambu(parts, opts = {}) {
  const title = esc(opts.title || 'Trail print');
  const [ox, oy] = bedOffset(parts, opts);
  const date = new Date().toISOString().slice(0, 10);
  const assemblyId = parts.length + 1;

  const obj = ['<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="${BBS_NS}" xmlns:p="${PROD_NS}" requiredextensions="p">\n`,
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n'];
  parts.forEach((p, i) => {
    obj.push(`  <object id="${i + 1}" p:UUID="${uuid('0001', i)}" type="model">\n   <mesh>\n    <vertices>\n`);
    meshBody(p.mesh, obj);
    obj.push('    </vertices>\n    <triangles>\n');
    triBody(p.mesh, obj);
    obj.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  obj.push(' </resources>\n</model>\n');

  const root = ['<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="${BBS_NS}" xmlns:p="${PROD_NS}" requiredextensions="p">\n`,
    ` <metadata name="Application">${BAMBU_APP}</metadata>\n`,
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n',
    ` <metadata name="Title">${title}</metadata>\n`,
    ` <metadata name="CreationDate">${date}</metadata>\n <metadata name="ModificationDate">${date}</metadata>\n`,
    ' <resources>\n',
    `  <object id="${assemblyId}" p:UUID="${uuid('0000', 1)}" type="model">\n   <components>\n`];
  parts.forEach((p, i) => root.push(`    <component p:path="/3D/Objects/object_1.model" objectid="${i + 1}" p:UUID="${uuid('0002', i)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`));
  root.push('   </components>\n  </object>\n </resources>\n');
  root.push(` <build p:UUID="${uuid('0003', 0)}">\n  <item objectid="${assemblyId}" p:UUID="${uuid('0004', 0)}" transform="1 0 0 0 1 0 0 0 1 ${num(ox)} ${num(oy)} 0" printable="1"/>\n </build>\n</model>\n`);

  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n',
    `  <object id="${assemblyId}">\n    <metadata key="name" value="${title}"/>\n    <metadata key="extruder" value="${parts[0].slot}"/>\n`];
  parts.forEach((p, i) => {
    cfg.push(`    <part id="${i + 1}" subtype="normal_part">\n`,
      `      <metadata key="name" value="${esc(p.name)}"/>\n`,
      '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n',
      `      <metadata key="extruder" value="${p.slot}"/>\n`,
      '    </part>\n');
  });
  cfg.push('  </object>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n',
    `    <model_instance>\n      <metadata key="object_id" value="${assemblyId}"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>\n</config>\n`);

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(rels('/3D/3dmodel.model')),
    '3D/3dmodel.model': strToU8(root.join('')),
    '3D/_rels/3dmodel.model.rels': strToU8(rels('/3D/Objects/object_1.model')),
    '3D/Objects/object_1.model': [toBytes(obj), { level: 6 }],
    'Metadata/model_settings.config': strToU8(cfg.join('')),
  }, { level: 6 });
}

/** PrusaSlicer (and generic) 3MF: one mesh, parts as triangle ranges. */
export function write3mfPrusa(parts, opts = {}) {
  const title = esc(opts.title || 'Trail print');
  const [ox, oy] = bedOffset(parts, opts);
  const chunks = ['<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n`,
    ' <metadata name="slic3rpe:Version3mf">1</metadata>\n',
    ` <metadata name="Title">${title}</metadata>\n`,
    ' <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n'];
  for (const p of parts) meshBody(p.mesh, chunks);
  chunks.push('    </vertices>\n    <triangles>\n');
  const ranges = [];
  let vOff = 0, tOff = 0;
  for (const p of parts) {
    triBody(p.mesh, chunks, vOff);
    ranges.push([tOff, tOff + p.mesh.triangleCount - 1]);
    vOff += p.mesh.vertexCount; tOff += p.mesh.triangleCount;
  }
  chunks.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n');
  chunks.push(` <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${num(ox)} ${num(oy)} 0" printable="1"/>\n </build>\n</model>\n`);

  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n',
    `  <metadata type="object" key="name" value="${title}"/>\n`];
  parts.forEach((p, i) => {
    cfg.push(`  <volume firstid="${ranges[i][0]}" lastid="${ranges[i][1]}">\n`,
      `   <metadata type="volume" key="name" value="${esc(p.name)}"/>\n`,
      '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n',
      `   <metadata type="volume" key="extruder" value="${p.slot}"/>\n`,
      '  </volume>\n');
  });
  cfg.push(' </object>\n</config>\n');

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(rels('/3D/3dmodel.model')),
    '3D/3dmodel.model': [toBytes(chunks), { level: 6 }],
    'Metadata/Slic3r_PE_model.config': strToU8(cfg.join('')),
  }, { level: 6 });
}

function concat(arrays) {
  let n = 0;
  for (const a of arrays) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

/** Binary STL of all parts merged (for one-colour printing or older software). */
export function writeStl(parts) {
  let triCount = 0;
  for (const p of parts) triCount += p.mesh.triangleCount;
  const buf = new ArrayBuffer(84 + 50 * triCount);
  const dv = new DataView(buf);
  const header = 'Trail print STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (const p of parts) {
    const v = p.mesh.v, t = p.mesh.t;
    for (let i = 0; i < t.length; i += 3) {
      const [nx, ny, nz] = p.mesh.normal(t[i], t[i + 1], t[i + 2]);
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
      o += 12;
      for (let k = 0; k < 3; k++) {
        const j = 3 * t[i + k];
        dv.setFloat32(o, v[j], true); dv.setFloat32(o + 4, v[j + 1], true); dv.setFloat32(o + 8, v[j + 2], true);
        o += 12;
      }
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
