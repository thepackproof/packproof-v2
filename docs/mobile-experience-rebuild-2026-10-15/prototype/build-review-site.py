#!/usr/bin/env python3
"""Assemble a static review site beside the separately exported PDFs.
Requires markdown2. Does not build or modify the production mobile application.
"""
import html, shutil, sys
from pathlib import Path
import markdown2
prototype=Path(__file__).resolve().parent;root=prototype.parent
dist=Path(sys.argv[1]);dist.mkdir(parents=True,exist_ok=True);packet=dist/'packet';packet.mkdir(exist_ok=True)
shutil.copyfile(prototype/'index.html',dist/'index.html')
(dist/'review.html').write_text((root/'review.html').read_text().replace('.md"','.html"'))
sources={name:root/name for name in ['G0_NAVIGATION_AUDIT.md','G0_EVIDENCE_AUDIT.md','REFERENCE_DECISIONS.md','DEVICE_ACCEPTANCE.md']}
sources.update({name:prototype/name for name in ['README.md','VERIFICATION.md','STATE_MATRIX.md','COPY_AND_TOKENS.md','DESIGN_RENDERING.md']})
sources['AUDIT_STATUS.md']=root/'README.md'
css='*{box-sizing:border-box}body{margin:0;color:#192a3e;background:#f5f8fc;font:16px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:30px 24px 70px}h1{font-size:32px;line-height:1.15}h2{margin-top:32px}a{color:#175ba8}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:14px}th,td{padding:10px;border:1px solid #cfdbe8;vertical-align:top;text-align:left}th{background:#e8f1fc}pre{padding:16px;background:#e8eef5;white-space:pre-wrap;overflow-wrap:anywhere}code{font-size:.85em;overflow-wrap:anywhere}nav{display:flex;gap:22px;flex-wrap:wrap}li{margin:7px 0}'
for name,path in sources.items():
    text=path.read_text();shutil.copyfile(path,packet/name)
    content=markdown2.markdown(text,extras=['tables','fenced-code-blocks','strike'])
    page='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html.escape(name.removesuffix('.md'))+'</title><style>'+css+'</style></head><body><main><nav><a href="../review.html">Review overview</a><a href="../index.html">Interactive prototype</a><a href="'+name+'">Download Markdown</a></nav>'+content+'</main></body></html>'
    (packet/Path(name).with_suffix('.html')).write_text(page)
for name in ['render-manifest.json','screen-state-matrix.json','prototype-checks.txt']:
    shutil.copyfile(prototype/name,packet/name)
print(dist)
