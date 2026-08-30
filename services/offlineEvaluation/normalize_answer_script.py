#!/usr/bin/env python3
"""Validate and normalize a scanned answer book without mutating the original.

Machine contract: stdout is one JSON object. Diagnostics go to stderr.
MuPDF/OpenCV C-level chatter is redirected off fd 1 so Node can JSON.parse
stdout without swallowing library warnings.
"""

import argparse
import contextlib
import hashlib
import json
import math
import os
import sys
import warnings
from pathlib import Path


def _warning_to_stderr(message, category, filename, lineno, file=None, line=None):
    sys.stderr.write(warnings.formatwarning(message, category, filename, lineno, line))


warnings.showwarning = _warning_to_stderr
warnings.simplefilter("default")


@contextlib.contextmanager
def redirect_c_stdout_to_stderr():
    """Send C-level writes (MuPDF `warning: ...`) to stderr, not stdout."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


# Import-time deprecation chatter from the legacy `fitz` alias is the exact
# "warning: T..." producer. Load the current pymupdf name under stderr so
# stdout stays machine JSON only.
with redirect_c_stdout_to_stderr():
    import cv2
    import numpy as np
    try:
        import pymupdf as fitz
    except ImportError:  # older wheels still expose only the fitz alias
        import fitz


def emit_json(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resize_down(image, long_edge):
    height, width = image.shape[:2]
    current = max(height, width)
    if current <= long_edge:
        return image
    scale = long_edge / float(current)
    return cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)


def deskew(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    inverted = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    points = np.column_stack(np.where(inverted > 0))
    if len(points) < 100:
        return image, 0.0
    angle = cv2.minAreaRect(points[:, ::-1].astype(np.float32))[-1]
    angle = -(90 + angle) if angle < -45 else -angle
    if not math.isfinite(angle) or abs(angle) < 0.15 or abs(angle) > 5:
        return image, 0.0
    height, width = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    return cv2.warpAffine(image, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE), round(angle, 3)


def crop_safe_margins(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    mask = gray < 245
    ys, xs = np.where(mask)
    height, width = gray.shape[:2]
    if len(xs) < max(100, int(width * height * 0.0005)):
        return image, {"x": 0, "y": 0, "width": 1, "height": 1}, True
    padding = max(24, round(min(width, height) * 0.018))
    x0, x1 = max(0, int(xs.min()) - padding), min(width, int(xs.max()) + padding + 1)
    y0, y1 = max(0, int(ys.min()) - padding), min(height, int(ys.max()) + padding + 1)
    # Avoid aggressive crops: answer-sheet headers and faint edge notes are evidence.
    if (x1 - x0) < width * 0.55 or (y1 - y0) < height * 0.55:
        return image, {"x": 0, "y": 0, "width": 1, "height": 1}, False
    return image[y0:y1, x0:x1], {
        "x": round(x0 / width, 6), "y": round(y0 / height, 6),
        "width": round((x1 - x0) / width, 6), "height": round((y1 - y0) / height, 6),
    }, False


def color_relevant(image):
    if image.ndim != 3:
        return False
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    colored = np.logical_and(saturation > 48, value > 45)
    return float(np.mean(colored)) >= 0.008


def save_jpeg(path, image, quality):
    params = [int(cv2.IMWRITE_JPEG_QUALITY), quality, int(cv2.IMWRITE_JPEG_OPTIMIZE), 1]
    if not cv2.imwrite(str(path), image, params):
        raise RuntimeError(f"Unable to write {path.name}")


def raster_pdf(source, working_dpi, long_edge, max_pages):
    document = fitz.open(source)
    if document.needs_pass:
        raise ValueError("Encrypted answer-sheet PDFs are not supported.")
    if document.page_count == 0:
        raise ValueError("The answer-sheet PDF has zero pages.")
    if document.page_count > max_pages:
        raise ValueError(f"The answer-sheet PDF has {document.page_count} pages; maximum is {max_pages}.")
    pages = []
    for index in range(document.page_count):
        page = document.load_page(index)
        nominal_scale = working_dpi / 72.0
        expected_long_edge = max(page.rect.width, page.rect.height) * nominal_scale
        scale = nominal_scale if expected_long_edge <= long_edge else long_edge / max(page.rect.width, page.rect.height)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
        array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3)
        pages.append(cv2.cvtColor(array, cv2.COLOR_RGB2BGR))
    document.close()
    return pages


def load_pages(source, mime_type, working_dpi, long_edge, max_pages):
    if mime_type == "application/pdf" or source.suffix.lower() == ".pdf":
        return raster_pdf(source, working_dpi, long_edge, max_pages)
    data = np.fromfile(source, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("The uploaded answer-sheet image is malformed or unsupported.")
    return [resize_down(image, long_edge)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mime-type", default="application/pdf")
    parser.add_argument("--working-dpi", type=int, default=220)
    parser.add_argument("--working-long-edge", type=int, default=2600)
    parser.add_argument("--preview-long-edge", type=int, default=1600)
    parser.add_argument("--thumbnail-long-edge", type=int, default=320)
    parser.add_argument("--identity-fraction", type=float, default=0.32)
    parser.add_argument("--max-pages", type=int, default=60)
    args = parser.parse_args()

    source = Path(args.input)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    if not source.exists() or source.stat().st_size == 0:
        raise ValueError("The uploaded answer sheet is empty.")

    input_pages = load_pages(source, args.mime_type, args.working_dpi, args.working_long_edge, args.max_pages)
    normalized = fitz.open()
    metadata = []
    for index, input_image in enumerate(input_pages, start=1):
        corrected, angle = deskew(input_image)
        cropped, crop, blank = crop_safe_margins(corrected)
        keep_color = color_relevant(cropped)
        working = resize_down(cropped, args.working_long_edge)
        if not keep_color:
            working = cv2.cvtColor(working, cv2.COLOR_BGR2GRAY)
        preview = resize_down(working, args.preview_long_edge)
        thumbnail = resize_down(working, args.thumbnail_long_edge)
        header_height = max(1, round(working.shape[0] * args.identity_fraction))
        identity = working[:header_height, :]

        working_path = output / f"page-{index}-working.jpg"
        preview_path = output / f"page-{index}-preview.jpg"
        thumbnail_path = output / f"page-{index}-thumbnail.jpg"
        identity_path = output / f"page-{index}-identity.jpg"
        save_jpeg(working_path, working, 88)
        save_jpeg(preview_path, preview, 84)
        save_jpeg(thumbnail_path, thumbnail, 78)
        save_jpeg(identity_path, identity, 86)

        height, width = working.shape[:2]
        page = normalized.new_page(width=width, height=height)
        page.insert_image(page.rect, filename=str(working_path), keep_proportion=False)
        ink_ratio = float(np.mean((working if working.ndim == 2 else cv2.cvtColor(working, cv2.COLOR_BGR2GRAY)) < 245))
        quality = "UNREADABLE" if min(width, height) < 600 else ("ACCEPTABLE" if min(width, height) < 1100 else "GOOD")
        metadata.append({
            "pageNumber": index,
            "working": str(working_path), "preview": str(preview_path),
            "thumbnail": str(thumbnail_path), "identity": str(identity_path),
            "widthPx": width, "heightPx": height,
            "workingDpi": args.working_dpi, "colorRelevant": keep_color,
            "colorMode": "COLOR" if keep_color else "GRAYSCALE",
            "deskewDegrees": angle, "crop": crop, "isLikelyBlank": blank or ink_ratio < 0.002,
            "qualityStatus": quality, "contentHash": sha256(working_path),
        })

    normalized_path = output / "normalized.pdf"
    normalized.save(normalized_path, garbage=4, deflate=True, clean=True)
    normalized.close()
    return {
        "normalizedPdf": str(normalized_path),
        "normalizedChecksum": sha256(normalized_path),
        "normalizedSizeBytes": normalized_path.stat().st_size,
        "pageCount": len(metadata),
        "pages": metadata,
    }


if __name__ == "__main__":
    try:
        with redirect_c_stdout_to_stderr():
            result = main()
        emit_json(result)
    except Exception as exc:
        emit_json({"error": str(exc), "errorType": exc.__class__.__name__})
        raise SystemExit(2)
