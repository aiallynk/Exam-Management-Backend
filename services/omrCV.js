/**
 * services/omrCV.js — v8.0 HIGH ACCURACY (OpenCV-Style Pure JS)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import Jimp from 'jimp';
import path from 'path';
import fs from 'fs/promises';

/**
 * OTSU Thresholding Implementation
 */
function getOtsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let sumB = 0;
    let wB = 0;
    let varMax = 0;
    let threshold = 0;

    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;

        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;

        const varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > varMax) {
            varMax = varBetween;
            threshold = t;
        }
    }
    return threshold;
}

/**
 * Perspective Transform Matrix Calculation
 */
function getPerspectiveTransform(src, dst) {
    const A = [];
    const B = [];
    for (let i = 0; i < 4; i++) {
        A.push([src[i].x, src[i].y, 1, 0, 0, 0, -src[i].x * dst[i].x, -src[i].y * dst[i].x]);
        B.push(dst[i].x);
        A.push([0, 0, 0, src[i].x, src[i].y, 1, -src[i].x * dst[i].y, -src[i].y * dst[i].y]);
        B.push(dst[i].y);
    }

    // Solve linear system (Gaussian elimination)
    const n = 8;
    for (let i = 0; i < n; i++) {
        let max = i;
        for (let j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[max][i])) max = j;
        [A[i], A[max]] = [A[max], A[i]];
        [B[i], B[max]] = [B[max], B[i]];
        for (let j = i + 1; j < n; j++) {
            const factor = A[j][i] / A[i][i];
            B[j] -= factor * B[i];
            for (let k = i; k < n; k++) A[j][k] -= factor * A[i][k];
        }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = 0;
        for (let j = i + 1; j < n; j++) s += A[i][j] * x[j];
        x[i] = (B[i] - s) / A[i][i];
    }
    return { a: x[0], b: x[1], c: x[2], d: x[3], e: x[4], f: x[5], g: x[6], h: x[7] };
}

/**
 * Apply Perspective Warp
 */
function warpPerspective(srcImg, width, height, matrix, tw, th) {
    const out = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
            const denom = matrix.g * x + matrix.h * y + 1;
            const sx = (matrix.a * x + matrix.b * y + matrix.c) / denom;
            const sy = (matrix.d * x + matrix.e * y + matrix.f) / denom;

            if (sx >= 0 && sx < width - 1 && sy >= 0 && sy < height - 1) {
                const x0 = Math.floor(sx), x1 = x0 + 1;
                const y0 = Math.floor(sy), y1 = y0 + 1;
                const dx = sx - x0, dy = sy - y0;

                // Bilinear interpolation
                const p00 = srcImg[y0 * width + x0];
                const p10 = srcImg[y0 * width + x1];
                const p01 = srcImg[y1 * width + x0];
                const p11 = srcImg[y1 * width + x1];

                out[y * tw + x] = (1 - dx) * (1 - dy) * p00 + dx * (1 - dy) * p10 + (1 - dx) * dy * p01 + dx * dy * p11;
            } else {
                out[y * tw + x] = 255; // White background
            }
        }
    }
    return out;
}

/**
 * Main Detection Function
 */
