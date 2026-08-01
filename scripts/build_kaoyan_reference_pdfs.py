"""Build source-faithful reading excerpts and the two missing 2007 workbooks."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import fitz
from pypdf import PdfReader, PdfWriter


PROJECT = Path(__file__).resolve().parents[1]
PUBLIC_LIBRARY = PROJECT / "public" / "library" / "postgraduate"
OUTPUT = PROJECT / "output" / "pdf"
YEARS = range(2007, 2024)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def source_pdf(source_root: Path, year: int) -> Path:
    matches = [
        item for item in source_root.rglob(f"{year}年真题及答案速查.pdf")
        if "(1)" not in item.name
    ]
    if len(matches) != 1:
        raise RuntimeError(f"{year}: expected one annual PDF, found {len(matches)}")
    return matches[0]


def reference_path(year: int, text: int) -> Path:
    return PUBLIC_LIBRARY / str(year) / "reference" / f"{year}-text-{text}-original.pdf"


def build_reference(source: Path, destination: Path, text: int) -> None:
    page_start = 3 + (text - 1) * 2  # zero-based: original PDF pages 4, 6, 8, 10
    reader = PdfReader(str(source))
    if len(reader.pages) < page_start + 2:
        raise RuntimeError(f"{source}: Text {text} pages are missing")
    writer = PdfWriter()
    writer.add_page(reader.pages[page_start])
    writer.add_page(reader.pages[page_start + 1])
    writer.add_metadata({
        "/Title": f"{source.stem} Text {text}",
        "/Subject": "Original Reading Comprehension excerpt",
    })
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as target:
        writer.write(target)


def rendered_page_hash(path: Path, page_number: int) -> str:
    document = fitz.open(path)
    try:
        pixmap = document[page_number].get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False)
        return hashlib.sha256(pixmap.samples).hexdigest()
    finally:
        document.close()


def main() -> None:
    source_root = Path(
        sys.argv[1] if len(sys.argv) > 1 else r"D:\1考研资料\英语\真题"
    )
    if not source_root.is_dir():
        raise RuntimeError(f"Source directory does not exist: {source_root}")

    entries = []
    for year in YEARS:
        annual = source_pdf(source_root, year)
        annual_hash = digest(annual)
        for text in range(1, 5):
            destination = reference_path(year, text)
            build_reference(annual, destination, text)
            excerpt = PdfReader(str(destination))
            if len(excerpt.pages) != 2:
                raise RuntimeError(f"{destination}: expected two pages")
            first_source_page = 3 + (text - 1) * 2
            visual_hashes = []
            for offset in range(2):
                original_hash = rendered_page_hash(annual, first_source_page + offset)
                excerpt_hash = rendered_page_hash(destination, offset)
                if original_hash != excerpt_hash:
                    raise RuntimeError(f"{destination}: rendered page {offset + 1} changed")
                visual_hashes.append(original_hash)
            entries.append({
                "year": year,
                "text": text,
                "annualSource": str(annual),
                "annualSha256": annual_hash,
                "sourcePages": [4 + (text - 1) * 2, 5 + (text - 1) * 2],
                "referencePdf": str(destination.relative_to(PROJECT)).replace("\\", "/"),
                "referenceSha256": digest(destination),
                "referencePageCount": len(excerpt.pages),
                "renderedPageSha256": visual_hashes,
                "status": "verified-two-page-original-excerpt",
            })

    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "sourceRoot": str(source_root),
        "coverage": {"years": [min(YEARS), max(YEARS)], "texts": 4, "entries": len(entries)},
        "entries": entries,
    }
    (OUTPUT / "kaoyan-original-pdf-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Built and verified {len(entries)} original PDF excerpts.")


if __name__ == "__main__":
    main()
