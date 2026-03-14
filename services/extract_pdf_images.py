#!/usr/bin/env python3
"""
Extract embedded PDF images with PyMuPDF and emit JSON for Node.js import flows.
"""

import argparse
import base64
import hashlib
import json
import sys

import fitz


SUPPORTED_EXTENSIONS = {"png", "jpg", "svg"}


def normalize_ext(value):
    raw = str(value or "").strip().lower().lstrip(".")
    if raw in {"jpeg", "jpg", "jpe"}:
        return "jpg"
    if raw == "png":
        return "png"
    if raw == "svg":
        return "svg"
    return ""


def mime_type_for_ext(ext):
    if ext == "jpg":
        return "image/jpeg"
    if ext == "svg":
        return "image/svg+xml"
    return "image/png"


def rasterize_xref_to_png(document, xref):
    pixmap = fitz.Pixmap(document, xref)
    converted = None
    try:
        if pixmap.n - pixmap.alpha > 3:
            converted = fitz.Pixmap(fitz.csRGB, pixmap)
            pixmap = converted
        return pixmap.tobytes("png")
    finally:
        if converted is not None:
            converted = None
        pixmap = None


def main():
    parser = argparse.ArgumentParser(description="Extract PDF images")
    parser.add_argument("--input", required=True, help="Absolute path to the source PDF")
    args = parser.parse_args()

    try:
        document = fitz.open(args.input)
    except Exception as exc:
        print(json.dumps({"error": f"Failed to open PDF: {exc}"}))
        return 1

    images = []
    seen = set()

    try:
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            page_rect = page.rect
            image_entries = page.get_images(full=True)

            for placement_index, image_entry in enumerate(image_entries, start=1):
                xref = int(image_entry[0]) if image_entry and len(image_entry) > 0 else 0
                if xref <= 0:
                    continue

                try:
                    base_image = document.extract_image(xref)
                except Exception:
                    base_image = {}

                image_bytes = base_image.get("image", b"")
                ext = normalize_ext(base_image.get("ext"))

                if not image_bytes or ext not in SUPPORTED_EXTENSIONS:
                    try:
                        image_bytes = rasterize_xref_to_png(document, xref)
                        ext = "png"
                    except Exception:
                        continue

                if not image_bytes:
                    continue

                try:
                    rects = page.get_image_rects(xref)
                    rect = rects[0] if rects else None
                except Exception:
                    rect = None

                digest = hashlib.sha1(image_bytes).hexdigest()
                dedupe_key = (
                    page_index + 1,
                    digest,
                    round(rect.x0, 2) if rect else None,
                    round(rect.y0, 2) if rect else None,
                )
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)

                images.append(
                    {
                        "pageNumber": page_index + 1,
                        "placementIndex": placement_index,
                        "name": f"page_{page_index + 1}_image_{placement_index}.{ext}",
                        "extension": f".{ext}",
                        "mimeType": mime_type_for_ext(ext),
                        "bufferBase64": base64.b64encode(image_bytes).decode("ascii"),
                        "width": rect.width if rect else None,
                        "height": rect.height if rect else None,
                        "pageWidth": page_rect.width,
                        "pageHeight": page_rect.height,
                    }
                )

        print(json.dumps({"images": images}))
        return 0
    except Exception as exc:
        print(json.dumps({"error": f"Failed to extract PDF images: {exc}"}))
        return 1
    finally:
        document.close()


if __name__ == "__main__":
    sys.exit(main())
