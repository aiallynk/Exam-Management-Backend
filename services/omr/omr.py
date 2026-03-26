import json
import math
import os
import re
import sys
import traceback
from dataclasses import dataclass
from shutil import which
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

try:
    import fitz  # type: ignore
except Exception:
    fitz = None

try:
    import pytesseract  # type: ignore
except Exception:
    pytesseract = None


@dataclass
class BubbleCandidate:
    """Stores one detected bubble contour and geometric properties."""

    contour: np.ndarray
    center: Tuple[float, float]
    radius: float
    bbox: Tuple[int, int, int, int]
    area: float
    circularity: float


class OMRScanner:
    """Robust OpenCV-based OMR scanner for 4-option (A/B/C/D) answer sheets."""

    def __init__(
        self,
        options: str = "ABCD",
        fill_threshold: float = 0.40,
        similarity_threshold: float = 0.10,
        output_size: Tuple[int, int] = (2000, 2800),
    ) -> None:
        self.options = list(options)
        self.options_per_question = len(self.options)
        self.fill_threshold = float(fill_threshold)
        self.similarity_threshold = float(similarity_threshold)
        self.output_size = output_size

        # Strict contour-filtering rules requested for bubble candidates.
        self.min_bubble_area = 300.0
        self.max_bubble_area = 1200.0
        self.min_aspect_ratio = 0.90
        self.max_aspect_ratio = 1.10
        self.min_circularity = 0.70

        # Template-relative roll-grid box (x1, y1, x2, y2) for generated OMR sheets.
        self.roll_grid_rel = (0.075, 0.235, 0.490, 0.395)
        # Template-relative candidate-name input box.
        self.candidate_name_rel = (0.075, 0.425, 0.490, 0.455)
        # Template-relative exam-code text areas.
        # Prioritize the top-left printed exam-code line on page 1, then keep
        # broader fallbacks for older headers and continuation pages.
        self.exam_code_rois_rel = [
            # Page-1 dedicated exam-code line near the top-left header block.
            (0.030, 0.096, 0.480, 0.128),
            # Page-1 slightly wider fallback that still centers the printed code.
            (0.030, 0.096, 0.600, 0.128),
            # Page-1 value-biased fallback shifted right toward the code token.
            (0.100, 0.096, 0.560, 0.128),
            # Legacy broader header row ("Exam Code: <value> | Exam Date | Paper")
            (0.040, 0.078, 0.620, 0.136),
            # Continuation-page header line near right side.
            (0.685, 0.040, 0.975, 0.074),
        ]
        # Tesseract performs better on a wider top-left header strip that still
        # contains the printed exam-code text.
        self.exam_code_tesseract_rois_rel = [
            (0.020, 0.040, 0.550, 0.150),
            (0.020, 0.020, 0.450, 0.100),
            (0.020, 0.080, 0.420, 0.140),
            (0.030, 0.080, 0.600, 0.140),
        ]
        # Conservative identity-token guards to prevent roll/exam cross-detection.
        self.exam_code_min_len = 4
        self.exam_code_max_len = 24
        self.exam_code_numeric_min_len = 5
        self.exam_code_numeric_max_len = 8
        self.roll_number_like_min_len = 10
        self._ocr_templates = self._build_text_templates()
        self._last_exam_code_debug: Dict[str, object] = {}
        self._tesseract_cmd = self._resolve_tesseract_cmd()
        if pytesseract is not None and self._tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = self._tesseract_cmd

    @staticmethod
    def _resolve_tesseract_cmd() -> str:
        """Locate the local Tesseract executable when available."""
        candidates = [
            os.environ.get("TESSERACT_CMD", ""),
            which("tesseract") or "",
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        ]
        for candidate in candidates:
            if candidate and os.path.exists(candidate):
                return candidate
        return ""

    @staticmethod
    def _find_contours(binary: np.ndarray, mode: int, method: int) -> List[np.ndarray]:
        """OpenCV version-safe contour finder."""
        found = cv2.findContours(binary, mode, method)
        return found[0] if len(found) == 2 else found[1]



    @staticmethod
    def _order_points(pts: np.ndarray) -> np.ndarray:
        """Return points ordered as top-left, top-right, bottom-right, bottom-left."""
        rect = np.zeros((4, 2), dtype="float32")
        s = pts.sum(axis=1)
        rect[0] = pts[np.argmin(s)]
        rect[2] = pts[np.argmax(s)]

        diff = np.diff(pts, axis=1)
        rect[1] = pts[np.argmin(diff)]
        rect[3] = pts[np.argmax(diff)]
        return rect

    def _detect_document_corners(self, image: np.ndarray) -> np.ndarray:
        """
        Detect the outer paper contour and return 4 corners.
        Falls back to full image bounds if a clean document contour is not found.
        """
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Edges + morphology improves robustness for tilted/rotated scans.
        edges = cv2.Canny(blurred, 50, 150)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

        contours = self._find_contours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = sorted(contours, key=cv2.contourArea, reverse=True)

        h, w = gray.shape
        image_area = float(h * w)
        min_sheet_area = image_area * 0.20

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < min_sheet_area:
                continue

            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
            if len(approx) == 4:
                return self._order_points(approx.reshape(4, 2).astype("float32"))

        # Fallback: use minimum-area rectangle of largest contour.
        if contours:
            largest = contours[0]
            if cv2.contourArea(largest) >= min_sheet_area * 0.75:
                rect = cv2.minAreaRect(largest)
                box = cv2.boxPoints(rect)
                return self._order_points(box.astype("float32"))

        # Final fallback: whole image.
        return np.array(
            [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]],
            dtype="float32",
        )

    def _perspective_correct(self, image: np.ndarray) -> np.ndarray:
        """Warp the sheet to a fixed top-down view for stable bubble localization."""
        corners = self._detect_document_corners(image)
        out_w, out_h = self.output_size

        dst = np.array(
            [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
            dtype="float32",
        )

        matrix = cv2.getPerspectiveTransform(corners, dst)
        warped = cv2.warpPerspective(
            image,
            matrix,
            (out_w, out_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )
        return warped

    def _preprocess_for_bubbles(self, warped: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        1) Gray
        2) Gaussian blur
        3) Adaptive threshold
        4) Morphology to suppress tiny dots and scan noise
        """
        gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Adaptive thresholding with THRESH_BINARY_INV for robust dark-mark extraction.
        block_size = int(max(25, (min(gray.shape) * 0.02) // 2 * 2 + 1))
        block_size = min(block_size, 51)
        if block_size % 2 == 0:
            block_size += 1

        binary = cv2.adaptiveThreshold(
            blurred,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            block_size,
            8,
        )

        kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel3, iterations=1)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel3, iterations=1)

        # Remove tiny connected components to suppress dust/noise dots.
        components = cv2.connectedComponentsWithStats(binary, connectivity=8)
        _num_labels, labels, stats, _centroids = components
        cleaned = np.zeros_like(binary)
        for label_idx in range(1, stats.shape[0]):
            area = stats[label_idx, cv2.CC_STAT_AREA]
            if area >= 18:
                cleaned[labels == label_idx] = 255
        binary = cleaned

        # Border masking removes edge shadows and page-border artifacts.
        h, w = binary.shape
        margin = int(min(h, w) * 0.015)
        binary[:margin, :] = 0
        binary[h - margin :, :] = 0
        binary[:, :margin] = 0
        binary[:, w - margin :] = 0

        return gray, blurred, binary

    def _detect_bubble_contours(self, binary: np.ndarray, scale: float = 1.0) -> List[BubbleCandidate]:
        """
        Detect and filter bubble contours using geometry and circularity.
        Filters out:
        - tiny dots
        - elongated artifacts
        - border noise
        """
        if scale <= 0:
            scale = 1.0

        if abs(scale - 1.0) > 1e-6:
            working_binary = cv2.resize(
                binary,
                None,
                fx=scale,
                fy=scale,
                interpolation=cv2.INTER_NEAREST,
            )
        else:
            working_binary = binary

        contours = self._find_contours(working_binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

        h, w = working_binary.shape
        border_margin = int(min(h, w) * 0.018)

        candidates: List[BubbleCandidate] = []
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < self.min_bubble_area or area > self.max_bubble_area:
                continue

            x, y, bw, bh = cv2.boundingRect(contour)
            if x <= border_margin or y <= border_margin:
                continue
            if (x + bw) >= (w - border_margin) or (y + bh) >= (h - border_margin):
                continue
            if bw < 8 or bh < 8:
                continue

            aspect_ratio = bw / float(bh)
            if aspect_ratio < self.min_aspect_ratio or aspect_ratio > self.max_aspect_ratio:
                continue

            perimeter = cv2.arcLength(contour, True)
            if perimeter <= 0:
                continue

            circularity = float((4.0 * math.pi * area) / (perimeter * perimeter + 1e-6))
            if circularity < self.min_circularity:
                continue

            approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
            if len(approx) < 6:
                continue

            (cx, cy), radius = cv2.minEnclosingCircle(contour)
            if radius < 6 or radius > 36:
                continue

            candidates.append(
                BubbleCandidate(
                    contour=contour,
                    center=(float(cx / scale), float(cy / scale)),
                    radius=float(radius / scale),
                    bbox=(
                        int(round(x / scale)),
                        int(round(y / scale)),
                        int(round(bw / scale)),
                        int(round(bh / scale)),
                    ),
                    area=float(area / (scale * scale)),
                    circularity=circularity,
                )
            )

        # De-duplicate near-overlapping contours by preferring larger circular candidates.
        candidates.sort(key=lambda c: (c.area, c.circularity), reverse=True)
        deduped: List[BubbleCandidate] = []
        for candidate in candidates:
            is_duplicate = False
            for kept in deduped:
                dx = candidate.center[0] - kept.center[0]
                dy = candidate.center[1] - kept.center[1]
                distance = math.hypot(dx, dy)
                if distance < max(3.0, min(candidate.radius, kept.radius) * 0.65):
                    is_duplicate = True
                    break
            if not is_duplicate:
                deduped.append(candidate)

        return deduped

    def _detect_bubbles_with_scale_search(
        self,
        binary: np.ndarray,
        expected_questions: Optional[int] = None,
    ) -> Tuple[List[BubbleCandidate], float, List[List[BubbleCandidate]]]:
        """
        Run strict contour filtering at multiple image scales and choose the
        candidate set that produces the strongest 4-option row grouping.
        """
        scales = [1.0, 1.2, 1.4, 1.6, 1.8]
        best_bubbles: List[BubbleCandidate] = []
        best_groups: List[List[BubbleCandidate]] = []
        best_scale = 1.0
        best_score = float("-inf")

        for scale in scales:
            bubbles = self._detect_bubble_contours(binary, scale=scale)
            groups = self._group_bubbles_row_wise(bubbles)

            score = float(len(groups) * 10 + len(bubbles) * 0.1)
            if expected_questions is not None and expected_questions > 0:
                score -= abs(len(groups) - expected_questions) * 2.5

            if score > best_score:
                best_score = score
                best_scale = scale
                best_bubbles = bubbles
                best_groups = groups

        return best_bubbles, best_scale, best_groups

    def _cluster_rows(self, bubbles: Sequence[BubbleCandidate]) -> List[List[BubbleCandidate]]:
        """Cluster bubbles by Y coordinate, then sort each row by X."""
        if not bubbles:
            return []

        median_radius = float(np.median([b.radius for b in bubbles]))
        y_tolerance = max(8.0, median_radius * 1.2)

        rows: List[Dict[str, object]] = []
        for bubble in sorted(bubbles, key=lambda b: b.center[1]):
            matched = False
            for row in rows:
                if abs(bubble.center[1] - row["y_mean"]) <= y_tolerance:
                    row["items"].append(bubble)
                    row["y_mean"] = float(np.mean([item.center[1] for item in row["items"]]))
                    matched = True
                    break

            if not matched:
                rows.append({"y_mean": bubble.center[1], "items": [bubble]})

        ordered_rows: List[List[BubbleCandidate]] = []
        for row in sorted(rows, key=lambda r: r["y_mean"]):
            items = sorted(row["items"], key=lambda b: b.center[0])
            ordered_rows.append(items)

        return ordered_rows

    def _estimate_option_gap(
        self,
        rows: Sequence[Sequence[BubbleCandidate]],
        median_diameter: float,
    ) -> float:
        """Estimate horizontal A-B-C-D spacing used to split rows into question groups."""
        diffs: List[float] = []
        for row in rows:
            if len(row) < 2:
                continue
            xs = [bubble.center[0] for bubble in row]
            row_diffs = [xs[idx + 1] - xs[idx] for idx in range(len(xs) - 1)]
            for diff in row_diffs:
                if diff > median_diameter * 0.35:
                    diffs.append(diff)

        if not diffs:
            return max(12.0, median_diameter * 1.4)

        # Lower percentile captures intra-question spacing instead of large inter-block gaps.
        return max(10.0, float(np.percentile(diffs, 30)))

    @staticmethod
    def _remove_one_outlier(
        segment: List[BubbleCandidate], expected_gap: float
    ) -> List[BubbleCandidate]:
        """For a 5-bubble segment, remove one outlier and keep the best 4-bubble set."""
        if len(segment) != 5:
            return []

        best_candidate: List[BubbleCandidate] = []
        best_cost = float("inf")

        for idx in range(len(segment)):
            trial = segment[:idx] + segment[idx + 1 :]
            xs = [bubble.center[0] for bubble in trial]
            gaps = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
            if not gaps:
                continue

            cost = float(np.std(gaps) + abs(np.mean(gaps) - expected_gap))
            if cost < best_cost:
                best_cost = cost
                best_candidate = trial

        return best_candidate

    def _group_bubbles_row_wise(self, bubbles: Sequence[BubbleCandidate]) -> List[List[BubbleCandidate]]:
        """Return row-wise ordered groups of exactly 4 bubbles per question."""
        if len(bubbles) < self.options_per_question:
            return []

        rows = self._cluster_rows(bubbles)
        median_diameter = float(np.median([bubble.radius * 2.0 for bubble in bubbles]))
        expected_gap = self._estimate_option_gap(rows, median_diameter)
        split_threshold = max(expected_gap * 1.9, median_diameter * 2.3)

        groups: List[List[BubbleCandidate]] = []

        for row in rows:
            if len(row) < self.options_per_question:
                continue

            # Break very long rows where large X gaps imply separate question blocks.
            segments: List[List[BubbleCandidate]] = []
            current_segment: List[BubbleCandidate] = [row[0]]
            for idx in range(1, len(row)):
                prev_x = row[idx - 1].center[0]
                curr_x = row[idx].center[0]
                if (curr_x - prev_x) > split_threshold:
                    segments.append(current_segment)
                    current_segment = [row[idx]]
                else:
                    current_segment.append(row[idx])
            segments.append(current_segment)

            for segment in segments:
                if len(segment) < self.options_per_question:
                    continue

                if (len(segment) % self.options_per_question) != 0:
                    # Strictly avoid converting unrelated bubble grids (e.g. 10-wide roll grids)
                    # into false A/B/C/D groups. Only recover a single extra contour in 5-wide rows.
                    if len(segment) == (self.options_per_question + 1):
                        segment = self._remove_one_outlier(segment, expected_gap)
                    else:
                        segment = []
                    if len(segment) != self.options_per_question:
                        continue

                for start in range(0, len(segment), self.options_per_question):
                    group = segment[start : start + self.options_per_question]
                    if len(group) != self.options_per_question:
                        continue

                    xs = [bubble.center[0] for bubble in group]
                    ys = [bubble.center[1] for bubble in group]
                    x_gaps = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]

                    # Final sanity checks for a clean A/B/C/D set.
                    if any(gap <= median_diameter * 0.30 for gap in x_gaps):
                        continue
                    if max(ys) - min(ys) > median_diameter * 0.9:
                        continue

                    groups.append(group)

        return self._order_question_groups(groups)

    @staticmethod
    def _order_question_groups(groups: Sequence[Sequence[BubbleCandidate]]) -> List[List[BubbleCandidate]]:
        """
        Order grouped questions robustly for single-column and multi-column layouts.
        For multi-column sheets (common in exam OMR), order is column-major:
        left column top-to-bottom, then next column.
        """
        if not groups:
            return []

        meta: List[Dict[str, object]] = []
        widths: List[float] = []
        for group in groups:
            xs = [bubble.center[0] for bubble in group]
            ys = [bubble.center[1] for bubble in group]
            width = float(max(xs) - min(xs))
            widths.append(width)
            meta.append(
                {
                    "group": list(group),
                    "cx": float(np.mean(xs)),
                    "cy": float(np.mean(ys)),
                    "width": width,
                }
            )

        median_width = float(np.median(widths)) if widths else 80.0
        x_tolerance = max(70.0, median_width * 1.8)

        # Build X clusters as columns.
        columns: List[Dict[str, object]] = []
        for item in sorted(meta, key=lambda m: m["cx"]):
            if not columns:
                columns.append({"x_mean": item["cx"], "items": [item]})
                continue

            if abs(item["cx"] - columns[-1]["x_mean"]) <= x_tolerance:
                columns[-1]["items"].append(item)
                columns[-1]["x_mean"] = float(
                    np.mean([entry["cx"] for entry in columns[-1]["items"]])
                )
            else:
                columns.append({"x_mean": item["cx"], "items": [item]})

        # Single-column fallback: standard top-to-bottom ordering.
        if len(columns) <= 1:
            ordered = sorted(meta, key=lambda m: (m["cy"], m["cx"]))
            return [item["group"] for item in ordered]

        # Multi-column ordering: left-to-right columns, top-to-bottom inside each column.
        ordered_groups: List[List[BubbleCandidate]] = []
        for column in columns:
            column_items = sorted(column["items"], key=lambda m: m["cy"])
            ordered_groups.extend([item["group"] for item in column_items])

        return ordered_groups

    @staticmethod
    def _estimate_deskew_angle(bubbles: Sequence[BubbleCandidate]) -> float:
        """
        Estimate sheet skew from bubble cloud orientation.
        Returns angle (degrees) to pass directly to cv2.warpAffine rotation.
        """
        if len(bubbles) < 12:
            return 0.0

        points = np.array([bubble.center for bubble in bubbles], dtype=np.float32)
        rect = cv2.minAreaRect(points)
        raw_angle = float(rect[-1])

        if rect[1][0] < rect[1][1]:
            raw_angle += 90.0

        # Align dominant bubble orientation toward vertical (90 degrees).
        return raw_angle - 90.0

    @staticmethod
    def _rotate_image(image: np.ndarray, angle: float) -> np.ndarray:
        """Rotate image around center while preserving dimensions and white background."""
        h, w = image.shape[:2]
        center = (w / 2.0, h / 2.0)
        matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(
            image,
            matrix,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )
        return rotated

    @staticmethod
    def _select_question_window(
        groups: Sequence[Sequence[BubbleCandidate]],
        expected_questions: int,
    ) -> List[List[BubbleCandidate]]:
        """
        Choose the most likely contiguous block of answer groups when extras exist.
        Preference is given to lower-page windows because roll-number bubbles are
        usually located higher than the main answer grid on exam sheets.
        """
        if len(groups) <= expected_questions:
            return [list(group) for group in groups]

        centers = [
            (
                float(np.mean([bubble.center[0] for bubble in group])),
                float(np.mean([bubble.center[1] for bubble in group])),
            )
            for group in groups
        ]

        best_start = 0
        best_score = float("-inf")
        max_start = len(groups) - expected_questions

        for start in range(max_start + 1):
            window = centers[start : start + expected_questions]
            y_values = [center[1] for center in window]
            x_values = [center[0] for center in window]

            # Higher mean Y preferred; heavy X jitter penalized.
            score = float(np.mean(y_values) - 0.05 * np.std(x_values))
            if score > best_score:
                best_score = score
                best_start = start

        selected = groups[best_start : best_start + expected_questions]
        return [list(group) for group in selected]

    @staticmethod
    def _compute_fill_ratio(
        binary: np.ndarray,
        _gray: np.ndarray,
        bubble: BubbleCandidate,
    ) -> float:
        """
        Fill score based on dark-pixel occupancy in the bubble center region.
        Combined metric helps reject light pencil marks and ring-only outlines.
        """
        x, y, w, h = bubble.bbox
        pad = int(max(2, round(bubble.radius * 0.4)))

        x0 = max(0, x - pad)
        y0 = max(0, y - pad)
        x1 = min(binary.shape[1], x + w + pad)
        y1 = min(binary.shape[0], y + h + pad)

        roi_binary = binary[y0:y1, x0:x1]
        if roi_binary.size == 0:
            return 0.0

        mask = np.zeros(roi_binary.shape, dtype="uint8")
        cx = int(round(bubble.center[0] - x0))
        cy = int(round(bubble.center[1] - y0))

        # Core-only mask prevents the printed ring from inflating fill values.
        core_radius = max(3, int(round(bubble.radius * 0.60)))
        cv2.circle(mask, (cx, cy), core_radius, 255, -1)

        total_pixels = cv2.countNonZero(mask)
        if total_pixels == 0:
            return 0.0

        # fill_ratio = dark_pixels / total_pixels
        filled_pixels = cv2.countNonZero(cv2.bitwise_and(roi_binary, roi_binary, mask=mask))
        return float(np.clip(filled_pixels / float(total_pixels), 0.0, 1.0))

    def _decide_mark(self, fill_scores: Sequence[float]) -> str:
        """
        Apply decision rules:
        - Best score < 40% => SKIPPED
        - Top two scores within 10% => INVALID
        - Otherwise choose highest score bubble
        """
        if not fill_scores:
            return "SKIPPED"

        ranked = np.argsort(fill_scores)[::-1]
        best_idx = int(ranked[0])
        best_score = float(fill_scores[best_idx])

        if best_score < self.fill_threshold:
            return "SKIPPED"

        if len(ranked) > 1:
            second_score = float(fill_scores[int(ranked[1])])
            if abs(best_score - second_score) < self.similarity_threshold:
                return "INVALID"

        return self.options[best_idx]

    @staticmethod
    def _cluster_1d(values: Sequence[float], tolerance: float) -> List[Dict[str, object]]:
        """Cluster sorted 1D values using a fixed distance tolerance."""
        clusters: List[Dict[str, object]] = []
        for value in sorted(values):
            if not clusters or abs(value - clusters[-1]["mean"]) > tolerance:
                clusters.append({"mean": float(value), "values": [float(value)]})
                continue

            clusters[-1]["values"].append(float(value))
            clusters[-1]["mean"] = float(np.mean(clusters[-1]["values"]))

        return clusters

    @staticmethod
    def _select_top_clusters(
        clusters: Sequence[Dict[str, object]],
        target_count: int,
    ) -> List[Dict[str, object]]:
        """Keep the strongest N clusters by membership count, then sort by mean."""
        if len(clusters) < target_count:
            return []

        selected = sorted(clusters, key=lambda c: len(c["values"]), reverse=True)[:target_count]
        return sorted(selected, key=lambda c: c["mean"])

    def _extract_roll_from_bubble_grid(
        self,
        binary: np.ndarray,
    ) -> Tuple[str, str]:
        """
        Detect roll number from 10x10 digit bubble grid.
        Returns (roll_number, status) where status is one of:
        - OK
        - INVALID
        - INCOMPLETE
        """
        h, w = binary.shape
        x1_rel, y1_rel, x2_rel, y2_rel = self.roll_grid_rel
        x0 = int(round(w * x1_rel))
        y0 = int(round(h * y1_rel))
        x1 = int(round(w * x2_rel))
        y1 = int(round(h * y2_rel))

        x0 = max(0, min(w - 1, x0))
        y0 = max(0, min(h - 1, y0))
        x1 = max(x0 + 1, min(w, x1))
        y1 = max(y0 + 1, min(h, y1))

        roi = binary[y0:y1, x0:x1]
        if roi.size == 0:
            return "", "INCOMPLETE"

        contours = self._find_contours(roi, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        raw_candidates: List[Dict[str, float]] = []
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < 120 or area > 1400:
                continue

            bx, by, bw, bh = cv2.boundingRect(contour)
            if bw < 6 or bh < 6:
                continue

            aspect_ratio = bw / float(bh)
            if aspect_ratio < 0.75 or aspect_ratio > 1.25:
                continue

            perimeter = cv2.arcLength(contour, True)
            if perimeter <= 0:
                continue

            circularity = float((4.0 * math.pi * area) / (perimeter * perimeter + 1e-6))
            if circularity < 0.55:
                continue

            (cx, cy), radius = cv2.minEnclosingCircle(contour)
            if radius < 4.0 or radius > 24.0:
                continue

            raw_candidates.append(
                {
                    "x": float(cx),
                    "y": float(cy),
                    "r": float(radius),
                    "area": float(area),
                }
            )

        # Remove inner/outer ring duplicates around the same bubble center.
        raw_candidates.sort(key=lambda c: c["area"], reverse=True)
        deduped: List[Dict[str, float]] = []
        for candidate in raw_candidates:
            duplicate = False
            for kept in deduped:
                dx = candidate["x"] - kept["x"]
                dy = candidate["y"] - kept["y"]
                if (dx * dx + dy * dy) < 16.0:
                    duplicate = True
                    break
            if not duplicate:
                deduped.append(candidate)

        if len(deduped) < 60:
            return "", "INCOMPLETE"

        median_radius = float(np.median([candidate["r"] for candidate in deduped]))
        cluster_tol = max(6.0, median_radius * 1.4)

        x_clusters = self._cluster_1d([candidate["x"] for candidate in deduped], cluster_tol)
        y_clusters = self._cluster_1d([candidate["y"] for candidate in deduped], cluster_tol)

        x_clusters = self._select_top_clusters(x_clusters, target_count=10)
        y_clusters = self._select_top_clusters(y_clusters, target_count=10)
        if len(x_clusters) != 10 or len(y_clusters) != 10:
            return "", "INCOMPLETE"

        x_centers = [cluster["mean"] for cluster in x_clusters]
        y_centers = [cluster["mean"] for cluster in y_clusters]

        slot_radius = max(6.0, median_radius)
        fill_matrix = np.zeros((10, 10), dtype=np.float32)
        for row in range(10):
            for col in range(10):
                center_x = x_centers[col]
                center_y = y_centers[row]

                global_x = x0 + center_x
                global_y = y0 + center_y
                bbox_x = int(round(global_x - slot_radius))
                bbox_y = int(round(global_y - slot_radius))
                bbox_w = int(round(slot_radius * 2.0))
                bbox_h = int(round(slot_radius * 2.0))

                bubble = BubbleCandidate(
                    contour=np.empty((0, 1, 2), dtype=np.int32),
                    center=(float(global_x), float(global_y)),
                    radius=float(slot_radius),
                    bbox=(bbox_x, bbox_y, bbox_w, bbox_h),
                    area=float(math.pi * slot_radius * slot_radius),
                    circularity=1.0,
                )
                fill_matrix[row, col] = self._compute_fill_ratio(binary, binary, bubble)

        roll_digits: List[str] = []
        has_invalid = False
        has_incomplete = False

        for col in range(10):
            scores = fill_matrix[:, col]
            ranked = np.argsort(scores)[::-1]
            best_row = int(ranked[0])
            best_score = float(scores[best_row])
            second_score = float(scores[int(ranked[1])]) if len(ranked) > 1 else 0.0

            if best_score < self.fill_threshold:
                has_incomplete = True
                continue

            if abs(best_score - second_score) < self.similarity_threshold:
                has_invalid = True
                continue

            roll_digits.append(str(best_row))

        if has_invalid:
            return "", "INVALID"
        if has_incomplete or len(roll_digits) != 10:
            return "", "INCOMPLETE"

        return "".join(roll_digits), "OK"

    @staticmethod
    def _extract_roll_from_filename(image_path: str) -> str:
        """Lightweight fallback roll number extraction from filename."""
        filename = os.path.basename(image_path)
        base, _ = os.path.splitext(filename)

        explicit = re.search(r"(?:roll|reg|candidate|id)[-_ ]*([a-zA-Z0-9]+)", base, re.IGNORECASE)
        if explicit:
            return explicit.group(1).upper()

        numeric = re.search(r"(\d{4,})", base)
        if numeric:
            return numeric.group(1)

        return ""

    @staticmethod
    def _normalize_glyph_image(glyph: np.ndarray, size: int = 32) -> np.ndarray:
        """Normalize a binary glyph into a fixed-size canvas."""
        canvas = np.zeros((size, size), dtype=np.uint8)
        if glyph is None or glyph.size == 0:
            return canvas

        if len(glyph.shape) == 3:
            glyph = cv2.cvtColor(glyph, cv2.COLOR_BGR2GRAY)

        _, glyph_bin = cv2.threshold(glyph, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        x, y, w, h = cv2.boundingRect(glyph_bin)
        if w <= 0 or h <= 0:
            return canvas

        cropped = glyph_bin[y : y + h, x : x + w]
        target = max(1, size - 8)
        scale = min(target / float(max(1, w)), target / float(max(1, h)))
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))

        resized = cv2.resize(cropped, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
        offset_x = (size - new_w) // 2
        offset_y = (size - new_h) // 2
        canvas[offset_y : offset_y + new_h, offset_x : offset_x + new_w] = resized
        return canvas

    def _build_text_templates(self) -> List[Tuple[str, np.ndarray]]:
        """
        Build lightweight OCR templates for alphanumeric text.
        This avoids external OCR dependencies and works for generated/printed text.
        """
        charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:"
        fonts = [
            cv2.FONT_HERSHEY_SIMPLEX,
            cv2.FONT_HERSHEY_DUPLEX,
            cv2.FONT_HERSHEY_COMPLEX,
            cv2.FONT_HERSHEY_TRIPLEX,
        ]
        scales = [0.62, 0.72, 0.82]
        thicknesses = [1, 2]

        templates: List[Tuple[str, np.ndarray]] = []
        for ch in charset:
            for font in fonts:
                for scale in scales:
                    for thickness in thicknesses:
                        glyph = np.zeros((46, 46), dtype=np.uint8)
                        cv2.putText(
                            glyph,
                            ch,
                            (4, 34),
                            font,
                            scale,
                            255,
                            thickness,
                            cv2.LINE_AA,
                        )
                        normalized = self._normalize_glyph_image(glyph, size=32)
                        if cv2.countNonZero(normalized) == 0:
                            continue
                        templates.append((ch, normalized))
        return templates

    def _classify_glyph(self, glyph: np.ndarray) -> Tuple[str, float]:
        """Classify one segmented glyph against template bank."""
        normalized = self._normalize_glyph_image(glyph, size=32)
        if cv2.countNonZero(normalized) == 0:
            return "", 0.0

        norm_f = normalized.astype(np.float32).reshape(-1)
        norm_mag = float(np.linalg.norm(norm_f))
        if norm_mag <= 1e-6:
            return "", 0.0

        best_char = ""
        best_score = 0.0
        for ch, template in self._ocr_templates:
            tpl_f = template.astype(np.float32).reshape(-1)
            denom = norm_mag * float(np.linalg.norm(tpl_f)) + 1e-6
            score = float(np.dot(norm_f, tpl_f) / denom)
            if score > best_score:
                best_score = score
                best_char = ch

        return best_char, best_score

    def _extract_text_from_roi_using_templates(
        self,
        gray: np.ndarray,
        roi_rel: Tuple[float, float, float, float],
        min_score: float = 0.14,
    ) -> Tuple[str, float]:
        """
        OCR one text line from a relative ROI using internal glyph templates.
        Returns (best_text, quality_score).
        """
        if gray is None or gray.size == 0:
            return "", 0.0

        h, w = gray.shape
        x1_rel, y1_rel, x2_rel, y2_rel = roi_rel
        x0 = max(0, min(w - 1, int(round(w * x1_rel))))
        y0 = max(0, min(h - 1, int(round(h * y1_rel))))
        x1 = max(x0 + 1, min(w, int(round(w * x2_rel))))
        y1 = max(y0 + 1, min(h, int(round(h * y2_rel))))
        roi = gray[y0:y1, x0:x1]
        if roi.size == 0:
            return "", 0.0

        margin_x = max(1, int(roi.shape[1] * 0.008))
        margin_y = max(1, int(roi.shape[0] * 0.12))
        if roi.shape[1] <= margin_x * 2 or roi.shape[0] <= margin_y * 2:
            return "", 0.0
        text_roi = roi[margin_y : roi.shape[0] - margin_y, margin_x : roi.shape[1] - margin_x]
        if text_roi.size == 0:
            return "", 0.0

        # Upscale small header text before thresholding/classification.
        upsample_factor = 1.35 if min(text_roi.shape[:2]) <= 120 else 1.2
        text_scaled = cv2.resize(
            text_roi,
            None,
            fx=upsample_factor,
            fy=upsample_factor,
            interpolation=cv2.INTER_CUBIC,
        )
        text_blur = cv2.GaussianBlur(text_scaled, (3, 3), 0)
        adaptive_block = int(max(21, (min(text_blur.shape[:2]) * 0.16) // 2 * 2 + 1))
        adaptive_block = min(adaptive_block, 51)
        if adaptive_block % 2 == 0:
            adaptive_block += 1

        adaptive_main = cv2.adaptiveThreshold(
            text_blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            adaptive_block,
            8,
        )
        adaptive_soft = cv2.adaptiveThreshold(
            text_blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            adaptive_block,
            6,
        )
        _, otsu_bin = cv2.threshold(
            text_blur,
            0,
            255,
            cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
        )
        variants = [adaptive_main, adaptive_soft, otsu_bin]

        best_text = ""
        best_quality = 0.0
        for text_bin in variants:
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
            text_bin = cv2.morphologyEx(text_bin, cv2.MORPH_OPEN, kernel, iterations=1)
            text_bin = cv2.morphologyEx(text_bin, cv2.MORPH_CLOSE, kernel, iterations=1)

            num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(text_bin, connectivity=8)
            components: List[Tuple[int, int, int, int, int, np.ndarray]] = []
            min_component_area = 14 if upsample_factor > 1.0 else 8
            for idx in range(1, num_labels):
                x = int(stats[idx, cv2.CC_STAT_LEFT])
                y = int(stats[idx, cv2.CC_STAT_TOP])
                bw = int(stats[idx, cv2.CC_STAT_WIDTH])
                bh = int(stats[idx, cv2.CC_STAT_HEIGHT])
                area = int(stats[idx, cv2.CC_STAT_AREA])

                if area < min_component_area:
                    continue
                if bw < 2 or bh < 5:
                    continue
                if bh > int(text_bin.shape[0] * 0.96):
                    continue
                components.append((x, y, bw, bh, area, text_bin[y : y + bh, x : x + bw]))

            if not components:
                continue

            if len(components) > 72:
                components = sorted(components, key=lambda item: item[4], reverse=True)[:72]
            components.sort(key=lambda item: item[0])
            gaps: List[float] = []
            for idx in range(1, len(components)):
                prev = components[idx - 1]
                curr = components[idx]
                gaps.append(float(curr[0] - (prev[0] + prev[2])))

            median_width = float(np.median([component[2] for component in components]))
            if gaps:
                median_gap = float(np.median(gaps))
                std_gap = float(np.std(gaps))
                space_gap = max(4.0, median_gap + max(1.5, std_gap * 1.2))
            else:
                space_gap = max(4.0, median_width * 0.8)

            chars: List[str] = []
            scores: List[float] = []
            prev_right: Optional[int] = None
            for x, _y, bw, _bh, _area, glyph in components:
                if prev_right is not None and float(x - prev_right) > space_gap:
                    chars.append(" ")

                ch, score = self._classify_glyph(glyph)
                if ch and score >= min_score:
                    chars.append(ch.upper())
                    scores.append(score)
                prev_right = x + bw

            if not chars:
                continue

            raw_text = re.sub(r"\s+", " ", "".join(chars)).strip()
            if not raw_text:
                continue

            avg_score = float(np.mean(scores)) if scores else 0.0
            alpha_num_count = len(re.sub(r"[^A-Za-z0-9]", "", raw_text))
            quality = avg_score + min(0.8, alpha_num_count / 20.0)

            if quality > best_quality:
                best_quality = quality
                best_text = raw_text

        return best_text, best_quality

    @staticmethod
    def _normalize_exam_code_text(value: str) -> str:
        """
        Normalize OCR text into a likely exam code token.
        Returns an uppercase exam-code candidate.
        """
        upper = re.sub(r"[^A-Za-z0-9 ]+", " ", str(value or "")).upper()
        upper = re.sub(r"\s+", " ", upper).strip()
        if not upper:
            return ""

        strict = OMRScanner._format_strict_exam_code_candidate(upper)
        if strict:
            return strict

        compact = upper.replace(" ", "")

        prefixed = re.search(r"(?:EXAMCODE|EXAMID|CODE)(EXAM[A-Z0-9]{8}|[A-Z0-9]{4,})", compact)
        if prefixed:
            strict = OMRScanner._format_strict_exam_code_candidate(prefixed.group(1))
            if strict:
                return strict
            return prefixed.group(1)

        exam_code_tail = re.search(r"EXAM\s*CODE\s*(.+)$", upper)
        if exam_code_tail:
            strict = OMRScanner._format_strict_exam_code_candidate(exam_code_tail.group(1))
            if strict:
                return strict
            tail = re.sub(r"[^A-Z0-9]", "", exam_code_tail.group(1))
            if len(tail) >= 4:
                return tail

        tokens = [token for token in upper.split(" ") if token]
        filtered = [
            token
            for token in tokens
            if token not in {"EXAM", "CODE", "EXAMCODE", "EXAMID"}
        ]
        if not filtered:
            return ""

        strong = [
            token
            for token in filtered
            if len(token) >= 4 and re.search(r"[A-Z]", token) and re.search(r"\d", token)
        ]
        if strong:
            return max(strong, key=len)

        numeric = [token for token in filtered if token.isdigit() and 5 <= len(token) <= 8]
        if numeric:
            return max(numeric, key=len)

        return ""

    @staticmethod
    def _format_strict_exam_code_candidate(value: str) -> str:
        """
        Convert OCR text into the canonical EXAM-XXXX-XXXX shape when present.
        """
        upper = str(value or "").upper()
        if not upper:
            return ""

        exact = re.search(r"EXAM[-\s:_]*([A-Z0-9]{4})[-\s:_]*([A-Z0-9]{4})", upper)
        if exact:
            tail = f"{exact.group(1)}{exact.group(2)}"
            if re.search(r"\d", tail):
                return f"EXAM-{exact.group(1)}-{exact.group(2)}"

        compact = re.sub(r"[^A-Z0-9]", "", upper)
        prefixed = re.search(r"EXAM([A-Z0-9]{4})([A-Z0-9]{4})", compact)
        if prefixed:
            tail = f"{prefixed.group(1)}{prefixed.group(2)}"
            if re.search(r"\d", tail):
                return f"EXAM-{prefixed.group(1)}-{prefixed.group(2)}"

        return ""

    @staticmethod
    def _is_object_id_candidate(value: str) -> bool:
        """Return True when the token looks like a MongoDB ObjectId."""
        return bool(re.fullmatch(r"[A-F0-9]{24}", str(value or "").upper()))

    def _collect_exam_code_candidates_from_text(
        self,
        raw_text: str,
        detected_roll: str = "",
    ) -> List[str]:
        """
        Build a ranked list of plausible exam-code candidates from OCR text.
        Keeps conservative filters to avoid generic header/instruction words.
        """
        upper = re.sub(r"[^A-Za-z0-9 ]+", " ", str(raw_text or "")).upper()
        upper = re.sub(r"\s+", " ", upper).strip()
        if not upper:
            return []

        compact = upper.replace(" ", "")
        raw_candidates: List[str] = []

        strict_candidates: List[str] = []
        for match in re.finditer(r"EXAM[-\s:_]*([A-Z0-9]{4})[-\s:_]*([A-Z0-9]{4})", upper):
            tail = f"{match.group(1)}{match.group(2)}"
            if re.search(r"\d", tail):
                strict_candidates.append(f"EXAM-{match.group(1)}-{match.group(2)}")

        for match in re.finditer(r"EXAM([A-Z0-9]{4})([A-Z0-9]{4})", compact):
            tail = f"{match.group(1)}{match.group(2)}"
            if re.search(r"\d", tail):
                strict_candidates.append(f"EXAM-{match.group(1)}-{match.group(2)}")

        raw_candidates.extend(
            match.group(0).upper()
            for match in re.finditer(r"\b[a-fA-F0-9]{24}\b", str(raw_text or ""))
        )

        prefixed = re.search(r"(?:EXAMCODE|EXAMID|CODE)(EXAM[A-Z0-9]{8}|[A-Z0-9]{4,32})", compact)
        if prefixed:
            raw_candidates.append(prefixed.group(1))

        exam_tail = re.search(r"EXAM\s*CODE\s*(.+)$", upper)
        if exam_tail:
            strict_tail = self._format_strict_exam_code_candidate(exam_tail.group(1))
            if strict_tail:
                strict_candidates.append(strict_tail)
            tail = re.sub(r"[^A-Z0-9]", "", exam_tail.group(1))
            if tail:
                raw_candidates.append(tail)

        raw_candidates.extend(strict_candidates)
        raw_candidates.extend(re.findall(r"[A-Z0-9]{4,32}", compact))
        raw_candidates.extend(re.findall(r"[A-Z0-9]{4,24}", upper))

        expanded: List[str] = []
        for token in raw_candidates:
            if not token:
                continue
            token_compact = re.sub(r"[^A-Z0-9]", "", token.upper())
            expanded.append(token)
            if self._format_strict_exam_code_candidate(token) or self._is_object_id_candidate(token_compact):
                continue
            if len(token) > 8:
                max_len = min(12, len(token))
                for length in range(4, max_len + 1):
                    expanded.append(token[:length])
                    expanded.append(token[-length:])

        scored: Dict[str, float] = {}
        for token in expanded:
            candidate = self._sanitize_exam_code_candidate(token, detected_roll=detected_roll)
            if not candidate:
                continue

            compact_candidate = re.sub(r"[^A-Z0-9]", "", candidate)
            alpha_count = len(re.findall(r"[A-Z]", compact_candidate))
            digit_count = len(re.findall(r"\d", compact_candidate))
            is_strict = bool(re.fullmatch(r"EXAM-[A-Z0-9]{4}-[A-Z0-9]{4}", candidate))
            is_prefixed = compact_candidate.startswith("EXAM") and len(compact_candidate) == 12

            # Conservative acceptance: mixed alnum, numeric (5-8), or EXAM-prefixed token.
            if is_strict:
                score = 4.2
            elif is_prefixed:
                score = 3.4
            elif alpha_count and digit_count:
                score = 2.8
            elif digit_count and not alpha_count:
                score = 1.9
            elif compact_candidate.startswith("EXAM") and len(compact_candidate) >= 6:
                score = 1.8
            else:
                continue

            score += min(1.0, len(compact_candidate) / 20.0)
            if compact_candidate.startswith("EXAM"):
                score += 0.4
            if re.search(r"\d", compact_candidate):
                score += 0.25
            if is_strict:
                score += 0.3

            previous = scored.get(candidate)
            if previous is None or score > previous:
                scored[candidate] = score

        ordered = sorted(scored.items(), key=lambda item: (item[1], len(item[0])), reverse=True)
        return [candidate for candidate, _score in ordered]

    def _sanitize_exam_code_candidate(
        self,
        value: str,
        detected_roll: str = "",
    ) -> str:
        """
        Keep only plausible exam-code tokens and block roll-number-like values.
        """
        candidate_raw = re.sub(r"[^A-Za-z0-9-]", "", str(value or "")).upper()
        candidate = self._format_strict_exam_code_candidate(candidate_raw) or candidate_raw
        compact_candidate = re.sub(r"[^A-Z0-9]", "", candidate)
        if not compact_candidate:
            return ""

        if self._is_object_id_candidate(compact_candidate):
            return compact_candidate

        if len(compact_candidate) < self.exam_code_min_len or len(compact_candidate) > self.exam_code_max_len:
            return ""

        roll_digits = re.sub(r"\D", "", str(detected_roll or ""))
        if roll_digits and compact_candidate == roll_digits:
            return ""

        if compact_candidate.isdigit():
            if len(compact_candidate) >= self.roll_number_like_min_len:
                return ""
            if len(compact_candidate) < self.exam_code_numeric_min_len:
                return ""
            if len(compact_candidate) > self.exam_code_numeric_max_len:
                return ""
        elif (
            re.search(r"[A-Z]", compact_candidate)
            and re.search(r"\d", compact_candidate)
            and not compact_candidate.startswith("EXAM")
            and len(compact_candidate) < 8
        ):
            return ""

        return candidate

    @staticmethod
    def _extract_exam_code_from_filename(image_path: str) -> str:
        """Best-effort exam-code fallback from filename."""
        filename = os.path.basename(image_path)
        base, _ = os.path.splitext(filename)
        explicit = re.search(r"(?:exam(?:code|id)?)\s*[-_ ]*([A-Za-z0-9-]{4,})", base, re.IGNORECASE)
        if not explicit:
            return ""
        token = re.sub(r"[^A-Za-z0-9]", "", explicit.group(1)).upper()
        return token if len(token) >= 4 else ""

    @staticmethod
    def _crop_relative_roi(
        gray: np.ndarray,
        roi_rel: Tuple[float, float, float, float],
    ) -> np.ndarray:
        """Crop a relative ROI from a grayscale warped sheet."""
        if gray is None or gray.size == 0:
            return np.zeros((0, 0), dtype=np.uint8)

        h, w = gray.shape
        x1_rel, y1_rel, x2_rel, y2_rel = roi_rel
        x0 = max(0, min(w - 1, int(round(w * x1_rel))))
        y0 = max(0, min(h - 1, int(round(h * y1_rel))))
        x1 = max(x0 + 1, min(w, int(round(w * x2_rel))))
        y1 = max(y0 + 1, min(h, int(round(h * y2_rel))))
        return gray[y0:y1, x0:x1]

    def _run_tesseract_on_exam_roi(
        self,
        gray: np.ndarray,
        roi_rel: Tuple[float, float, float, float],
    ) -> List[Tuple[str, int, str, float]]:
        """
        OCR the exam-code header using Tesseract.
        Returns (variant_name, psm, raw_text, quality_estimate).
        """
        if pytesseract is None or not self._tesseract_cmd:
            return []

        roi = self._crop_relative_roi(gray, roi_rel)
        if roi.size == 0:
            return []

        scaled = cv2.resize(roi, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        threshold_value = max(110, min(190, int(np.mean(scaled) * 0.9)))
        variants = [
            ("gray", scaled),
            ("th", cv2.threshold(scaled, threshold_value, 255, cv2.THRESH_BINARY)[1]),
            ("otsu", cv2.threshold(scaled, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]),
        ]

        results: List[Tuple[str, int, str, float]] = []
        seen = set()
        for variant_name, variant in variants:
            for psm in (6, 7):
                config = f"--psm {psm} -c preserve_interword_spaces=1"
                try:
                    raw_text = pytesseract.image_to_string(
                        variant,
                        lang="eng",
                        config=config,
                    )
                except Exception:
                    continue

                normalized = re.sub(r"\s+", " ", str(raw_text or "")).strip()
                if not normalized:
                    continue

                key = (normalized, psm)
                if key in seen:
                    continue
                seen.add(key)

                compact = re.sub(r"[^A-Z0-9]", "", normalized.upper())
                quality = min(1.8, len(compact) / 12.0)
                if "EXAM" in compact:
                    quality += 0.55
                if "CODE" in compact:
                    quality += 0.35
                if re.search(r"[A-Z]", compact) and re.search(r"\d", compact):
                    quality += 0.20

                results.append((variant_name, psm, normalized, float(quality)))

        return results

    def _score_exam_code_candidate(
        self,
        candidate: str,
        raw_text: str,
        quality: float,
        base_index: int,
        rank: int,
        engine: str,
    ) -> float:
        """Rank one OCR candidate while preferring canonical exam-code outputs."""
        compact_raw = re.sub(r"[^A-Z0-9]", "", raw_text.upper())
        compact_candidate = re.sub(r"[^A-Z0-9]", "", candidate)
        candidate_length = len(compact_candidate)
        is_strict = bool(re.fullmatch(r"EXAM-[A-Z0-9]{4}-[A-Z0-9]{4}", candidate))
        is_object_id = bool(re.fullmatch(r"[A-F0-9]{24}", compact_candidate))
        label_hint = "EXAM" in compact_raw or "CODE" in compact_raw

        candidate_quality = quality + min(0.45, len(candidate) / 18.0)
        if re.search(r"[A-Z]", candidate) and re.search(r"\d", candidate):
            candidate_quality += 0.35
        elif candidate.isdigit():
            candidate_quality += 0.22
        if compact_candidate.startswith("EXAM"):
            candidate_quality += 0.18
        if is_strict:
            candidate_quality += 0.90
        if is_object_id:
            candidate_quality += 0.80
        if label_hint:
            candidate_quality += 0.20
        if base_index <= 2:
            candidate_quality += 0.05
        if engine == "tesseract":
            candidate_quality += 1.10
        if not is_strict and not is_object_id and not compact_candidate.startswith("EXAM") and not label_hint:
            candidate_quality -= 0.80
        if candidate_length > 12 and not is_object_id:
            candidate_quality -= min(0.90, (candidate_length - 12) * 0.12)
        candidate_quality -= min(0.20, rank * 0.04)
        return float(candidate_quality)

    def _extract_exam_code_from_sheet(
        self,
        sheet_image: np.ndarray,
        detected_roll: str = "",
    ) -> str:
        """Template-based OCR for exam-code text printed in the sheet header."""
        if sheet_image is None or sheet_image.size == 0:
            return ""

        gray = (
            cv2.cvtColor(sheet_image, cv2.COLOR_BGR2GRAY)
            if len(sheet_image.shape) == 3
            else sheet_image.copy()
        )

        # Small ROI perturbation improves robustness for slight skew/crop offsets.
        roi_shifts = [
            (0.0, 0.0, 1.0, 1.0),
            (-0.003, 0.0, 1.01, 1.0),
            (0.003, 0.0, 1.01, 1.0),
        ]

        best_code = ""
        best_quality = 0.0
        all_candidates: List[str] = []
        debug_entries: List[Dict[str, object]] = []

        # Primary OCR path for exam code: use Tesseract on the top header strip.
        for base_index, roi_rel in enumerate(self.exam_code_tesseract_rois_rel):
            tesseract_results = self._run_tesseract_on_exam_roi(gray, roi_rel)
            for variant_name, psm, raw_text, quality in tesseract_results:
                normalized_primary = self._sanitize_exam_code_candidate(
                    self._format_strict_exam_code_candidate(raw_text) or self._normalize_exam_code_text(raw_text),
                    detected_roll=detected_roll,
                )
                candidates = self._collect_exam_code_candidates_from_text(
                    raw_text,
                    detected_roll=detected_roll,
                )

                if normalized_primary and normalized_primary not in candidates:
                    candidates.insert(0, normalized_primary)

                if candidates:
                    all_candidates.extend(candidates)

                for rank, candidate in enumerate(candidates):
                    candidate_quality = self._score_exam_code_candidate(
                        candidate=candidate,
                        raw_text=raw_text,
                        quality=quality,
                        base_index=base_index,
                        rank=rank,
                        engine="tesseract",
                    )
                    if candidate_quality > best_quality:
                        best_quality = candidate_quality
                        best_code = candidate

                debug_entries.append(
                    {
                        "engine": "tesseract",
                        "roi": [round(float(v), 5) for v in roi_rel],
                        "variant": variant_name,
                        "psm": int(psm),
                        "quality": round(float(quality), 4),
                        "raw_text": raw_text[:160],
                        "candidates": candidates[:6],
                    }
                )

                strict_match = self._format_strict_exam_code_candidate(raw_text)
                object_id_candidate = next(
                    (
                        candidate
                        for candidate in candidates
                        if self._is_object_id_candidate(re.sub(r"[^A-Z0-9]", "", candidate))
                    ),
                    "",
                )
                if strict_match or object_id_candidate:
                    final_token = strict_match or object_id_candidate
                    final_code = self._sanitize_exam_code_candidate(final_token, detected_roll=detected_roll)
                    self._last_exam_code_debug = {
                        "selected": final_code,
                        "candidates": [final_code, *[candidate for candidate in all_candidates if candidate != final_code]][:12],
                        "entries": debug_entries[:20],
                    }
                    return final_code

        for base_index, base_roi in enumerate(self.exam_code_rois_rel):
            bx1, by1, bx2, by2 = base_roi
            for shift_x, shift_y, scale_x, scale_y in roi_shifts:
                cx = (bx1 + bx2) / 2.0 + shift_x
                cy = (by1 + by2) / 2.0 + shift_y
                half_w = ((bx2 - bx1) * scale_x) / 2.0
                half_h = ((by2 - by1) * scale_y) / 2.0
                roi_rel = (
                    max(bx1, cx - half_w),
                    max(by1, cy - half_h),
                    min(bx2, cx + half_w),
                    min(by2, cy + half_h),
                )
                if roi_rel[2] - roi_rel[0] <= 0.02 or roi_rel[3] - roi_rel[1] <= 0.01:
                    continue

                raw_text, quality = self._extract_text_from_roi_using_templates(gray, roi_rel, min_score=0.08)
                normalized_primary = self._sanitize_exam_code_candidate(
                    self._format_strict_exam_code_candidate(raw_text) or self._normalize_exam_code_text(raw_text),
                    detected_roll=detected_roll,
                )
                candidates = self._collect_exam_code_candidates_from_text(
                    raw_text,
                    detected_roll=detected_roll,
                )

                if normalized_primary and normalized_primary not in candidates:
                    candidates.insert(0, normalized_primary)

                if candidates:
                    all_candidates.extend(candidates)

                for rank, candidate in enumerate(candidates):
                    candidate_quality = self._score_exam_code_candidate(
                        candidate=candidate,
                        raw_text=raw_text,
                        quality=quality,
                        base_index=base_index,
                        rank=rank,
                        engine="template",
                    )
                    if candidate_quality > best_quality:
                        best_quality = candidate_quality
                        best_code = candidate

                if raw_text:
                    debug_entries.append(
                        {
                            "engine": "template",
                            "roi": [round(float(v), 5) for v in roi_rel],
                            "quality": round(float(quality), 4),
                            "raw_text": raw_text[:120],
                            "candidates": candidates[:6],
                        }
                    )

        # De-duplicate candidates while preserving ranking order.
        seen_candidates = set()
        ranked_candidates: List[str] = []
        for candidate in all_candidates:
            if candidate in seen_candidates:
                continue
            seen_candidates.add(candidate)
            ranked_candidates.append(candidate)

        final_code = self._sanitize_exam_code_candidate(best_code, detected_roll=detected_roll)
        self._last_exam_code_debug = {
            "selected": final_code,
            "candidates": ranked_candidates[:12],
            "entries": debug_entries[:20],
        }
        return final_code

    @staticmethod
    def _normalize_candidate_name_text(value: str) -> str:
        """
        Keep only plausible candidate-name text and reject generic placeholders.
        """
        cleaned = re.sub(r"[^A-Za-z0-9 ]+", " ", str(value or ""))
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if len(cleaned) < 2:
            return ""

        # Improve readability for mixed alnum tokens (e.g. "Student1ABC" -> "Student 1 ABC").
        cleaned = re.sub(r"(?<=[A-Za-z])(?=[0-9])", " ", cleaned)
        cleaned = re.sub(r"(?<=[0-9])(?=[A-Za-z])", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()

        if not re.search(r"[A-Za-z]", cleaned):
            return ""

        tokens = cleaned.split()
        if not tokens:
            return ""
        if not re.search(r"[A-Za-z]", tokens[0]):
            return ""
        if re.fullmatch(r"[A-Za-z]?udent", tokens[0], flags=re.IGNORECASE):
            tokens[0] = "Student"
            cleaned = " ".join(tokens)

        upper = cleaned.upper()
        blocked_substrings = [
            "CHATGPT",
            "WHATSAPP",
            "GENERATED",
            "OMR",
            "SHEET",
            "IMAGE",
            "ROLL NO",
            "ROLL NUMBER",
            "CANDIDATE ROLL",
            "NOT MATCHED",
        ]
        if any(token in upper for token in blocked_substrings):
            return ""

        blocked_exact = {
            "CANDIDATE",
            "ROLL",
            "ROLLNO",
            "ROLLNUMBER",
            "NAME",
            "UNKNOWN",
            "NA",
            "N A",
        }
        if re.sub(r"[^A-Z]", "", upper) in blocked_exact:
            return ""

        alpha_count = len(re.findall(r"[A-Za-z]", cleaned))
        if len(tokens) == 1 and alpha_count < 4:
            return ""

        words = cleaned.split(" ")
        normalized_words: List[str] = []
        for word in words:
            if not word:
                continue
            if len(word) <= 3 and word.isupper():
                normalized_words.append(word)
            elif word.isupper():
                normalized_words.append(word.title())
            else:
                normalized_words.append(word)

        normalized = " ".join(normalized_words).strip()
        return normalized[:64]

    def _extract_candidate_name_from_sheet(self, sheet_image: np.ndarray) -> str:
        """Template-based OCR for candidate-name field on generated OMR sheets."""
        if sheet_image is None or sheet_image.size == 0:
            return ""

        gray = (
            cv2.cvtColor(sheet_image, cv2.COLOR_BGR2GRAY)
            if len(sheet_image.shape) == 3
            else sheet_image.copy()
        )

        h, w = gray.shape
        x1_rel, y1_rel, x2_rel, y2_rel = self.candidate_name_rel
        x0 = max(0, min(w - 1, int(round(w * x1_rel))))
        y0 = max(0, min(h - 1, int(round(h * y1_rel))))
        x1 = max(x0 + 1, min(w, int(round(w * x2_rel))))
        y1 = max(y0 + 1, min(h, int(round(h * y2_rel))))

        roi = gray[y0:y1, x0:x1]
        if roi.size == 0:
            return ""

        # Remove box borders so OCR sees only text.
        margin_x = max(2, int(roi.shape[1] * 0.008))
        margin_y = max(2, int(roi.shape[0] * 0.12))
        if roi.shape[1] <= margin_x * 2 or roi.shape[0] <= margin_y * 2:
            return ""

        text_roi = roi[margin_y : roi.shape[0] - margin_y, margin_x : roi.shape[1] - margin_x]
        if text_roi.size == 0:
            return ""

        text_blur = cv2.GaussianBlur(text_roi, (3, 3), 0)
        adaptive_main = cv2.adaptiveThreshold(
            text_blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            31,
            8,
        )
        adaptive_soft = cv2.adaptiveThreshold(
            text_blur,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            31,
            6,
        )
        _, otsu_bin = cv2.threshold(
            text_blur,
            0,
            255,
            cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
        )

        variants = [adaptive_main, adaptive_soft, otsu_bin]
        best_name = ""
        best_quality = -1.0

        for text_bin in variants:
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
            text_bin = cv2.morphologyEx(text_bin, cv2.MORPH_OPEN, kernel, iterations=1)
            text_bin = cv2.morphologyEx(text_bin, cv2.MORPH_CLOSE, kernel, iterations=1)

            num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(text_bin, connectivity=8)
            components: List[Tuple[int, int, int, int, np.ndarray]] = []
            for idx in range(1, num_labels):
                x = int(stats[idx, cv2.CC_STAT_LEFT])
                y = int(stats[idx, cv2.CC_STAT_TOP])
                bw = int(stats[idx, cv2.CC_STAT_WIDTH])
                bh = int(stats[idx, cv2.CC_STAT_HEIGHT])
                area = int(stats[idx, cv2.CC_STAT_AREA])

                if area < 10:
                    continue
                if bw < 2 or bh < 6:
                    continue
                if bh > int(text_bin.shape[0] * 0.95):
                    continue

                glyph = text_bin[y : y + bh, x : x + bw]
                components.append((x, y, bw, bh, glyph))

            if not components:
                continue

            components.sort(key=lambda item: item[0])
            gaps: List[float] = []
            for idx in range(1, len(components)):
                prev = components[idx - 1]
                curr = components[idx]
                gaps.append(float(curr[0] - (prev[0] + prev[2])))

            median_width = float(np.median([component[2] for component in components]))
            if gaps:
                median_gap = float(np.median(gaps))
                std_gap = float(np.std(gaps))
                space_gap = max(6.0, median_gap + max(2.5, std_gap * 1.4))
            else:
                space_gap = max(6.0, median_width * 1.0)

            chars: List[str] = []
            scores: List[float] = []
            prev_right: Optional[int] = None
            for x, _y, bw, _bh, glyph in components:
                if prev_right is not None and float(x - prev_right) > space_gap:
                    chars.append(" ")

                ch, score = self._classify_glyph(glyph)
                if ch and score >= 0.16:
                    chars.append(ch)
                    scores.append(score)
                prev_right = x + bw

            if not chars:
                continue

            raw_text = "".join(chars)
            normalized = self._normalize_candidate_name_text(raw_text)
            if not normalized:
                continue

            alpha_count = len(re.findall(r"[A-Za-z]", normalized))
            avg_score = float(np.mean(scores)) if scores else 0.0
            has_space_bonus = 0.15 if " " in normalized else 0.0
            quality = avg_score + min(1.0, alpha_count / 10.0) + has_space_bonus

            if quality > best_quality:
                best_quality = quality
                best_name = normalized

        return best_name

    @staticmethod
    def _extract_candidate_name_from_filename(image_path: str) -> str:
        """Best-effort candidate-name fallback from filename tokens."""
        filename = os.path.basename(image_path)
        base, _ = os.path.splitext(filename)

        # Remove common upload prefixes: "<timestamp>-<random>-..."
        base = re.sub(r"^\d{8,}-\d+-", "", base)
        cleaned = re.sub(r"[_\-]+", " ", base).strip()
        cleaned = re.sub(r"[^a-zA-Z ]+", " ", cleaned).strip()
        if not cleaned:
            return ""

        stop_words = {
            "chatgpt",
            "image",
            "generated",
            "sheet",
            "omr",
            "filled",
            "scan",
            "whatsapp",
            "photo",
            "img",
            "test",
            "tmp",
            "chart",
            "png",
            "jpg",
            "jpeg",
            "single",
            "generated",
            "filled",
        }
        tokens = [token for token in re.split(r"\s+", cleaned) if token]
        filtered: List[str] = []
        for token in tokens:
            # Keep alpha part from mixed tokens like "Student1" instead of dropping them.
            alpha_token = re.sub(r"\d+", "", token).strip()
            if not alpha_token:
                continue
            if alpha_token.lower() in stop_words:
                continue
            if len(alpha_token) < 2:
                continue
            filtered.append(alpha_token)

        if len(filtered) < 2:
            return ""

        return " ".join(filtered[:4]).title()

    def _extract_identity_fields(
        self,
        image_path: str,
        binary: np.ndarray,
        sheet_image: Optional[np.ndarray] = None,
    ) -> Tuple[str, str, str, str]:
        """Extract roll number, candidate name, and exam code with conservative fallbacks."""
        roll_number, roll_status = self._extract_roll_from_bubble_grid(binary)
        if not roll_number:
            roll_number = self._extract_roll_from_filename(image_path)
            if roll_number and roll_status != "INVALID":
                roll_status = "OK"

        candidate_name = (
            self._extract_candidate_name_from_sheet(sheet_image)
            if sheet_image is not None
            else ""
        )
        exam_code = (
            self._extract_exam_code_from_sheet(
                sheet_image,
                detected_roll=roll_number,
            )
            if sheet_image is not None
            else ""
        )
        exam_code = self._sanitize_exam_code_candidate(exam_code, detected_roll=roll_number)
        return roll_number, roll_status, candidate_name, exam_code

    @staticmethod
    def _is_pdf_path(file_path: str) -> bool:
        return os.path.splitext(str(file_path))[1].lower() == ".pdf"

    @staticmethod
    def _render_pdf_pages(pdf_path: str, dpi: int = 300, max_pages: int = 100) -> List[np.ndarray]:
        """Render each PDF page into a BGR image for OpenCV processing."""
        if fitz is None:
            raise RuntimeError("PDF support requires PyMuPDF (fitz).")

        document = fitz.open(pdf_path)
        try:
            if document.page_count <= 0:
                raise ValueError("PDF has no pages.")

            page_count = min(document.page_count, max_pages)
            zoom = max(1.0, float(dpi) / 72.0)
            matrix = fitz.Matrix(zoom, zoom)

            pages: List[np.ndarray] = []
            for page_index in range(page_count):
                page = document.load_page(page_index)
                pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                channels = int(pixmap.n)
                if channels not in (3, 4):
                    continue

                buffer = np.frombuffer(pixmap.samples, dtype=np.uint8)
                image = buffer.reshape(pixmap.height, pixmap.width, channels)
                if channels == 4:
                    bgr = cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
                else:
                    bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
                pages.append(bgr)

            if not pages:
                raise ValueError("Could not render PDF pages into images.")
            return pages
        finally:
            document.close()

    @staticmethod
    def _identity_payload_rank(payload: Dict[str, object]) -> Tuple[int, int]:
        """Ranking helper for selecting the strongest identity result from PDF pages."""
        status_rank = {"OK": 3, "INCOMPLETE": 2, "INVALID": 1}
        status = str(payload.get("roll_status") or "").upper()
        roll = str(payload.get("roll_number") or "").strip()
        return status_rank.get(status, 0), len(roll)

    def _extract_identity_from_image(
        self,
        image: np.ndarray,
        source_name: str,
    ) -> Dict[str, object]:
        """Identity extraction on a loaded image matrix."""
        warped = self._perspective_correct(image)
        _gray, _blurred, binary = self._preprocess_for_bubbles(warped)
        bubbles, contour_scale, _groups = self._detect_bubbles_with_scale_search(
            binary,
            expected_questions=None,
        )

        deskew_angle = self._estimate_deskew_angle(bubbles) if bubbles else 0.0
        roll_number, roll_status, candidate_name, exam_code = self._extract_identity_fields(
            image_path=source_name,
            binary=binary,
            sheet_image=warped,
        )

        status_rank = {"OK": 3, "INCOMPLETE": 2, "INVALID": 1}
        chosen_binary = binary
        deskew_applied = False

        if abs(deskew_angle) >= 2.0:
            rotated = self._rotate_image(warped, deskew_angle)
            _gray_rot, _blurred_rot, binary_rot = self._preprocess_for_bubbles(rotated)
            roll_rot, status_rot, candidate_name_rot, exam_code_rot = self._extract_identity_fields(
                image_path=source_name,
                binary=binary_rot,
                sheet_image=rotated,
            )

            current_rank = status_rank.get(roll_status, 0)
            rotated_rank = status_rank.get(status_rot, 0)
            current_len = len(roll_number or "")
            rotated_len = len(roll_rot or "")

            if rotated_rank > current_rank or (rotated_rank == current_rank and rotated_len > current_len):
                chosen_binary = binary_rot
                roll_number = roll_rot
                roll_status = status_rot
                candidate_name = candidate_name_rot
                exam_code = exam_code_rot
                deskew_applied = True
            elif not exam_code and exam_code_rot:
                exam_code = exam_code_rot

        return {
            "roll_number": roll_number,
            "candidate_name": candidate_name,
            "exam_code": exam_code,
            "roll_status": roll_status,
            "meta": {
                "deskew_angle": round(float(deskew_angle), 3),
                "deskew_applied": deskew_applied,
                "contour_scale": contour_scale,
                "binary_shape": [int(chosen_binary.shape[0]), int(chosen_binary.shape[1])],
                "detected_bubbles": int(len(bubbles)),
                "exam_code_candidates": list(self._last_exam_code_debug.get("candidates", [])),
                "exam_code_debug": self._last_exam_code_debug,
            },
        }

    def extract_identity(self, image_path: str) -> Dict[str, object]:
        """
        Lightweight identity extraction without answer evaluation.
        Intended for /omr/extract-id endpoint usage.
        """
        if self._is_pdf_path(image_path):
            pages = self._render_pdf_pages(image_path)
            best: Optional[Dict[str, object]] = None
            best_rank: Tuple[int, int] = (-1, -1)

            for page_index, page_image in enumerate(pages):
                page_result = self._extract_identity_from_image(page_image, image_path)
                page_result.setdefault("meta", {})
                page_result["meta"]["page_index"] = int(page_index)
                page_result["meta"]["page_number"] = int(page_index + 1)
                rank = self._identity_payload_rank(page_result)
                if rank > best_rank:
                    best = page_result
                    best_rank = rank

            if best is None:
                raise ValueError("Could not extract identity from PDF pages.")
            return best

        image = cv2.imread(image_path)
        if image is None:
            raise ValueError(f"Failed to load image: {image_path}")
        return self._extract_identity_from_image(image, image_path)

    def _scan_image(
        self,
        image: np.ndarray,
        source_name: str,
        expected_questions: Optional[int] = None,
        page_index: int = 0,
    ) -> Dict[str, object]:
        """Full OMR pipeline execution for one loaded image."""
        # Perspective correction for tilted/rotated sheets.
        warped = self._perspective_correct(image)
        identity_sheet_image = warped

        # Preprocess and detect bubble contours.
        gray_for_fill, _blurred, binary = self._preprocess_for_bubbles(warped)
        bubbles, contour_scale, question_groups = self._detect_bubbles_with_scale_search(
            binary,
            expected_questions=expected_questions,
        )

        if len(bubbles) < self.options_per_question:
            raise ValueError("Could not detect enough bubble contours on the sheet")

        deskew_angle = self._estimate_deskew_angle(bubbles)
        deskew_applied = False
        if abs(deskew_angle) >= 2.0:
            rotated = self._rotate_image(warped, deskew_angle)
            gray_rot, _blurred_rot, binary_rot = self._preprocess_for_bubbles(rotated)
            bubbles_rot, contour_scale_rot, question_groups_rot = self._detect_bubbles_with_scale_search(
                binary_rot,
                expected_questions=expected_questions,
            )

            # Keep deskewed result only if grouping improved.
            if len(question_groups_rot) > len(question_groups):
                gray_for_fill = gray_rot
                binary = binary_rot
                bubbles = bubbles_rot
                contour_scale = contour_scale_rot
                question_groups = question_groups_rot
                identity_sheet_image = rotated
                deskew_applied = True

        if not question_groups:
            raise ValueError("Could not group detected bubbles into 4-option questions")

        if expected_questions is not None and expected_questions > 0:
            question_groups = self._select_question_window(question_groups, expected_questions)

        answers_list: List[Dict[str, object]] = []
        answers_detected: Dict[str, Optional[str]] = {}
        invalid_questions: List[int] = []

        for question_idx, group in enumerate(question_groups, start=1):
            fill_scores = [self._compute_fill_ratio(binary, gray_for_fill, bubble) for bubble in group]
            marked = self._decide_mark(fill_scores)

            answers_list.append({"question": question_idx, "marked": marked})

            if marked == "SKIPPED":
                answers_detected[str(question_idx)] = None
            elif marked == "INVALID":
                answers_detected[str(question_idx)] = "MULTIPLE"
                invalid_questions.append(question_idx)
            else:
                answers_detected[str(question_idx)] = marked

        # Pad with SKIPPED if the caller expects more questions than detected groups.
        if expected_questions is not None and expected_questions > len(answers_list):
            for question_idx in range(len(answers_list) + 1, expected_questions + 1):
                answers_list.append({"question": question_idx, "marked": "SKIPPED"})
                answers_detected[str(question_idx)] = None

        roll_number, roll_status, candidate_name, exam_code = self._extract_identity_fields(
            image_path=source_name,
            binary=binary,
            sheet_image=identity_sheet_image,
        )

        return {
            # Requested answer format.
            "answers": answers_list,
            # Backward-compatible fields used by current Node route.
            "roll_number": roll_number,
            "candidate_name": candidate_name,
            "exam_code": exam_code,
            "answers_detected": answers_detected,
            "score": 0,
            "total": len(answers_list),
            "invalid_questions": invalid_questions,
            "page_index": int(page_index),
            "meta": {
                "detected_bubbles": len(bubbles),
                "detected_questions": len(question_groups),
                "fill_threshold": self.fill_threshold,
                "similarity_threshold": self.similarity_threshold,
                "deskew_angle": round(deskew_angle, 3),
                "deskew_applied": deskew_applied,
                "contour_scale": contour_scale,
                "roll_status": roll_status,
                "page_index": int(page_index),
                "page_number": int(page_index + 1),
                "exam_code_candidates": list(self._last_exam_code_debug.get("candidates", [])),
                "exam_code_debug": self._last_exam_code_debug,
            },
        }

    def scan(self, image_path: str, expected_questions: Optional[int] = None) -> Dict[str, object]:
        """Full OMR pipeline execution for one image or multi-page PDF."""
        if self._is_pdf_path(image_path):
            pages = self._render_pdf_pages(image_path)
            page_results: List[Dict[str, object]] = []

            for page_index, page_image in enumerate(pages):
                try:
                    page_results.append(
                        self._scan_image(
                            image=page_image,
                            source_name=image_path,
                            expected_questions=expected_questions,
                            page_index=page_index,
                        )
                    )
                except Exception as page_error:
                    # Keep processing the remaining pages. Caller can mark failed pages for review.
                    page_results.append(
                        {
                            "answers": [],
                            "roll_number": "",
                            "candidate_name": "",
                            "exam_code": "",
                            "answers_detected": {},
                            "score": 0,
                            "total": 0,
                            "invalid_questions": [],
                            "status": "ERROR",
                            "error": str(page_error),
                            "page_index": int(page_index),
                            "meta": {
                                "roll_status": "INCOMPLETE",
                                "page_index": int(page_index),
                                "page_number": int(page_index + 1),
                            },
                        }
                    )

            return {
                "results": page_results,
                "count": len(page_results),
                "source_type": "pdf",
            }

        image = cv2.imread(image_path)
        if image is None:
            raise ValueError(f"Failed to load image: {image_path}")
        return self._scan_image(image=image, source_name=image_path, expected_questions=expected_questions)


def _parse_optional_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def main() -> None:
    """
    CLI:
      python omr.py <image_path> [expected_questions] [--id-only]
    """
    try:
        if len(sys.argv) < 2:
            raise ValueError("No image path provided")

        args = sys.argv[1:]
        image_path = args[0]
        id_only = "--id-only" in args[1:]

        expected_questions: Optional[int] = None
        for arg in args[1:]:
            if arg.startswith("--"):
                continue
            expected_questions = _parse_optional_int(arg)
            break

        scanner = OMRScanner()
        if id_only:
            result = scanner.extract_identity(image_path=image_path)
        else:
            result = scanner.scan(image_path=image_path, expected_questions=expected_questions)

        print(json.dumps(result))
        sys.exit(0)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "error": str(exc),
                    "trace": traceback.format_exc(),
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
