#!/usr/bin/env python3
"""Create independent extension and companion-skill import archives."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT=Path(__file__).resolve().parent
OUTPUT=ROOT/'dist'
OUTPUT.mkdir(exist_ok=True)
VERSION=json.loads((ROOT/'package.json').read_text())['version']


def archive(name, files):
    target=OUTPUT/(name+'-'+VERSION+'.zip')
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as output:
        for source,destination in sorted(files):
            info=zipfile.ZipInfo(destination,(2026,11,6,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644<<16
            output.writestr(info,source.read_bytes())
    return dict(file=target.name,bytes=target.stat().st_size,sha256=hashlib.sha256(target.read_bytes()).hexdigest())


files=[(ROOT/name,name) for name in ['package.json','aether.mjs','agent.mjs','LICENSE']]
files += [(file,file.relative_to(ROOT).as_posix()) for file in (ROOT/'lib').iterdir() if file.is_file()]
skill=ROOT/'skills/storylab'
skill_files=[(file,file.relative_to(skill).as_posix()) for file in skill.rglob('*') if file.is_file()] + [(ROOT/'LICENSE','LICENSE')]
artifacts=[archive('aether-epub-library',files),archive('storylab-skill',skill_files)]
(OUTPUT/'ARTIFACTS.json').write_text(json.dumps(artifacts,indent=2)+'\n')
(OUTPUT/'SHA256SUMS').write_text(''.join(item['sha256']+'  '+item['file']+'\n' for item in artifacts))
print(json.dumps(artifacts,indent=2))
