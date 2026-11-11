#!/usr/bin/env bash
# Copies the browser libraries and font into public/vendor (generated, not committed).
set -euo pipefail
cd "$(dirname "$0")"
V=public/vendor
mkdir -p "$V"
cp node_modules/three/build/three.module.js "$V/three.module.js"
cp node_modules/three/examples/jsm/controls/OrbitControls.js "$V/OrbitControls.js"
cp node_modules/fflate/esm/browser.js "$V/fflate.js"
cp node_modules/earcut/src/earcut.js "$V/earcut.js"
cp node_modules/opentype.js/dist/opentype.module.js "$V/opentype.module.js"
cp node_modules/@fontsource/fredoka/files/fredoka-latin-600-normal.woff "$V/fredoka-600.woff"
cp node_modules/@fontsource/fredoka/LICENSE "$V/FREDOKA-OFL.txt"
# polygon-clipping ships a self-contained UMD build; wrap it as an ES module.
{ echo 'const module = { exports: {} }; const exports = module.exports;'
  cat node_modules/polygon-clipping/dist/polygon-clipping.umd.js
  echo; echo 'export default module.exports;'; } > "$V/polygon-clipping.js"
cp node_modules/@fontsource/fredoka/files/fredoka-latin-600-normal.woff2 "$V/fredoka-600.woff2"
cp node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2 "$V/atkinson-400.woff2"
cp node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2 "$V/atkinson-700.woff2"
cp node_modules/@fontsource/atkinson-hyperlegible/LICENSE "$V/ATKINSON-OFL.txt"
cp node_modules/pbf/index.js "$V/pbf.js"

# Security headers for the static site. The inline import map is allowed by its hash.
HASH=$(python3 -I -c "
import re, hashlib, base64
s = open('public/index.html').read()
m = re.search(r'<script type=\"importmap\">(.*?)</script>', s, re.S)
print(base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode())")
cat > public/_headers <<HDR
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-$HASH'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://elevation-tiles-prod.s3.amazonaws.com https://tiles.openfreemap.org https://nominatim.openstreetmap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=()
HDR
