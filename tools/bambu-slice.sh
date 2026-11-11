#!/usr/bin/env bash
# Slice a 3MF with Bambu Studio (Flatpak) for an A1 mini and report colour changes.
# Usage: tools/bambu-slice.sh <in.3mf> <outdir> [nozzle 0.4|0.2] [filament count]
set -uo pipefail
in=$(realpath "$1"); out=$(realpath -m "$2"); noz=${3:-0.4}; nf=${4:-4}
# Resolved profiles made by tools/resolve_profile.py (see README).
P=$(realpath "$(dirname "$0")/../out/profiles")
if [ "$noz" = 0.2 ]; then
  M="$P/full-Bambu Lab A1 mini 0.2 nozzle.json"; PR="$P/full-0.10mm Standard @BBL A1M 0.2 nozzle.json"
else
  M="$P/full-Bambu Lab A1 mini 0.4 nozzle.json"; PR="$P/full-0.12mm Fine @BBL A1M.json"
fi
FL="$P/fil-$noz-1.json"; for ((i=2;i<=nf;i++)); do FL="$FL;$P/fil-$noz-$i.json"; done
mkdir -p "$out"
timeout 900 flatpak run --filesystem="$(dirname "$in")" --filesystem="$out" --filesystem="$P" com.bambulab.BambuStudio \
  --slice 0 --outputdir "$out" --load-settings "$M;$PR" --load-filaments "$FL" "$in" > "$out/slice.log" 2>&1
echo "exit $?"
python3 -I - "$out/result.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print('result:', r.get('error_string'), r.get('return_code'))
for p in r.get('sliced_plates', []):
    print('colour changes:', p['filament_change_times'], '| filaments used:', [f['id'] for f in p['filaments']],
          '| time h:', round(p['total_predication'] / 3600, 2), '| warning:', p.get('warning_message'))
PY
