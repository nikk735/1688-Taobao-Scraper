#!/usr/bin/env python3
"""
Parse a saved Sugargoo shop HTML file and export listing data plus embedded images.

Usage:
    python sugargoo_snapshot_extract_with_images.py input.html
    python sugargoo_snapshot_extract_with_images.py input.html -o output.csv --images-dir images --zip-images
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import mimetypes
import re
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from bs4 import BeautifulSoup

PRODUCT_SELECTOR = 'a.goods-item[href*="/products?productLink="]'


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def sanitize_file_part(text: str | None, fallback: str = "item") -> str:
    out = clean(text).replace("/", "_").replace("\\", "_")
    out = re.sub(r'[\\/:*?"<>|]+', '_', out)
    out = re.sub(r"\s+", "_", out)
    out = re.sub(r"_+", "_", out).strip("_")
    return (out[:80] or fallback)


def decode_repeatedly(value: str) -> str:
    prev = None
    cur = value or ""
    while cur and cur != prev and "%" in cur:
        prev = cur
        try:
            cur = unquote(cur)
        except Exception:
            break
    return cur


def decode_1688_url(href: str) -> str:
    parsed = urlparse(href)
    product_link = parse_qs(parsed.query).get("productLink", [""])[0]
    return decode_repeatedly(product_link)


def extract_offer_id(*candidates: str) -> str:
    joined = " ".join(candidates)
    match = re.search(r"offer/(\d+)\.html", joined, re.IGNORECASE) or re.search(
        r"offerId=(\d+)", joined, re.IGNORECASE
    )
    return match.group(1) if match else ""


def extension_from_data_url(data_url: str) -> str:
    m = re.match(r"^data:([^;,]+)[;,]", data_url, re.IGNORECASE)
    mime = (m.group(1).lower() if m else "application/octet-stream")
    if "jpeg" in mime or "jpg" in mime:
        return "jpg"
    if "png" in mime:
        return "png"
    if "webp" in mime:
        return "webp"
    if "gif" in mime:
        return "gif"
    if "bmp" in mime:
        return "bmp"
    if "svg" in mime:
        return "svg"
    guessed = mimetypes.guess_extension(mime) or ".bin"
    return guessed.lstrip(".")


def decode_data_url(data_url: str) -> bytes:
    header, body = data_url.split(",", 1)
    if ";base64" in header.lower():
        return base64.b64decode(body)
    return unquote(body).encode("utf-8")


def parse_html(path: Path) -> list[dict[str, str]]:
    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="ignore"), "html.parser")
    rows: dict[str, dict[str, str]] = {}

    for card in soup.select(PRODUCT_SELECTOR):
        href = card.get("href", "")
        decoded_1688 = decode_1688_url(href)
        title_el = card.select_one(".title")
        price_el = card.select_one(".price")
        sales_el = card.select_one(".num")
        img_el = card.select_one("img")

        title = clean(title_el.get_text(" ", strip=True) if title_el else card.get_text(" ", strip=True))
        price = clean(price_el.get_text(" ", strip=True) if price_el else "")
        sales = clean(sales_el.get_text(" ", strip=True) if sales_el else "")
        image_url = img_el.get("src", "") if img_el else ""
        offer_id = extract_offer_id(href, decoded_1688)
        image_ext = extension_from_data_url(image_url) if image_url.startswith("data:") else "jpg"
        image_file = f"{sanitize_file_part(offer_id or title)}.{image_ext}"

        row = {
            "offer_id": offer_id,
            "title": title,
            "price": price,
            "sales": sales,
            "sugargoo_url": href,
            "source_1688_url": decoded_1688,
            "image_url": image_url,
            "image_file": image_file,
        }
        key = offer_id or decoded_1688 or href or title
        if key:
            rows[key] = row

    return sorted(rows.values(), key=lambda r: (r["offer_id"] or r["title"]))


def write_csv(rows: list[dict[str, str]], output_path: Path) -> None:
    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "offer_id",
                "title",
                "price",
                "sales",
                "sugargoo_url",
                "source_1688_url",
                "image_url",
                "image_file",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)


def write_images(rows: list[dict[str, str]], images_dir: Path) -> tuple[int, int]:
    images_dir.mkdir(parents=True, exist_ok=True)
    saved = 0
    skipped = 0

    for row in rows:
        image_url = row.get("image_url", "")
        if not image_url.startswith("data:"):
            skipped += 1
            continue
        try:
            data = decode_data_url(image_url)
            (images_dir / row["image_file"]).write_bytes(data)
            saved += 1
        except Exception:
            skipped += 1

    return saved, skipped


def zip_folder(folder: Path, zip_path: Path, extra_files: list[Path] | None = None) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                zf.write(path, arcname=path.relative_to(folder.parent))
        for extra in extra_files or []:
            if extra.exists() and extra.is_file():
                zf.write(extra, arcname=extra.name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_html", help="Path to the saved Sugargoo HTML file")
    parser.add_argument("-o", "--output", help="Output CSV path")
    parser.add_argument("--images-dir", help="Folder to write decoded images into")
    parser.add_argument("--zip-images", action="store_true", help="Create a ZIP containing the images folder and CSV")
    args = parser.parse_args()

    input_path = Path(args.input_html)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    output_path = Path(args.output) if args.output else input_path.with_suffix(".csv")
    rows = parse_html(input_path)
    write_csv(rows, output_path)

    images_dir = Path(args.images_dir) if args.images_dir else input_path.with_name(f"{input_path.stem}_images")
    saved, skipped = write_images(rows, images_dir)

    manifest = {
        "rows": len(rows),
        "images_saved": saved,
        "images_skipped": skipped,
        "images_dir": str(images_dir),
        "csv": str(output_path),
    }
    manifest_path = images_dir.parent / f"{input_path.stem}_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if args.zip_images:
        zip_path = images_dir.parent / f"{input_path.stem}_images.zip"
        zip_folder(images_dir, zip_path, extra_files=[output_path, manifest_path])
        print(f"Wrote {len(rows)} rows to {output_path}")
        print(f"Saved {saved} images to {images_dir}")
        print(f"Created ZIP: {zip_path}")
    else:
        print(f"Wrote {len(rows)} rows to {output_path}")
        print(f"Saved {saved} images to {images_dir} (skipped {skipped})")


if __name__ == "__main__":
    main()
