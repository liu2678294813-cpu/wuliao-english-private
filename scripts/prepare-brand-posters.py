from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "brand"
OUT.mkdir(parents=True, exist_ok=True)
LANDSCAPE = Path(r"C:\Users\26782\.codex\generated_images\01a06c85-b5c9-7d70-a4a6-fb986c699f11\exec-4f5d3c9f-0075-49f9-a1ad-6dec4206e1d1.png")
PORTRAIT = Path(r"C:\Users\26782\.codex\generated_images\01a06c85-b5c9-7d70-a4a6-fb986c699f11\exec-4a1eaa5a-a2ec-424d-8809-7570704e72f5.png")

def cover(source: Path, size: tuple[int, int], stem: str):
    with Image.open(source).convert("RGB") as image:
        target_ratio = size[0] / size[1]
        source_ratio = image.width / image.height
        if source_ratio > target_ratio:
            width = round(image.height * target_ratio); left = (image.width - width) // 2
            image = image.crop((left, 0, left + width, image.height))
        elif source_ratio < target_ratio:
            height = round(image.width / target_ratio); top = (image.height - height) // 2
            image = image.crop((0, top, image.width, top + height))
        image = image.resize(size, Image.Resampling.LANCZOS)
        image.save(OUT / f"{stem}.png", optimize=True)
        image.save(OUT / f"{stem}.webp", "WEBP", quality=84, method=6)

cover(LANDSCAPE, (2560, 1440), "wuliao-english-poster-landscape-2560x1440")
cover(PORTRAIT, (1440, 2560), "wuliao-english-poster-portrait-1440x2560")
print(OUT)
