#!/usr/bin/env python3
"""
Scanned PDF processor for question imports.

Pipeline:
1) Render PDF pages at target DPI
2) Preprocess pages (grayscale, contrast, adaptive threshold, denoise, deskew)
3) Detect question blocks by text-density layout segmentation
4) Detect/crop likely diagram regions inside blocks

Output JSON is printed to stdout for Node.js service consumption.
"""

import argparse
import json
import os
import sys

import cv2
import fitz
import numpy as np


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def to_bgr(pixmap):
    arr = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    if pixmap.n == 4:
        return cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def deskew_images(color_img, binary_img):
    inv = 255 - binary_img
    coords = np.column_stack(np.where(inv > 0))
    if coords.size == 0:
        return color_img, binary_img, 0.0

    rect = cv2.minAreaRect(coords.astype(np.float32))
    raw_angle = float(rect[-1])
    angle = raw_angle
    if angle < -45:
        angle = 90 + angle
    if angle > 45:
        angle = angle - 90

    # Ignore pathological angle detections; scanned pages are usually near upright.
    if abs(angle) < 0.2 or abs(angle) > 15:
        return color_img, binary_img, 0.0

    h, w = binary_img.shape[:2]
    center = (w // 2, h // 2)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated_color = cv2.warpAffine(
        color_img, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    rotated_binary = cv2.warpAffine(
        binary_img, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    return rotated_color, rotated_binary, float(angle)


def preprocess_page(color_img):
    gray = cv2.cvtColor(color_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    # Contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    contrast = clahe.apply(gray)

    # Noise reduction + adaptive threshold
    denoised = cv2.medianBlur(contrast, 3)
    binary = cv2.adaptiveThreshold(
        denoised,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        35,
        11,
    )

    rotated_color, rotated_binary, angle = deskew_images(color_img, binary)
    return rotated_color, rotated_binary, angle


def spans_from_mask(mask, min_len=8):
    spans = []
    start = None
    for idx, val in enumerate(mask): 
        if val and start is None:
            start = idx
        if not val and start is not None:
            if idx - start >= min_len:
                spans.append((start, idx - 1))
            start = None
    if start is not None and len(mask) - start >= min_len:
        spans.append((start, len(mask) - 1))
    return spans


def merge_spans(spans, max_gap):
    if not spans:
        return []
    merged = [list(spans[0])]
    for s, e in spans[1:]:
        if s - merged[-1][1] <= max_gap:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def detect_question_blocks(binary_img):
    inv = 255 - binary_img
    h, w = inv.shape[:2]

    row_ink = np.sum(inv > 0, axis=1)
    row_threshold = max(4, int(w * 0.003))
    text_rows = row_ink > row_threshold

    line_spans = spans_from_mask(text_rows, min_len=8)
    if not line_spans:
        return [(0, 0, w, h)]

    # Merge close lines so one question + options stay in same block
    blocks_y = merge_spans(line_spans, max_gap=90)

    blocks = []
    for y1, y2 in blocks_y:
        y1 = max(0, y1 - 10)
        y2 = min(h - 1, y2 + 12)
        if y2 - y1 < 60:
            continue

        region = inv[y1 : y2 + 1, :]
        col_ink = np.sum(region > 0, axis=0)
        col_threshold = max(5, int((y2 - y1 + 1) * 0.02))
        cols = np.where(col_ink > col_threshold)[0]
        if cols.size > 0:
            x1 = max(0, int(cols[0]) - 12)
            x2 = min(w - 1, int(cols[-1]) + 12)
        else:
            x1, x2 = 0, w - 1

        if (x2 - x1) < 220:
            continue

        blocks.append((x1, y1, x2 + 1, y2 + 1))

    if not blocks:
        blocks = [(0, 0, w, h)]

    # Merge near-overlapping blocks
    blocks.sort(key=lambda b: (b[1], b[0]))
    merged = [list(blocks[0])]
    for x1, y1, x2, y2 in blocks[1:]:
        px1, py1, px2, py2 = merged[-1]
        if y1 - py2 <= 28:
            merged[-1] = [min(px1, x1), min(py1, y1), max(px2, x2), max(py2, y2)]
        else:
            merged.append([x1, y1, x2, y2])

    merged_blocks = [tuple(b) for b in merged]

    # Secondary contour-based fallback if segmentation looks too narrow.
    max_height = max((b[3] - b[1]) for b in merged_blocks) if merged_blocks else 0
    if len(merged_blocks) == 1 and max_height < int(h * 0.22):
        inv = 255 - binary_img
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (45, 11))
        closed = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour_boxes = []
        for c in contours:
            x, y, bw, bh = cv2.boundingRect(c)
            area = bw * bh
            if area < 9000:
                continue
            if bw < 260 or bh < 70:
                continue
            contour_boxes.append((x, y, x + bw, y + bh))

        contour_boxes.sort(key=lambda b: (b[1], b[0]))
        if contour_boxes:
            merged2 = [list(contour_boxes[0])]
            for x1, y1, x2, y2 in contour_boxes[1:]:
                px1, py1, px2, py2 = merged2[-1]
                if y1 - py2 <= 30:
                    merged2[-1] = [min(px1, x1), min(py1, y1), max(px2, x2), max(py2, y2)]
                else:
                    merged2.append([x1, y1, x2, y2])
            merged_blocks = [tuple(b) for b in merged2]

    return merged_blocks


def detect_diagram_bbox(block_binary):
    inv = 255 - block_binary
    bh, bw = inv.shape[:2]
    block_area = float(max(1, bw * bh))

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    candidates = []
    for idx in range(1, num_labels):
        x = int(stats[idx, cv2.CC_STAT_LEFT])
        y = int(stats[idx, cv2.CC_STAT_TOP])
        w = int(stats[idx, cv2.CC_STAT_WIDTH])
        h = int(stats[idx, cv2.CC_STAT_HEIGHT])
        area = float(stats[idx, cv2.CC_STAT_AREA])

        if area < 0.015 * block_area:
            continue
        if w < 0.18 * bw or h < 0.12 * bh:
            continue
        if h < 25:
            continue

        candidates.append((area, x, y, w, h))

    if not candidates:
        return None

    _, x, y, w, h = max(candidates, key=lambda item: item[0])
    pad = 8
    x1 = max(0, x - pad)
    y1 = max(0, y - pad)
    x2 = min(bw, x + w + pad)
    y2 = min(bh, y + h + pad)
    if (x2 - x1) < 40 or (y2 - y1) < 40:
        return None
    return x1, y1, x2, y2


def detect_text_and_options_regions(binary_without_diagram):
    inv = 255 - binary_without_diagram
    bh, bw = inv.shape[:2]
    row_ink = np.sum(inv > 0, axis=1)
    row_threshold = max(3, int(bw * 0.0025))
    text_rows = row_ink > row_threshold
    spans = spans_from_mask(text_rows, min_len=4)

    if not spans:
        return {
            "questionTextRegion": [0, 0, int(bw), int(bh)],
            "optionsRegion": None,
        }

    text_top = max(0, spans[0][0] - 2)
    text_bottom = min(bh, spans[-1][1] + 2)

    options_start = None
    for idx, (start, _end) in enumerate(spans):
        if start >= int(bh * 0.45) and (len(spans) - idx) >= 3:
            options_start = start
            break

    if options_start is None and len(spans) >= 3:
        options_start = spans[-3][0]

    if options_start is None:
        return {
            "questionTextRegion": [0, int(text_top), int(bw), int(text_bottom)],
            "optionsRegion": None,
        }

    q_bottom = max(text_top + 5, options_start - 2)
    question_region = [0, int(text_top), int(bw), int(min(bh, q_bottom))]
    options_region = [0, int(max(0, options_start - 2)), int(bw), int(text_bottom)]
    return {
        "questionTextRegion": question_region,
        "optionsRegion": options_region,
    }


def process_page_image(color, page_number, output_dir):
    processed_color, processed_binary, angle = preprocess_page(color)
    raw_page_path = os.path.abspath(os.path.join(output_dir, f"page_{page_number}.png"))
    pre_page_path = os.path.abspath(os.path.join(output_dir, f"page_{page_number}_pre.png"))
    cv2.imwrite(raw_page_path, color)
    cv2.imwrite(pre_page_path, processed_binary)

    blocks = detect_question_blocks(processed_binary)
    page_blocks = []
    for block_idx, (x1, y1, x2, y2) in enumerate(blocks, start=1):
        block_color = processed_color[y1:y2, x1:x2]
        block_binary = processed_binary[y1:y2, x1:x2]
        if block_color.size == 0 or block_binary.size == 0:
            continue

        block_path = os.path.abspath(
            os.path.join(output_dir, f"page_{page_number}_block_{block_idx}.png")
        )
        block_pre_path = os.path.abspath(
            os.path.join(output_dir, f"page_{page_number}_block_{block_idx}_pre.png")
        )
        cv2.imwrite(block_path, block_color)
        cv2.imwrite(block_pre_path, block_binary)

        diagram_path = ""
        diagram_bbox = detect_diagram_bbox(block_binary)

        ocr_color = block_color.copy()
        ocr_binary = block_binary.copy()
        if diagram_bbox is not None:
            dx1, dy1, dx2, dy2 = diagram_bbox
            diagram_crop = block_color[dy1:dy2, dx1:dx2]
            if diagram_crop.size > 0:
                diagram_path = os.path.abspath(
                    os.path.join(output_dir, f"page_{page_number}_block_{block_idx}_diagram.png")
                )
                cv2.imwrite(diagram_path, diagram_crop)
                # Mask-out diagram region so OCR does not read circuit labels as options/text.
                ocr_color[dy1:dy2, dx1:dx2] = 255
                ocr_binary[dy1:dy2, dx1:dx2] = 255
            else:
                diagram_bbox = None

        ocr_path = os.path.abspath(
            os.path.join(output_dir, f"page_{page_number}_block_{block_idx}_ocr.png")
        )
        ocr_pre_path = os.path.abspath(
            os.path.join(output_dir, f"page_{page_number}_block_{block_idx}_ocr_pre.png")
        )
        cv2.imwrite(ocr_path, ocr_color)
        cv2.imwrite(ocr_pre_path, ocr_binary)

        text_regions = detect_text_and_options_regions(ocr_binary)
        page_blocks.append(
            {
                "blockIndex": block_idx,
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "blockImage": block_path,
                "preprocessedBlockImage": block_pre_path,
                "ocrBlockImage": ocr_path,
                "ocrBlockPreprocessedImage": ocr_pre_path,
                "diagramImage": diagram_path,
                "layoutRegions": {
                    "questionTextRegion": text_regions.get("questionTextRegion"),
                    "optionsRegion": text_regions.get("optionsRegion"),
                    "diagramRegion": [
                        int(diagram_bbox[0]),
                        int(diagram_bbox[1]),
                        int(diagram_bbox[2]),
                        int(diagram_bbox[3]),
                    ]
                    if diagram_bbox is not None
                    else None,
                },
            }
        )

    return {
        "pageNumber": page_number,
        "rawImage": raw_page_path,
        "preprocessedImage": pre_page_path,
        "deskewAngle": angle,
        "blocks": page_blocks,
    }


def process_pdf(input_pdf, output_dir, dpi):
    ensure_dir(output_dir)
    pages_output = []

    doc = fitz.open(input_pdf)
    zoom = float(dpi) / 72.0
    matrix = fitz.Matrix(zoom, zoom)

    for page_idx in range(len(doc)):
        page = doc.load_page(page_idx)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        color = to_bgr(pix)

        page_number = page_idx + 1
        pages_output.append(process_page_image(color, page_number, output_dir))

    doc.close()
    return {"success": True, "pages": pages_output}


def process_image(input_image, output_dir):
    ensure_dir(output_dir)
    color = cv2.imread(input_image, cv2.IMREAD_COLOR)
    if color is None or color.size == 0:
        raise ValueError("Unable to read input image.")
    page_output = process_page_image(color, 1, output_dir)
    return {"success": True, "pages": [page_output]}


def process_input(input_path, output_dir, dpi):
    ext = os.path.splitext(str(input_path).lower())[1]
    if ext == ".pdf":
        return process_pdf(input_path, output_dir, dpi)
    if ext in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}:
        return process_image(input_path, output_dir)
    raise ValueError("Unsupported input type. Allowed: PDF, PNG, JPG, JPEG, BMP, TIF, TIFF, WEBP")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input PDF path")
    parser.add_argument("--output", required=True, help="Output folder path")
    parser.add_argument("--dpi", default="300", help="Render DPI (default 300)")
    args = parser.parse_args()

    try:
        dpi = int(args.dpi)
        result = process_input(args.input, args.output, dpi=dpi)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
