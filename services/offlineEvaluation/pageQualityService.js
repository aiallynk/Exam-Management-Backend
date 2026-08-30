import { Jimp } from 'jimp';

// Part F — document pre-processing quality checks, before any OCR/vision
// call is made. Pure-JS (Jimp, already a dependency — same library
// services/omrCV.js uses for OMR image processing), no external service.
//
// Deliberately simple, real metrics rather than a fabricated "AI quality
// score": pixel-variance for blank-page detection (verified against a real
// rendered test page), and resolution read directly from the decoded
// bitmap (the reliable signal — a scan below ~800px on its shorter side is
// genuinely too small to OCR well regardless of content).
//
// A gradient-based sharpness score is ALSO computed and returned, but is
// deliberately NOT used to gate qualityStatus. Averaging gradient across
// an entire document page is dominated by blank margin — a real test
// against a clean, high-resolution, computer-rendered page (no scan noise
// at all) produced a sharpness score of ~1.0, the same order of magnitude
// a genuinely blurred scan would likely produce, so this signal cannot
// currently distinguish the two reliably without real blurry/sharp sample
// pairs to calibrate against (none were available in this environment —
// see docs/XAMIGO_V2_MASTER_PHASE_4_STATUS.md's benchmark section). It is
// surfaced to the evaluator as an informational number rather than used to
// silently skip OCR on a page that may well be perfectly readable.
const SAMPLE_STRIDE = 3; // sample every 3rd pixel for speed on large scans
const BLANK_VARIANCE_THRESHOLD = 12; // near-uniform grayscale => likely blank
const MIN_UNREADABLE_DIMENSION_PX = 400;
const MIN_ACCEPTABLE_DIMENSION_PX = 800;
const MIN_GOOD_DIMENSION_PX = 1400;

export const assessPageQuality = async (buffer) => {
  let image;
  try {
    image = await Jimp.read(buffer);
  } catch (error) {
    return { qualityStatus: 'UNREADABLE', isLikelyBlank: false, widthPx: null, heightPx: null, estimatedDpi: null, error: `Could not decode image: ${error.message}` };
  }

  const { width, height, data } = image.bitmap;
  if (!width || !height) {
    return { qualityStatus: 'UNREADABLE', isLikelyBlank: false, widthPx: width || null, heightPx: height || null, estimatedDpi: null, error: 'Decoded image has no dimensions.' };
  }

  // Single pass: grayscale samples for variance (blank detection) and a
  // horizontal-gradient sum for sharpness, sampled on a coarse grid.
  let sum = 0;
  let sumSq = 0;
  let gradientSum = 0;
  let sampleCount = 0;
  let previousGray = null;
  for (let y = 0; y < height; y += SAMPLE_STRIDE) {
    previousGray = null;
    for (let x = 0; x < width; x += SAMPLE_STRIDE) {
      const idx = (y * width + x) * 4;
      const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      sum += gray;
      sumSq += gray * gray;
      sampleCount += 1;
      if (previousGray !== null) gradientSum += Math.abs(gray - previousGray);
      previousGray = gray;
    }
  }
  const mean = sum / sampleCount;
  const variance = sumSq / sampleCount - mean * mean;
  const sharpness = gradientSum / sampleCount;

  // Low variance alone means "uniform color," not "blank paper" — a scan
  // failure that comes back solid black or solid red is uniform too, and
  // must not be treated as an intentionally blank page. Blank paper is
  // uniform AND light-colored.
  const isLikelyBlank = variance < BLANK_VARIANCE_THRESHOLD && mean > 180;
  const smallestDimension = Math.min(width, height);

  let qualityStatus;
  if (isLikelyBlank) {
    qualityStatus = 'ACCEPTABLE'; // a genuinely blank page isn't "unreadable" — it's just empty; the ingestion service treats isLikelyBlank separately from qualityStatus
  } else if (smallestDimension < MIN_UNREADABLE_DIMENSION_PX) {
    qualityStatus = 'UNREADABLE';
  } else if (smallestDimension < MIN_ACCEPTABLE_DIMENSION_PX) {
    qualityStatus = 'POOR';
  } else if (smallestDimension < MIN_GOOD_DIMENSION_PX) {
    qualityStatus = 'ACCEPTABLE';
  } else {
    qualityStatus = 'GOOD';
  }

  return {
    qualityStatus,
    isLikelyBlank,
    widthPx: width,
    heightPx: height,
    estimatedDpi: null, // no reliable source for physical page size without scanner metadata — left null rather than guessed
    sharpnessScore: Number(sharpness.toFixed(2)),
  };
};
