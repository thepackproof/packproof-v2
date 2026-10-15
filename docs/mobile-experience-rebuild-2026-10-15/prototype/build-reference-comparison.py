#!/usr/bin/env python3
"""Compose the private S01-S09 PDF from supplied DOCX references and static frames.

Usage: python build-reference-comparison.py REFERENCE_IMAGES DESIGN_FRAMES OUTPUT.pdf
The reference images are deliberately excluded from the public repository. Redaction
is applied to temporary PDF pages, then rasterized; only the sanitized result enters
the comparison PDF. This is a document review, not an installed-build comparison.
"""
import io, json, sys
from pathlib import Path
import fitz
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle

refs, frames_root, output = map(Path, sys.argv[1:4])
frames = json.loads((frames_root / 'frames.json').read_text())
rows = [
 ('S01',5,'evidence','light','Evidence',
  [(20,300,420,385),(20,610,320,648)],
  'The optional receipt explanation competes with the evidence and required next step.',
  'Put the human title, actual state and next permitted action first. Keep originals visible; disclose technical receipts under Advanced.',
  'The source contains the inline receipt panel. Runtime flags and the installed binary still need matching. The synthetic state differs from this reference.'),
 ('S02',6,'integrations','light','Integrations',[],
  'A tall provider card and repeated connection disclaimers dominate the page.',
  'Explain optional connections once. Use compact provider rows with a truthful status and focused details.',
  'Provider availability must come from the real catalog. The prototype connection controls are simulations, not OAuth implementations.'),
 ('S03',7,'profile','light','Profile / light',[(20,1220,630,1260)],
  'The profile sheet occupies most of the supplied viewport.',
  'Keep six clear destinations, small account metadata and predictable dismissal in a bounded sheet.',
  'The current maxHeight is a ceiling, not a forced height. Native focus, safe areas and Android Back remain unverified.'),
 ('S04',8,'profile','dark','Profile / dark',[(45,255,410,295),(20,1220,630,1260)],
  'The dark profile sheet uses the same tall composition.',
  'Use the same compact destination order and spacing in both themes. Keep content scrollable at large type.',
  'This is a static comparison. The clickable candidate supplies Escape, modal focus wrapping and focus restoration; TalkBack remains a device check.'),
 ('S05',9,'capture','dark','Capture',[],
  'Scan, existing Proof, Create, queue filters and empty search compete for attention.',
  'Make Pack an item primary. Keep Continue and Scan separate and secondary. Show queue controls only when orders exist.',
  'The unconditional empty-queue search and filters are verified in the current source. Advanced capture entries remain discoverable.'),
 ('S06',10,'shipment','dark','Shipment',[],
  'The supplied screenshot shows an expanded tracking form occupying most of the view.',
  'Start with the optional tracking summary. Open one focused form after Add tracking; show manual provenance and unavailable carrier status honestly.',
  'Current source already initializes the form closed. This reference is an expanded state, not proof of a default-state defect. Tracking cannot finalize evidence.'),
 ('S07',11,'history','dark','History',[(20,300,420,385)],
  'Two events sit beneath a substantial header and a second history navigation row.',
  'Group ordinary events compactly. Keep each event detail available on demand and preserve chronological meaning.',
  'A short history legitimately leaves blank space. Do not add filler activity or infer missing evidence from this screenshot.'),
 ('S08',12,'home','dark','Home',[(45,255,650,298),(20,865,290,901),(20,1007,650,1042),(20,1148,650,1183)],
  'The hero and list show email-like titles, counters and repeated-looking work items.',
  'Use a human-readable item title, one permitted task, a distinct start-new route and a small deduplicated attention list.',
  'The current source already deduplicates the hero. The origin of the email-like itemTitle is unresolved; preserve a deliberately chosen title and do not invent provenance.'),
 ('S09',13,'settings','dark','Settings',[(48,282,390,365)],
  'Tall account and settings groups consume the first viewport.',
  'Use compact grouped rows. Keep appearance and notifications together, with privacy, billing and Advanced still discoverable.',
  'All authorization and deletion protections remain in existing domain flows. The design does not change billing or backend behavior.'),
]

def redacted_reference(number, rects):
    # The intermediate PDF owns the source image. Applying redactions removes
    # the covered pixels before any image is added to the delivered document.
    raw = io.BytesIO(); p = canvas.Canvas(raw, pagesize=(709,1536))
    p.drawImage(str(refs / f'image{number}.png'),0,0,width=709,height=1536);p.save()
    d = fitz.open(stream=raw.getvalue(),filetype='pdf');page=d[0]
    for r in rects: page.add_redact_annot(fitz.Rect(*r),fill=(0.34,0.39,0.46))
    if rects: page.apply_redactions(images=2,graphics=0,text=0)
    data=d.tobytes(garbage=4,deflate=True,clean=True);d.close()
    clean=fitz.open(stream=data,filetype='pdf');pix=clean[0].get_pixmap(matrix=fitz.Matrix(1,1));png=pix.tobytes('png');clean.close()
    return ImageReader(io.BytesIO(png))

style=ParagraphStyle('body',fontName='Helvetica',fontSize=12,leading=18,textColor=HexColor('#435873'))
c=canvas.Canvas(str(output),pagesize=(1200,850));c.setTitle('PackProof S01-S09 annotated design comparison');c.setAuthor('PackProof')
for i,(ref,num,screen,theme,title,rects,before,after,qualification) in enumerate(rows,1):
    c.setFillColor(HexColor('#192a3e'));c.setFont('Helvetica-Bold',24);c.drawString(32,808,f'{ref} / {title}')
    c.setFillColor(HexColor('#53657b'));c.setFont('Helvetica',10);c.drawString(32,785,'Reference observations and proposed composition; these are not matched installed-build before/after measurements.')
    c.setFont('Helvetica-Bold',11);c.drawString(32,755,'BEFORE / supplied plan reference');c.drawString(334,755,'AFTER / G1 design candidate')
    c.drawImage(redacted_reference(num,rects),32,130,width=268,height=581)
    f=next(f for f in frames if f['screen']==screen and f['theme']==theme and f['scale']==1 and f['scenario']=='resume')
    c.drawImage(str((frames_root/f['id']).with_suffix('.png')),334,130,width=268,height=581)
    y=728
    for label,body in [('Observed',before),('Design change',after),('Evidence boundary',qualification)]:
        c.setFont('Helvetica-Bold',13);c.setFillColor(HexColor('#192a3e'));c.drawString(650,y,label);y-=12
        para=Paragraph(body,style);_,h=para.wrap(510,600);para.drawOn(c,650,y-h);y-=h+35
    c.setFont('Helvetica',9);c.setFillColor(HexColor('#53657b'))
    c.drawString(32,100,'Identifiers in the supplied references have been redacted. Source reference is not proof of current installed-build equivalence.')
    c.drawString(32,82,'After images: simulated data; static HTML/CSS document renders at 360 px / 100% text. Native geometry remains unverified.')
    c.drawString(32,24,'G1-2026-10-15-r1 | Approval pending | Physical baseline and Android validation remain open')
    c.drawRightString(1168,24,f'{i} / 9');c.showPage()
c.save();print(json.dumps({'pages':9,'output':str(output)}))
