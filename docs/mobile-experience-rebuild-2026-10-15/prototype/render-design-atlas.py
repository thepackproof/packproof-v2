#!/usr/bin/env python3
"""Render exported HTML with WeasyPrint, then assemble a labeled review atlas.
These are static document renders with explicit print compatibility rules.
They are NOT pixel-equivalent browser screenshots or Android evidence.
Deps: weasyprint, pymupdf, reportlab. Run export-design-frames.cjs first.
"""
import sys,json,logging,hashlib
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import fitz
from weasyprint import HTML
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
logging.getLogger('weasyprint').setLevel(logging.ERROR)
root=Path(sys.argv[1]);output=Path(sys.argv[2]);frames=json.loads((root/'frames.json').read_text());section=sys.argv[3] if len(sys.argv)>3 else 'all'
frames=[f for f in frames if section=='all' or f.get('section','core')==section]
def render(f):
 p=root/f['id'];digest=hashlib.sha256(p.with_suffix('.html').read_bytes()).hexdigest();stamp=p.with_suffix('.sha256')
 if not (stamp.exists() and stamp.read_text()==digest and p.with_suffix('.png').exists() and p.with_suffix('.pdf').exists()):
  HTML(filename=str(p.with_suffix('.html'))).write_pdf(str(p.with_suffix('.pdf')));stamp.write_text(digest)
 d=fitz.open(p.with_suffix('.pdf'));f['render_pages']=len(d);d[0].get_pixmap(matrix=fitz.Matrix(2,2)).save(str(p.with_suffix('.png')));d.close();return f
with ThreadPoolExecutor(max_workers=4) as pool: frames=list(pool.map(render,frames))
# Large landscape pages give four readable, labeled phone frames per page.
W,H=1200,850; c=canvas.Canvas(str(output),pagesize=(W,H));c.setTitle('PackProof G1 Screen Atlas - static design review');c.setAuthor('PackProof')
def header(title,sub):
 c.setFillColor(HexColor('#192a3e'));c.setFont('Helvetica-Bold',22);c.drawString(32,H-38,title)
 c.setFillColor(HexColor('#53657b'));c.setFont('Helvetica',10);c.drawString(32,H-58,sub)
def footer(page):
 c.setFillColor(HexColor('#53657b'));c.setFont('Helvetica',9);c.drawString(32,22,'G1-2026-10-15-r1 | Simulated data | HTML/CSS document renders, not native or browser screenshots')
 c.drawRightString(W-32,22,str(page))
page=0
for i in range(0,len(frames),4):
 page+=1; group=frames[i:i+4]
 header('PackProof / G1 '+('state atlas' if section=='states' else 'screen atlas'),'Current source audited; this is a design candidate. Large-text views show the first viewport; remaining content requires scrolling.')
 for j,f in enumerate(group):
  x=32+j*292; c.setFillColor(HexColor('#192a3e'));c.setFont('Helvetica-Bold',12);c.drawString(x,H-86,f['screen'].capitalize())
  c.setFont('Helvetica',9);c.setFillColor(HexColor('#53657b'));c.drawString(x,H-101,f"{f['theme']} | {int(f['scale']*100)}% text | {f['width']}px | {f.get('viewState','standard')}")
  c.drawString(x,H-114,f['scenario'])
  c.drawImage(ImageReader(str((root/f['id']).with_suffix('.png'))),x,95,width=268,height=581,mask='auto')
 footer(page);c.showPage()
c.save();(root/('render-results-'+section+'.json')).write_text(json.dumps(frames,indent=2));print(json.dumps({'frames':len(frames),'atlas_pages':page,'output':str(output),'multipage_frames':[f['id'] for f in frames if f['render_pages']!=1]}))
