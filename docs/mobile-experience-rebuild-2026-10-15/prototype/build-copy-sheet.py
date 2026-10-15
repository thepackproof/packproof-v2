#!/usr/bin/env python3
"""Export the core copy dictionary as a one-page review PDF."""
import sys
from pathlib import Path
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from xml.sax.saxutils import escape
src=Path(__file__).with_name('COPY_AND_TOKENS.md').read_text()
section=src.split('## Completion copy dictionary',1)[1].split('\n## ',1)[0]
rows=[line.strip().strip('|').split('|') for line in section.splitlines() if line.startswith('|')]
rows=[r for r in rows if not all(set(c.strip())<={'-'} for c in r)]
style=ParagraphStyle('body',fontName='Helvetica',fontSize=10.3,leading=13.3,textColor=HexColor('#192a3e'))
heading=ParagraphStyle('heading',parent=style,fontName='Helvetica-Bold',fontSize=24,leading=30)
muted=ParagraphStyle('muted',parent=style,fontSize=10,leading=14,textColor=HexColor('#53657b'))
cells=[[Paragraph(escape(c.strip()),style) for c in r] for r in rows]
table=Table(cells,colWidths=[160,590,390],repeatRows=1)
table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),HexColor('#e8f1fc')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,0),(-1,-1),.5,HexColor('#dce4ee'))]))
doc=SimpleDocTemplate(sys.argv[1],pagesize=(1200,850),rightMargin=30,leftMargin=30,topMargin=28,bottomMargin=28,title='PackProof G1 Core Copy Sheet',author='PackProof')
doc.build([Paragraph('PackProof / G1 core copy dictionary',heading),Spacer(1,8),Paragraph('G1-2026-10-15-r1 · Exact proposed core copy. Additional state copy and semantic tokens are recorded in COPY_AND_TOKENS.md.',muted),Spacer(1,16),table,Spacer(1,12),Paragraph('The declaration is the existing version-1 SELLER_SHIPPING_STATEMENT. Other copy is a design proposal. Local save, transfer, server receipt and finalization remain distinct. All prototype operations are simulations; live policy takes precedence.',muted)])
print(sys.argv[1])