export async function detectOMRAnswers({ fileBuffer, totalQuestions, optionsPerQuestion = 4 }) {
    const LETTERS = 'ABCDEFGH'.slice(0, optionsPerQuestion).split('');
    let img;
    try {
        img = await Jimp.read(fileBuffer);
    } catch (e) {
        console.error('[OMR] Image read error:', e);
        return null;
    }

    img.greyscale();
    const width = img.bitmap.width;
    const height = img.bitmap.height;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = img.bitmap.data[i * 4];

    // STEP 1: Paper Area Detection (Corner Points)
    let tl = { x: width, y: height }, br = { x: 0, y: 0 }, tr = { x: 0, y: height }, bl = { x: width, y: 0 };
    let found = false;
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            if (gray[y * width + x] > 160) { // Look for white paper area
                found = true;
                if (x + y < tl.x + tl.y) { tl.x = x; tl.y = y; }
                if (x + y > br.x + br.y) { br.x = x; br.y = y; }
                if (x - y > tr.x - tr.y) { tr.x = x; tr.y = y; }
                if (x - y < bl.x - bl.y) { bl.x = x; bl.y = y; }
            }
        }
    }

    // Perspective Warp to fixed resolution: 2000x2800
    const tw = 2000;
    const th = 2800;
    const src = found ? [tl, tr, br, bl] : [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
    const dst = [{ x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th }];
    const matrix = getPerspectiveTransform(dst, src);
    const warped = warpPerspective(gray, width, height, matrix, tw, th);

    // STEP 4: OTSU Threshold (Binary Inverse)
    const otsuThresh = getOtsuThreshold(warped);
    const binary = new Uint8Array(tw * th);
    for (let i = 0; i < binary.length; i++) {
        binary[i] = warped[i] < otsuThresh ? 255 : 0; // Binary Inv: dark -> high
    }

    // STEP 5: Percentage-Based Coordinates
    const config = {
        startX: tw * 0.18,
        startY: th * 0.60,
        hg: tw * 0.055,
        vg: th * 0.018,
        bubbleSize: tw * 0.025
    };

    console.log(`[OMR] Otsu Threshold: ${otsuThresh}, StartY: ${Math.round(config.startY)}`);

    const radius = config.bubbleSize / 2;
    const maskRadius = radius * 0.70; // STEP 3: 70% Mask (Only detect center)
    const maskRSq = maskRadius * maskRadius;

    async function saveDebugROI(cx, cy, qIdx, cIdx) {
        try {
            const size = Math.ceil(radius * 2.5);
            const roi = new Jimp(size, size);
            const offset = size / 2;
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const px = Math.floor(cx - offset + x);
                    const py = Math.floor(cy - offset + y);
                    if (px >= 0 && px < tw && py >= 0 && py < th) {
                        const val = binary[py * tw + px];
                        roi.setPixelColor(Jimp.rgbaToInt(val, val, val, 255), x, y);
                    }
                }
            }
            // Draw crosshair for center verification
            for (let i = 0; i < size; i++) {
                roi.setPixelColor(Jimp.rgbaToInt(255, 0, 0, 255), Math.floor(offset), i);
                roi.setPixelColor(Jimp.rgbaToInt(255, 0, 0, 255), i, Math.floor(offset));
            }
            const debugPath = path.join(process.cwd(), 'uploads', 'omr', `debug_q${qIdx}_b${cIdx}.png`);
            await roi.writeAsync(debugPath);
        } catch (e) { /* ignore debug errors */ }
    }

    function getFillRatio(cx, cy) {
        let filled = 0;
        let total = 0;
        const x0 = Math.max(0, Math.floor(cx - radius));
        const x1 = Math.min(tw - 1, Math.ceil(cx + radius));
        const y0 = Math.max(0, Math.floor(cy - radius));
        const y1 = Math.min(th - 1, Math.ceil(cy + radius));

        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const dx = x - cx;
                const dy = y - cy;
                if (dx * dx + dy * dy <= maskRSq) { // STEP 3: Count only inside masked circle
                    if (binary[y * tw + x] === 255) filled++;
                    total++;
                }
            }
        }
        return total > 0 ? filled / total : 0;
    }

    const detectedAnswers = {};
    const scores = [];
    let questionIndex = 0;
    let debugCount = 0;

    const processColumn = async (colStartX, colStartY, count) => {
        for (let i = 0; i < count; i++) {
            if (questionIndex >= totalQuestions) break;
            questionIndex++;
            const cy = colStartY + i * config.vg;

            const ratios = [];
            for (let c = 0; c < LETTERS.length; c++) {
                const cx = colStartX + c * config.hg;
                const fr = getFillRatio(cx, cy);
                ratios.push(fr);

                // STEP 6: Debug Mode (Save first 5 ROIs)
                if (debugCount < 5) {
                    await saveDebugROI(cx, cy, questionIndex, c);
                    debugCount++;
                }
            }

            // STEP 4: Fix Fill Ratio Rule
            // If fillRatio > 0.50 → filled
            // If fillRatio < 0.25 → empty
            // Else → treat as empty
            const filledIndices = ratios.map((fr, idx) => (fr > 0.50 ? idx : -1)).filter(idx => idx !== -1);

            if (filledIndices.length === 1) {
                detectedAnswers[String(questionIndex)] = LETTERS[filledIndices[0]];
                scores.push(ratios[filledIndices[0]]);
            } else if (filledIndices.length > 1) {
                detectedAnswers[String(questionIndex)] = 'MULTIPLE';
                scores.push(0.5);
            } else {
                detectedAnswers[String(questionIndex)] = null; // SKIPPED
            }
        }
    };

    // Process questions in two columns
    await processColumn(config.startX, config.startY, 15);
    await processColumn(tw * 0.78, config.startY, 15);

    for (let i = questionIndex + 1; i <= totalQuestions; i++) {
        detectedAnswers[String(i)] = null;
    }

    const confidence = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    console.log(`[OMR] Detection complete. Questions detected: ${scores.length}/${totalQuestions}. Confidence: ${confidence.toFixed(3)}`);
    return { detectedAnswers, confidence };
}

export default { detectOMRAnswers };



