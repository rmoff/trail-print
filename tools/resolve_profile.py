"""Flatten a Bambu Studio system profile (follow 'inherits') into one full JSON for the CLI."""
import json, sys, os

def load(dirpath, name):
    with open(os.path.join(dirpath, name + '.json')) as f:
        return json.load(f)

def resolve(dirpath, name):
    d = load(dirpath, name)
    parent = d.get('inherits')
    base = resolve(dirpath, parent) if parent else {}
    base.update(d)
    base.pop('inherits', None)
    return base

kind, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
root = sys.argv[4]
d = resolve(os.path.join(root, kind), name)
d['from'] = 'system'
with open(out, 'w') as f:
    json.dump(d, f, indent=1)
print(out, len(d), 'keys')
