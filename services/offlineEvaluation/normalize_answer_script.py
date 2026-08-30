#!/usr/bin/env python3
"""Validate and normalize a scanned answer book without mutating the original.

Machine contract: stdout is one JSON object. Diagnostics go to stderr.
MuPDF/OpenCV C-level chatter is redirected off fd 1 so Node can JSON.parse
stdout without swallowing library warnings.

Dependencies:
  * PyMuPDF (`pymupdf` / `fitz`) — REQUIRED. Pure wheel, no system libs.
    Turns the uploaded PDF/image into page images and the normalized PDF.
  * OpenCV (`cv2`) + NumPy — OPTIONAL. Only used for cosmetic enhancement
    (deskew / autocrop / glare handling). When they are unavailable this
    script runs a fitz-only "raw" mode: pages are rasterized as-is and the
    AI vision model (Gemini) does the reading/evaluation downstream. The
    pipeline must NOT hard-fail just because OpenCV isn't installed.
"""

import argparse
import contextlib
import hashlib
import json
import math
import os
import shutil
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


with redirect_c_stdout_to_stderr():
    try:
        import pymupdf as fitz
    except ImportError:  # older wheels still expose only the fitz alias
        import fitz

    HAS_CV2 = True
    try:
        import cv2
        import numpy as np
    except Exception as _cv_err:  # noqa: BLE001 - any import failure = raw mode
        HAS_CV2 = False
        cv2 = None
        np = None
        sys.stderr.write(
            "[normalize] cv2/numpy unavailable (%s) - running raw fitz-only mode; "
            "image enhancement skipped, AI vision handles the rest.\n" % (_cv_err,)
        )


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


def _quality_status(min_edge):
    if min_edge < 600:
        return "UNREADABLE"
    if min_edge < 1100:
        return "ACCEPTABLE"
    return "GOOD"


# ---------------------------------------------------------------------------
# RAW (fitz-only) path — no OpenCV / NumPy. Rasterize pages as-is; the AI
# vision model tolerates skew / margins / colour fine.
# ---------------------------------------------------------------------------

def _pixmap_to_file(pixmap, path):
    try:
        with open(path, "wb") as handle:
            handle.write(pixmap.tobytes(output="jpg", jpg_quality=88))
        return path
    except Exception:
        # Very old PyMuPDF without native JPEG — fall back to PNG and rename.
        png_path = path.with_suffix(".png")
        with open(png_path, "wb") as handle:
            handle.write(pixmap.tobytes(output="png"))
        return png_path


def _render(page, scale, output, stem, clip=None):
    matrix = fitz.Matrix(scale, scale)
    pixmap = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB, alpha=False, clip=clip)
    return _pixmap_to_file(pixmap, output / f"{stem}.jpg"), pixmap.width, pixmap.height


def process_raw(source, mime_type, args, output):
    is_pdf = mime_type == "application/pdf" or source.suffix.lower() == ".pdf"
    normalized = fitz.open()
    metadata = []

    if is_pdf:
        document = fitz.open(source)
        if document.needs_pass:
            raise ValueError("Encrypted answer-sheet PDFs are not supported.")
        if document.page_count == 0:
            raise ValueError("The answer-sheet PDF has zero pages.")
        if document.page_count > args.max_pages:
            raise ValueError(
                f"The answer-sheet PDF has {document.page_count} pages; maximum is {args.max_pages}."
            )
        pages_iter = list(range(document.page_count))
    else:
        # A single uploaded image — wrap it in a one-page PDF so the same
        # fitz rendering path applies.
        document = fitz.open()
        rect = fitz.Rect(0, 0, 1654, 2339)  # ~A4 @ 200dpi
        page = document.new_page(width=rect.width, height=rect.height)
        page.insert_image(rect, filename=str(source), keep_proportion=True)
        pages_iter = [0]

    for order, index in enumerate(pages_iter, start=1):
        page = document.load_page(index)
        pw, ph = page.rect.width, page.rect.height
        nominal_scale = args.working_dpi / 72.0
        long_px = max(pw, ph) * nominal_scale
        work_scale = nominal_scale if long_px <= args.working_long_edge else args.working_long_edge / max(pw, ph)

        working_path, w, h = _render(page, work_scale, output, f"page-{order}-working")
        prev_scale = work_scale * min(1.0, args.preview_long_edge / max(w, h))
        thumb_scale = work_scale * min(1.0, args.thumbnail_long_edge / max(w, h))
        preview_path, _, _ = _render(page, prev_scale, output, f"page-{order}-preview")
        thumbnail_path, _, _ = _render(page, thumb_scale, output, f"page-{order}-thumbnail")
        identity_clip = fitz.Rect(0, 0, pw, max(1.0, ph * args.identity_fraction))
        identity_path, _, _ = _render(page, work_scale, output, f"page-{order}-identity", clip=identity_clip)

        np_page = normalized.new_page(width=w, height=h)
        np_page.insert_image(np_page.rect, filename=str(working_path), keep_proportion=False)

        metadata.append({
            "pageNumber": order,
            "working": str(working_path), "preview": str(preview_path),
            "thumbnail": str(thumbnail_path), "identity": str(identity_path),
            "widthPx": w, "heightPx": h,
            "workingDpi": args.working_dpi, "colorRelevant": True, "colorMode": "COLOR",
            "deskewDegrees": 0.0, "crop": {"x": 0, "y": 0, "width": 1, "height": 1},
            "isLikelyBlank": False,
            "qualityStatus": _quality_status(min(w, h)),
            "contentHash": sha256(working_path),
        })

    document.close()
    normalized_path = output / "normalized.pdf"
    normalized.save(normalized_path, garbage=4, deflate=True, clean=True)
    normalized.close()
    return {
        "normalizedPdf": str(normalized_path),
        "normalizedChecksum": sha256(normalized_path),
        "normalizedSizeBytes": normalized_path.stat().st_size,
        "pageCount": len(metadata),
        "pages": metadata,
        "enhancement": "RAW_FITZ_ONLY",
    }


# ---------------------------------------------------------------------------
# ENHANCED (OpenCV) path — unchanged behaviour when cv2 + numpy are present.
# ---------------------------------------------------------------------------

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


def process_enhanced(source, mime_type, args, output):
    input_pages = load_pages(source, mime_type, args.working_dpi, args.working_long_edge, args.max_pages)
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
        metadata.append({
            "pageNumber": index,
            "working": str(working_path), "preview": str(preview_path),
            "thumbnail": str(thumbnail_path), "identity": str(identity_path),
            "widthPx": width, "heightPx": height,
            "workingDpi": args.working_dpi, "colorRelevant": keep_color,
            "colorMode": "COLOR" if keep_color else "GRAYSCALE",
            "deskewDegrees": angle, "crop": crop, "isLikelyBlank": blank or ink_ratio < 0.002,
            "qualityStatus": _quality_status(min(width, height)), "contentHash": sha256(working_path),
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
        "enhancement": "OPENCV",
    }


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

    if HAS_CV2:
        return process_enhanced(source, args.mime_type, args, output)
    return process_raw(source, args.mime_type, args, output)


if __name__ == "__main__":
    try:
        with redirect_c_stdout_to_stderr():
            result = main()
        emit_json(result)
    except Exception as exc:
        emit_json({"error": str(exc), "errorType": exc.__class__.__name__})
        raise SystemExit(2)
