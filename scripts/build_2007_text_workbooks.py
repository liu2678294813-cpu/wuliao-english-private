"""Create text-layer parser inputs for 2007 Text 1 and Text 2.

The unmodified visual source excerpts remain in reference/.  These PDFs let the
structured reader avoid offline OCR on older Android WebView releases.
"""

from pathlib import Path
import re

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


SOURCE = Path("tmp/pdfs/source-inspection/2007-texts.txt")
DESTINATION = Path("public/library/postgraduate/2007")
PAGE_W, PAGE_H = A4
MARGIN = 54
FONT_SIZE = 10.2
LEADING = 14


def clean(line):
    line = line.replace("|", " ").replace("~", " ")
    line = re.sub(r"\s+", " ", line).strip()
    return line


def wrap(text, width=92):
    words = text.split()
    lines, current = [], []
    for word in words:
        if len(" ".join(current + [word])) > width and current:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def source_sections():
    raw = SOURCE.read_text(encoding="utf-8")
    pages = {
        int(number): text
        for number, text in re.findall(r"--- PAGE (\d+) ---\s*(.*?)(?=--- PAGE|\Z)", raw, re.S)
    }
    return pages


def normalize_article(raw, text_number):
    lines = [clean(line) for line in raw.splitlines()]
    start = next(index for index, line in enumerate(lines) if re.fullmatch(r"Text\s+%d" % text_number, line, re.I))
    kept = []
    for line in lines[start + 1:]:
        if line.startswith(("RE (", "FE (", "EiF(")) or re.search(r"(?:[A-Z]{2}\s*\([^)]*\)|[A-Z][A-Z].*\d+\.)$", line):
            continue
        if line:
            kept.append(line)
        elif kept and kept[-1]:
            kept.append("")
    text = "\n".join(kept).strip()
    text = re.sub(r"technique as on [^\n]*", "technique as on outcome.", text)
    text = text.replace("‘The defining", "The defining")
    text = text.replace('Testing?” ,', 'Testing?",')
    return text


def normalize_questions(raw):
    raw = raw.replace("|", " ").replace("~", " ")
    raw = re.sub(r"\[\s*([A-D])\s*\]", r"[\1]", raw)
    raw = re.sub(r"(?m)^\s*(\d{2})\.\s*", r"\1. ", raw)
    raw = re.sub(r"(?m)^\s*\[([A-D])\]\s*", r"[\1] ", raw)
    lines = []
    for line in raw.splitlines():
        line = clean(line)
        if not line or line.startswith(("RE (", "FE (", "EiF(")) or re.search(r"(?:[A-Z]{2}\s*\([^)]*\)|[A-Z][A-Z].*\d+\.)$", line):
            continue
        lines.append(line)
    return "\n".join(lines)


def draw_lines(pdf, lines, y):
    pdf.setFont("Times-Roman", FONT_SIZE)
    for line in lines:
        if y < MARGIN:
            pdf.showPage()
            pdf.setFont("Times-Roman", FONT_SIZE)
            y = PAGE_H - MARGIN
        pdf.drawString(MARGIN, y, line)
        y -= LEADING
    return y


def create(text_number, article, questions):
    destination = DESTINATION / f"2007-text-{text_number}.pdf"
    pdf = canvas.Canvas(str(destination), pagesize=A4)
    y = PAGE_H - MARGIN
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawString(MARGIN, y, f"Text {text_number}")
    y -= 28
    for paragraph in re.split(r"\n\s*\n", article):
        y = draw_lines(pdf, wrap(paragraph), y)
        y -= LEADING * 1.5
    pdf.showPage()
    y = PAGE_H - MARGIN
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(MARGIN, y, "Questions")
    y -= 24
    for line in questions.splitlines():
        if re.match(r"^\d{2}\.", line):
            y -= 7
        y = draw_lines(pdf, wrap(line), y)
    pdf.save()


def main():
    pages = source_sections()
    create(1, normalize_article(pages[4], 1), normalize_questions(pages[5]))
    create(2, normalize_article(pages[6], 2), normalize_questions(pages[7]))
    print("Built 2007 Text 1 and Text 2 text-layer workbooks.")


if __name__ == "__main__":
    main()
