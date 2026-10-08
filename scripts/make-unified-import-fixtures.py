from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import fitz

out = Path('output/unified-import/20261009/fixtures')
out.mkdir(parents=True, exist_ok=True)
paragraph = 'People learn through practice. A careful reader checks the source before drawing conclusions. Understanding a passage takes patience, because its details can support several different interpretations. Good readers preserve evidence and compare their explanations with the original sentences. They also notice how the structure connects ideas and ask clear questions when a claim is uncertain. This habit makes learning reliable and useful over time.'
blocks = ['Text 1', paragraph, '21. What helps readers learn?', '[A] Practice and evidence', '[B] Random guesses', '[C] Ignoring details', '[D] Changing the original', 'Answer key', '21. A']
pdf = canvas.Canvas(str(out/'reading.pdf'), pagesize=(595,842))
y = 795
for block in blocks:
    words = block.split(); line = ''
    for word in words:
        if len(line)+len(word)>80:
            pdf.drawString(42,y,line); y-=17; line=''
        line += (' ' if line else '')+word
    if line: pdf.drawString(42,y,line); y-=25
pdf.save()
with ZipFile(out/'reading.docx','w',ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+''.join('<w:p><w:r><w:t>'+escape(b)+'</w:t></w:r></w:p>' for b in blocks)+'</w:body></w:document>')
doc = fitz.open(out/'reading.pdf'); pix = doc[0].get_pixmap(matrix=fitz.Matrix(1.6,1.6)); pix.save(out/'reading.png')
scan = canvas.Canvas(str(out/'scanned.pdf'),pagesize=(595,842)); scan.drawImage(ImageReader(str(out/'reading.png')),0,0,width=595,height=842);scan.save()
mixed=fitz.open();mixed.insert_pdf(doc);mixed.insert_pdf(fitz.open(out/'scanned.pdf'));mixed.save(out/'mixed.pdf')
print(out)
