import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';
import config from '../config/env.js';
import { FREE_PLAN_MESSAGES, isPlanFeatureEnabled } from '../config/planLimits.js';
import { putImage, getImageBuffer, imageExists } from '../services/storage/imageStorage.js';

const execFileAsync = util.promisify(execFile);

import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import Tenant from '../models/Tenant.js';
import ExamParticipant from '../models/ExamParticipant.js';
import OMRResult from '../models/OMRResult.js';
import User from '../models/User.js';
import { materializeFromOmrResult } from '../services/omr/omrAttemptMaterializationService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import {
  blockFreePlanByUser,
  resolveExamPlanContext,
  resolveUserEffectivePlanType,
} from '../middleware/planRestrictions.js';
import {
  normalizeQuestionCorrectAnswer,
  sanitizeQuestionOptionText,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const blockFreePlanOmr = blockFreePlanByUser(FREE_PLAN_MESSAGES.OMR_LOCKED, 'omr');

const OMR_ALLOWED_ROLES = ['SUPER_ADMIN', 'EXAM_CREATOR', 'TENANT_ADMIN'];
// Python OMR service removed — GPT-4o-mini Vision handles all image detection.
const MAX_SINGLE_SHEET_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BATCH_FILES = 25;
const MAX_OMR_OPTIONS = 4;
const MANUAL_REVIEW_THRESHOLD_DEFAULT = Number.parseFloat(
  process.env.OMR_MANUAL_REVIEW_THRESHOLD || '0.72'
);
const OBJECT_ID_REGEX = /^[a-fA-F0-9]{24}$/;

const OBJECTIVE_COMPATIBILITY_ERROR_MESSAGE = 'OMR evaluation supports only objective exams.';
const OBJECTIVE_QUESTION_TYPES = new Set(['MULTIPLE_CHOICE', 'TRUE_FALSE']);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const SUPPORTED_PDF_EXTENSIONS = new Set(['.pdf']);
const SUPPORTED_EXTENSIONS = new Set([...SUPPORTED_IMAGE_EXTENSIONS, ...SUPPORTED_PDF_EXTENSIONS]);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const CANDIDATE_LIKE_ROLES = ['CANDIDATE', 'STUDENT', 'USER'];
const EXAM_CODE_MIN_LENGTH = 4;
const EXAM_CODE_MAX_LENGTH = 32;
const EXAM_CODE_NUMERIC_MIN_LENGTH = 5;
const EXAM_CODE_NUMERIC_MAX_LENGTH = 8;
const ROLL_NUMBER_LIKE_MIN_LENGTH = 10;
const OMR_DEBUG_LOGS =
  process.env.NODE_ENV !== 'production' ||
  String(process.env.OMR_DEBUG || '').toLowerCase() === 'true';

const omrDebugLog = (...args) => {
  if (OMR_DEBUG_LOGS) {
    console.log(...args);
  }
};

const omrDebugWarn = (...args) => {
  if (OMR_DEBUG_LOGS) {
    console.warn(...args);
  }
};


const uploadDir = path.join(__dirname, '..', config.uploadDir, 'omr');
await fs.mkdir(uploadDir, { recursive: true });

const sanitizeFilename = (filename = 'sheet') =>
  path
    .basename(String(filename))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 255) || 'sheet';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = sanitizeFilename(file.originalname);
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MAX_BATCH_FILES,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return cb(new Error('Invalid file format. Allowed: JPG, JPEG, PNG, PDF.'));
    }
    cb(null, true);
  },
});

const handleMulterError = (err, _req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `File too large. Maximum allowed upload is ${Math.floor(
        MAX_UPLOAD_BYTES / (1024 * 1024)
      )}MB.`,
    });
  }
  return res.status(400).json({ error: err.message || 'Upload failed.' });
};

const toPositiveInt = (value, fallback = null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
};

const clampNumber = (value, min = 0, max = 1) =>
  Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));

const normalizeCandidateKey = (value = '') =>
  String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

const buildCandidateIdentifiers = (value = '') => {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  const keys = new Set();
  const normalized = normalizeCandidateKey(raw);
  if (normalized) keys.add(normalized);

  // Email local-part fallback for IDs typed as username.
  if (raw.includes('@')) {
    const localPart = normalizeCandidateKey(raw.split('@')[0] || '');
    if (localPart) keys.add(localPart);
  }

  // Numeric variants handle country-code prefixes and leading-zero mismatches.
  const digits = raw.replace(/\D/g, '');
  if (digits) {
    keys.add(digits);

    const noLeadingZeros = digits.replace(/^0+/, '') || '0';
    keys.add(noLeadingZeros);

    if (digits.length > 10) {
      const last10 = digits.slice(-10);
      keys.add(last10);
      keys.add(last10.replace(/^0+/, '') || '0');
    }

    if (digits.length > 12) {
      const last12 = digits.slice(-12);
      keys.add(last12);
      keys.add(last12.replace(/^0+/, '') || '0');
    }
  }

  return Array.from(keys).filter(Boolean);
};

const normalizeOption = (value, optionsPerQuestion) => {
  if (value === undefined || value === null) return 'SKIPPED';

  if (Array.isArray(value)) {
    if (value.length === 0) return 'SKIPPED';
    if (value.length > 1) return 'INVALID';
    return normalizeOption(value[0], optionsPerQuestion);
  }

  const raw = String(value).trim().toUpperCase();
  if (!raw) return 'SKIPPED';
  if (raw === 'SKIPPED') return 'SKIPPED';
  if (raw === 'INVALID') return 'INVALID';
  if (raw.includes(',') || raw.includes('|') || raw.includes('/')) return 'INVALID';

  if (/^\d+$/.test(raw)) {
    const numeric = Number.parseInt(raw, 10);
    if (numeric >= 1 && numeric <= optionsPerQuestion) {
      return LETTERS[numeric - 1];
    }
    return 'INVALID';
  }

  if (raw.length === 1) {
    const index = raw.charCodeAt(0) - 65;
    if (index >= 0 && index < optionsPerQuestion) return raw;
  }

  return 'INVALID';
};

const extractRollFromFilename = (filename = '') => {
  const base = path.basename(String(filename), path.extname(String(filename)));
  const explicit = base.match(/(?:roll|reg|candidate|id)[-_ ]*([a-z0-9]+)/i);
  if (explicit?.[1]) return explicit[1].toUpperCase();

  const numeric = base.match(/(\d{4,})/);
  if (numeric?.[1]) return numeric[1];

  return '';
};

const sanitizeCandidateName = (value = '', candidateRoll = '') => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const cleaned = raw
    .replace(/[^a-zA-Z0-9 .'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const upper = cleaned.toUpperCase();
  const compactUpper = upper.replace(/\s+/g, '');
  const normalizedName = normalizeCandidateKey(cleaned);
  const normalizedRoll = normalizeCandidateKey(candidateRoll);

  if (normalizedRoll) {
    if (normalizedName === normalizedRoll) return '';
    if (normalizedName === `CANDIDATE${normalizedRoll}`) return '';
    if (normalizedName === `ROLL${normalizedRoll}`) return '';
  }

  const blockedExact = new Set([
    'CANDIDATE',
    'ROLL',
    'ROLLNO',
    'ROLLNUMBER',
    'NAME',
    'UNKNOWN',
    'NOTMATCHED',
    'NA',
    'N/A',
  ]);
  if (blockedExact.has(compactUpper)) return '';

  if (/^CANDIDATE[\s:_-]*\d+$/i.test(cleaned)) return '';
  if (/^ROLL(?:\s*(?:NO|NUMBER)?)?[\s:_-]*\d+$/i.test(cleaned)) return '';

  const blockedHints = [
    'CHATGPT',
    'WHATSAPP',
    'GENERATED',
    'ROLL NO',
    'ROLL NUMBER',
    'CANDIDATE ROLL',
    'NOT MATCHED',
    'OMR SHEET',
  ];
  if (blockedHints.some((hint) => upper.includes(hint))) {
    return '';
  }

  const alphaCount = cleaned.replace(/[^A-Za-z]/g, '').length;
  if (alphaCount < 2) return '';

  return cleaned.slice(0, 64);
};

const createOmrSheetId = () =>
  `OMR-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;

const parseQrPayload = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value !== null) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      return { raw: value };
    }
  }
  return null;
};

const formatStrictExamCodeCandidate = (value = '') => {
  const upper = String(value || '').trim().toUpperCase();
  if (!upper) return '';

  const exact = upper.match(/EXAM[-\s:_]*([A-Z0-9]{4})[-\s:_]*([A-Z0-9]{4})/i);
  const exactTail = `${exact?.[1] || ''}${exact?.[2] || ''}`;
  if (exact?.[1] && exact?.[2] && /\d/.test(exactTail)) {
    return `EXAM-${exact[1].toUpperCase()}-${exact[2].toUpperCase()}`;
  }

  const compact = upper.replace(/[^A-Z0-9]/g, '');
  const prefixed = compact.match(/EXAM([A-Z0-9]{4})([A-Z0-9]{4})/i);
  const prefixedTail = `${prefixed?.[1] || ''}${prefixed?.[2] || ''}`;
  if (prefixed?.[1] && prefixed?.[2] && /\d/.test(prefixedTail)) {
    return `EXAM-${prefixed[1].toUpperCase()}-${prefixed[2].toUpperCase()}`;
  }

  return '';
};

const normalizeDetectedExamCodeCandidate = (value = '') => {
  const normalized = normalizeExamIdentifier(value);
  if (!normalized) return '';

  const strict = formatStrictExamCodeCandidate(normalized);
  if (strict) {
    return strict;
  }

  const cleaned = normalized.replace(/[^A-Z0-9-]/g, '');
  if (!cleaned) return '';

  const compact = cleaned.replace(/-/g, '');
  const embeddedExam = compact.match(/EXAM([A-Z0-9]{4})([A-Z0-9]{4})/i);
  if (embeddedExam?.[1] && embeddedExam?.[2]) {
    return `EXAM-${embeddedExam[1].toUpperCase()}-${embeddedExam[2].toUpperCase()}`;
  }

  const prefixed = compact.match(/(?:EXAMCODE|EXAMID|CODE)(EXAM[A-Z0-9]{8}|[A-Z0-9]{4,})/i);
  if (prefixed?.[1]) {
    const prefixedStrict = formatStrictExamCodeCandidate(prefixed[1]);
    if (prefixedStrict) {
      return prefixedStrict;
    }
    return String(prefixed[1]).toUpperCase();
  }

  return cleaned;
};

const sanitizeExamCodeToken = (value = '') =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const isValidExamCodeToken = (value = '', rollNumber = '') => {
  const token = sanitizeExamCodeToken(value);
  if (!token) return false;
  if (token.length < EXAM_CODE_MIN_LENGTH || token.length > EXAM_CODE_MAX_LENGTH) return false;

  const normalizedRoll = String(rollNumber || '').replace(/\D/g, '');
  if (normalizedRoll && token === normalizedRoll) return false;

  if (/^\d+$/.test(token)) {
    if (token.length >= ROLL_NUMBER_LIKE_MIN_LENGTH) return false;
    if (token.length < EXAM_CODE_NUMERIC_MIN_LENGTH) return false;
    if (token.length > EXAM_CODE_NUMERIC_MAX_LENGTH) return false;
  }

  return true;
};

const sanitizeExamCodeComparable = (value = '') =>
  normalizeExamIdentifier(value).replace(/[^A-Z0-9]/g, '');

const OCR_CONFUSION_GROUPS = [
  new Set(['0', 'O', 'Q', 'D']),
  new Set(['1', 'I', 'L', 'T']),
  new Set(['2', 'Z']),
  new Set(['5', 'S']),
  new Set(['6', 'G']),
  new Set(['8', 'B']),
];

const areOcrEquivalentChars = (left = '', right = '') => {
  if (!left || !right) return false;
  const a = String(left).toUpperCase();
  const b = String(right).toUpperCase();
  if (a === b) return true;
  return OCR_CONFUSION_GROUPS.some((group) => group.has(a) && group.has(b));
};

const getWeightedEditDistance = (left = '', right = '') => {
  const a = String(left);
  const b = String(right);
  const rows = b.length + 1;
  const cols = a.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = areOcrEquivalentChars(b[i - 1], a[j - 1])
        ? (b[i - 1] === a[j - 1] ? 0 : 0.25)
        : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
};

const buildExamCodeTokenCandidates = (candidates = []) => {
  const expanded = new Set();
  for (const raw of candidates) {
    const normalized = normalizeExamIdentifier(raw);
    if (!normalized) continue;
    expanded.add(normalized);
    expanded.add(normalized.replace(/[^A-Z0-9]/g, ''));
    expanded.add(normalized.replace(/(?:EXAMCODE|EXAMID|EXAM|CODE)/g, ''));

    const chunks = normalized.match(/[A-Z0-9]{4,}/g) || [];
    for (const chunk of chunks) {
      expanded.add(chunk);
    }
  }
  return Array.from(expanded).filter((token) => token && token.length >= 3);
};

const resolveExamByOcrTokenMatching = async ({ candidates = [], user = null }) => {
  if (!user?.tenantId) return null;

  const normalizedTokens = buildExamCodeTokenCandidates(candidates);
  if (!normalizedTokens.length) return null;

  const tenantExamDocs = await Exam.find({
    tenantId: user.tenantId,
    examType: 'OMR',
  })
    .select('_id uniqueId')
    .lean();

  let best = null;
  let secondBest = null;

  for (const examDoc of tenantExamDocs) {
    const examCodeRaw = String(examDoc?.uniqueId || '').trim();
    const examCodeComparable = sanitizeExamCodeComparable(examCodeRaw);
    if (!examCodeComparable) continue;

    for (const token of normalizedTokens) {
      const tokenComparable = sanitizeExamCodeComparable(token);
      if (!tokenComparable) continue;

      const distance = getWeightedEditDistance(tokenComparable, examCodeComparable);
      const normalizedDistance = distance / Math.max(1, examCodeComparable.length);
      const score = 1 - normalizedDistance;

      const candidateScore = {
        examId: String(examDoc._id || ''),
        examCode: examCodeRaw,
        token,
        distance,
        score,
      };

      if (!best || candidateScore.score > best.score) {
        secondBest = best;
        best = candidateScore;
      } else if (!secondBest || candidateScore.score > secondBest.score) {
        secondBest = candidateScore;
      }
    }
  }

  if (!best) return null;

  const hasSafeMargin = !secondBest || (best.score - secondBest.score) >= 0.06;
  const accepted = best.score >= 0.72 && best.distance <= 2.25 && hasSafeMargin;
  if (!accepted) return null;

  return best.examCode || null;
};

const extractDetectedExamCodeCandidates = (payload = {}, options = {}) => {
  const qrPayload = parseQrPayload(payload?.qr_data || payload?.qrPayload || null);
  const rollNumber = String(
    options?.rollNumber || payload?.roll_number || payload?.rollNumber || ''
  ).trim();
  const debugEntries = Array.isArray(payload?.meta?.exam_code_debug?.entries)
    ? payload.meta.exam_code_debug.entries
    : [];
  const rawCandidates = [
    payload?.exam_code,
    payload?.examCode,
    payload?.exam_id,
    payload?.examId,
    payload?.detected_exam_code,
    payload?.meta?.exam_code,
    payload?.meta?.examCode,
    payload?.meta?.exam_code_candidates,
    payload?.meta?.examCodeCandidates,
    payload?.meta?.exam_code_debug?.candidates,
    payload?.meta?.examCodeDebug?.candidates,
    debugEntries.map((entry) => entry?.raw_text),
    debugEntries.map((entry) => entry?.candidates),
    qrPayload?.examCode,
    qrPayload?.exam_code,
    qrPayload?.examId,
    qrPayload?.exam_id,
  ];

  const flattened = [];
  const pushCandidate = (rawValue) => {
    if (Array.isArray(rawValue)) {
      rawValue.forEach(pushCandidate);
      return;
    }
    flattened.push(rawValue);
  };

  for (const rawValue of rawCandidates) {
    pushCandidate(rawValue);
  }

  const seen = new Set();
  for (const rawValue of flattened) {
    const candidate = normalizeDetectedExamCodeCandidate(rawValue);
    if (!candidate) continue;
    if (!isValidExamCodeToken(candidate, rollNumber)) continue;
    seen.add(candidate);
  }

  return Array.from(seen);
};

const resolveDetectedExamCode = async ({
  pythonResult = {},
  user = null,
  rollNumber = '',
}) => {
  const candidates = extractDetectedExamCodeCandidates(pythonResult, { rollNumber });
  if (!candidates.length) return null;

  const debugInfo = {
    detectedBubbles: Number(pythonResult?.meta?.detected_bubbles || 0),
    extractedDigits: candidates
      .map((value) => String(value).replace(/\D/g, ''))
      .join('|')
      .replace(/\|+/g, '|')
      .replace(/^\||\|$/g, ''),
    candidates,
    finalExamCode: null,
  };

  for (const candidate of candidates) {
    try {
      const exam = await resolveExamByIdentifier(candidate, user);
      if (exam) {
        debugInfo.finalExamCode = String(exam.uniqueId || exam._id || '').trim() || null;
        omrDebugLog('[OMR][extract-id][exam-code]', debugInfo);
        return debugInfo.finalExamCode;
      }
    } catch {
      // Best-effort only; continue trying remaining candidates.
    }
  }

  const fuzzyResolved = await resolveExamByOcrTokenMatching({ candidates, user });
  debugInfo.finalExamCode = fuzzyResolved || null;
  debugInfo.matchType = fuzzyResolved ? 'resolved_exam' : null;
  const strictDetectedCode = candidates.find((candidate) =>
    /^EXAM-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(candidate)
  );
  if (pythonResult?.meta?.exam_code_debug) {
    debugInfo.examCodeDebug = pythonResult.meta.exam_code_debug;
  }
  if (!debugInfo.finalExamCode && strictDetectedCode) {
    debugInfo.finalExamCode = strictDetectedCode;
    debugInfo.matchType = 'ocr_text';
  }
  omrDebugLog('[OMR][extract-id][exam-code]', debugInfo);

  return debugInfo.finalExamCode || null;
};

const evaluateAnswers = ({ detectedAnswers, answerKey, markingRules }) => {
  const totalQuestions = answerKey.length;
  const optionsPerQuestion = toPositiveInt(markingRules?.optionsPerQuestion, 4);
  const marksPerQuestion = Number(markingRules?.marksPerQuestion || 1);
  const negativeMarking = Boolean(markingRules?.negativeMarking);
  const negativeMarks = negativeMarking ? Number(markingRules?.negativeMarks || 0) : 0;

  const resolvedDetectedAnswers = Array.from({ length: totalQuestions }, (_unused, index) =>
    normalizeOption(detectedAnswers?.[index], optionsPerQuestion)
  );

  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;
  let invalidCount = 0;
  let finalScore = 0;

  for (let i = 0; i < totalQuestions; i += 1) {
    const detected = resolvedDetectedAnswers[i];
    const correct = normalizeOption(answerKey[i], optionsPerQuestion);

    if (detected === 'SKIPPED') {
      skippedCount += 1;
      continue;
    }

    if (detected === 'INVALID') {
      invalidCount += 1;
      continue;
    }

    if (detected === correct) {
      correctCount += 1;
      finalScore += marksPerQuestion;
    } else {
      wrongCount += 1;
      if (negativeMarking) {
        finalScore -= negativeMarks;
      }
    }
  }

  return {
    detected_answers: resolvedDetectedAnswers,
    correct_count: correctCount,
    wrong_count: wrongCount,
    skipped_count: skippedCount,
    invalid_count: invalidCount,
    final_score: Number(finalScore.toFixed(2)),
    negative_marks: negativeMarks,
  };
};

const buildAssistedOmrEvaluation = ({
  detectedAnswers,
  totalQuestions,
  optionsPerQuestion = 4,
}) => {
  const resolvedDetectedAnswers = Array.from({ length: totalQuestions }, (_unused, index) =>
    normalizeOption(detectedAnswers?.[index], optionsPerQuestion)
  );
  const skippedCount = resolvedDetectedAnswers.filter((value) => value === 'SKIPPED').length;
  const invalidCount = resolvedDetectedAnswers.filter((value) => value === 'INVALID').length;

  return {
    detected_answers: resolvedDetectedAnswers,
    correct_count: 0,
    wrong_count: 0,
    skipped_count: skippedCount,
    invalid_count: invalidCount,
    final_score: 0,
    negative_marks: 0,
  };
};

const computeConfidenceScore = ({ sheet, evaluation, totalQuestions }) => {
  const directScore = Number(sheet?.confidence_score);
  if (Number.isFinite(directScore)) {
    return Number(clampNumber(directScore, 0, 1).toFixed(3));
  }

  const questionCount = Math.max(1, toPositiveInt(totalQuestions, 1));
  const invalidRatio = Number(evaluation?.invalid_count || 0) / questionCount;
  const skippedRatio = Number(evaluation?.skipped_count || 0) / questionCount;
  const blurScore = Number(sheet?.quality?.blur_score || 0);
  const blurPenalty = blurScore > 0 && blurScore < 45 ? (45 - blurScore) / 120 : 0;

  const computed =
    0.86 - invalidRatio * 0.5 - skippedRatio * 0.22 - clampNumber(blurPenalty, 0, 0.35);

  return Number(clampNumber(computed, 0, 1).toFixed(3));
};

const resolveSheetsFromServiceResponse = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload.sheets)) return payload.sheets;
  if (Array.isArray(payload.results)) return payload.results;
  if (payload.result && typeof payload.result === 'object') return [payload.result];
  if (payload.detected_answers || payload.error) return [payload];
  return [];
};

// isOmrServiceConnectionError removed — Python service no longer used.

const isImageSheetFile = (file = {}) => {
  const ext = path.extname(file?.originalname || '').toLowerCase();
  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) return true;
  if (String(file?.mimetype || '').toLowerCase().startsWith('image/')) return true;
  return false;
};

const isOmrSheetFile = (file = {}) => {
  const ext = path.extname(file?.originalname || '').toLowerCase();
  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) return true;
  if (SUPPORTED_PDF_EXTENSIONS.has(ext)) return true;
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  if (mime === 'application/pdf') return true;
  return false;
};

const resolveImageMimeType = (file = {}) => {
  const ext = path.extname(file?.originalname || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.pdf') return 'application/pdf';
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return mime;
  if (mime === 'application/pdf') return mime;
  return 'image/jpeg';
};

/**
 * Normalize detected answers from object format: { "1": "A", "2": null, "3": "MULTIPLE", ... }
 * Mapping: null → "SKIPPED", "MULTIPLE" → "INVALID"
 */
const normalizeDetectedAnswers = ({ answers, totalQuestions = 0, optionsPerQuestion = 4 }) => {
  // Convert object format {"1":"A", "2":null} to array indexed from 0
  let answersArray;
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    answersArray = Array.from({ length: totalQuestions }, (_unused, index) => {
      const key1 = String(index + 1);   // 1-based key
      const key0 = String(index);        // 0-based key (safety)
      const raw = Object.prototype.hasOwnProperty.call(answers, key1)
        ? answers[key1]
        : Object.prototype.hasOwnProperty.call(answers, key0)
          ? answers[key0]
          : undefined;
      // Map MULTIPLE → a pipe-separated string so normalizeOption returns INVALID
      if (raw === 'MULTIPLE') return 'A|B'; // normalizeOption will return INVALID for '|'
      return raw;
    });
  } else if (Array.isArray(answers)) {
    answersArray = answers.map((raw) => (raw === 'MULTIPLE' ? 'A|B' : raw));
  } else {
    answersArray = [];
  }

  return Array.from({ length: totalQuestions }, (_unused, index) =>
    normalizeOption(answersArray[index], optionsPerQuestion)
  );
};

const callOmrService = async ({ file, exam, evaluationConfig, manualReviewThreshold = MANUAL_REVIEW_THRESHOLD_DEFAULT }) => {
  if (!isOmrSheetFile(file)) {
    const unsupportedError = new Error('Only JPG/JPEG/PNG/PDF files are supported.');
    unsupportedError.statusCode = 400;
    throw unsupportedError;
  }

  const totalQuestions = toPositiveInt(evaluationConfig.markingRules?.totalQuestions, 0);

  try {
    const pythonExecutable = os.platform() === 'win32' ? 'python' : 'python3';
    const omrScriptPath = path.join(__dirname, '..', 'services', 'omr', 'omr.py');
    const scriptArgs = [omrScriptPath, file.path];
    if (totalQuestions > 0) {
      scriptArgs.push(String(totalQuestions));
    }
    const { stdout } = await execFileAsync(pythonExecutable, scriptArgs, { timeout: 60000 });

    let pythonResult;
    try {
      pythonResult = JSON.parse(stdout.trim());
    } catch (parseError) {
      console.error('[OMR][Python] JSON parse error:', parseError);
      throw new Error('OMR service successfully ran but returned invalid data format.');
    }

    if (pythonResult.error) {
      throw new Error(`OMR service error: ${pythonResult.error}`);
    }

    const pythonSheets = Array.isArray(pythonResult.results)
      ? pythonResult.results
      : [pythonResult];

    // Provide a baseline confidence score for deterministic processing
    // Or you can calculate missing questions ratio
    const confidenceScore = 0.95;

    const sheets = pythonSheets.map((sheetPayload = {}) => {
      const detectedRoll = String(sheetPayload.roll_number || '').trim();
      const detectedName = sanitizeCandidateName(sheetPayload.candidate_name, detectedRoll);
      const answersDetected =
        sheetPayload && typeof sheetPayload.answers_detected === 'object'
          ? sheetPayload.answers_detected
          : {};
      const detectedArray = Array.from({ length: totalQuestions }, (_, i) => {
        const key = String(i + 1);
        if (Object.prototype.hasOwnProperty.call(answersDetected, key)) {
          return answersDetected[key];
        }
        return null;
      });

      const sheetError = String(sheetPayload?.error || '').trim();
      const sheetStatus = String(sheetPayload?.status || '').trim().toUpperCase();
      const isErrorSheet = sheetStatus === 'ERROR' || Boolean(sheetError);
      const baseConfidence = isErrorSheet ? 0.15 : confidenceScore;
      const resolvedStatus = isErrorSheet
        ? 'ERROR'
        : baseConfidence < manualReviewThreshold || sheetStatus === 'MANUAL_REVIEW'
          ? 'MANUAL_REVIEW'
          : sheetStatus === 'LOW_CONFIDENCE'
            ? 'LOW_CONFIDENCE'
            : 'PROCESSED';

      return {
        status: resolvedStatus,
        candidate_roll: detectedRoll,
        candidate_name: detectedName,
        detected_answers: normalizeDetectedAnswers({ answers: detectedArray, totalQuestions }),
        sheet_name: file.originalname,
        quality: { engine: 'PYTHON_OPENCV', confidence: baseConfidence },
        confidence_score: baseConfidence,
        manual_review_required: !isErrorSheet && baseConfidence < manualReviewThreshold,
        qr_data: '',
        exam_id: '',
        paper_code: '',
        omr_sheet_id: '',
        detected_exam_code: exam?.uniqueId || null,
        per_question_confidence: {},
        answer_meta: {
          source: 'python_opencv',
          roll_status: String(sheetPayload?.meta?.roll_status || ''),
          page_index: Number(sheetPayload?.page_index || sheetPayload?.meta?.page_index || 0),
          page_number: Number(sheetPayload?.meta?.page_number || 1),
        },
        error: sheetError,
      };
    });

    return {
      sheets,
      count: sheets.length,
      source: 'python_opencv',
    };
  } catch (err) {
    console.error('[OMR][Python] Execution error:', err.message);
    // Fail-safe path: do not hard-fail the entire process request.
    // Return a manual-review sheet with SKIPPED answers so batch processing continues.
    let identityPayload = null;
    try {
      const pythonExecutable = os.platform() === 'win32' ? 'python' : 'python3';
      const omrScriptPath = path.join(__dirname, '..', 'services', 'omr', 'omr.py');
      const { stdout: idStdout } = await execFileAsync(
        pythonExecutable,
        [omrScriptPath, file.path, '--id-only'],
        { timeout: 30000 }
      );
      identityPayload = JSON.parse(String(idStdout || '').trim() || '{}');
    } catch (identityError) {
      console.error('[OMR][Python] Identity fallback failed:', identityError?.message || identityError);
    }

    const fallbackAnswers = normalizeDetectedAnswers({
      answers: Array.from({ length: totalQuestions }, () => null),
      totalQuestions,
    });
    const fallbackRoll = String(
      identityPayload?.roll_number || extractRollFromFilename(file.originalname) || ''
    ).trim();
    const fallbackName = sanitizeCandidateName(identityPayload?.candidate_name, fallbackRoll);
    const fallbackRollStatus = String(
      identityPayload?.roll_status || identityPayload?.meta?.roll_status || ''
    ).trim();
    const fallbackReason = String(err?.message || 'OMR detection failed').trim();

    return {
      sheets: [{
        status: 'MANUAL_REVIEW',
        candidate_roll: fallbackRoll,
        candidate_name: fallbackName,
        detected_answers: fallbackAnswers,
        sheet_name: file.originalname,
        quality: { engine: 'PYTHON_OPENCV', confidence: 0.15 },
        confidence_score: 0.15,
        manual_review_required: true,
        qr_data: '',
        exam_id: '',
        paper_code: '',
        omr_sheet_id: '',
        detected_exam_code: exam?.uniqueId || null,
        per_question_confidence: {},
        answer_meta: {
          source: 'python_opencv_fallback',
          reason: fallbackReason,
          roll_status: fallbackRollStatus,
        },
        error: fallbackReason,
      }],
      count: 1,
      source: 'python_opencv_fallback',
    };
  }
};


const resolveUploadedFiles = (req) => {
  const files = [];

  if (req.file) files.push(req.file);
  if (Array.isArray(req.files?.file)) files.push(...req.files.file);
  if (Array.isArray(req.files?.files)) files.push(...req.files.files);

  const seen = new Set();
  return files.filter((file) => {
    if (!file?.path) return false;
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
};

const resolveAnswerValueByQuestion = (answers, questionNumber, index) => {
  if (Array.isArray(answers)) {
    return answers[index];
  }

  if (!answers || typeof answers !== 'object') {
    return undefined;
  }

  const questionKey = String(questionNumber);
  const zeroBasedKey = String(index);
  const candidateKeys = [
    questionKey,
    `Q${questionKey}`,
    `q${questionKey}`,
    zeroBasedKey,
    `Q${zeroBasedKey}`,
    `q${zeroBasedKey}`,
  ];

  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(answers, key)) {
      return answers[key];
    }
  }

  return undefined;
};

const normalizeComparedAnswer = ({
  value,
  optionsPerQuestion = 4,
  treatMissingAsEmpty = false,
}) => {
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value;

  if (raw === undefined || raw === null) {
    return treatMissingAsEmpty ? '' : 'SKIPPED';
  }

  if (typeof raw === 'string' && raw.trim() === '') {
    return treatMissingAsEmpty ? '' : 'SKIPPED';
  }

  const normalized = normalizeOption(raw, optionsPerQuestion);
  if (treatMissingAsEmpty && normalized === 'SKIPPED') {
    return '';
  }

  return String(normalized || '').trim().toUpperCase();
};

const buildAnswerComparison = ({
  detectedAnswers = [],
  correctAnswers = [],
  totalQuestions = 0,
  optionsPerQuestion = 4,
}) => {
  const detectedCount = Array.isArray(detectedAnswers)
    ? detectedAnswers.length
    : (detectedAnswers && typeof detectedAnswers === 'object'
      ? Object.keys(detectedAnswers).length
      : 0);
  const correctCount = Array.isArray(correctAnswers)
    ? correctAnswers.length
    : (correctAnswers && typeof correctAnswers === 'object'
      ? Object.keys(correctAnswers).length
      : 0);
  const count = Math.max(totalQuestions, detectedCount, correctCount);

  return Array.from({ length: count }, (_unused, index) => {
    const questionNumber = index + 1;
    const detectedRaw = resolveAnswerValueByQuestion(detectedAnswers, questionNumber, index);
    const correctRaw = resolveAnswerValueByQuestion(correctAnswers, questionNumber, index);
    const detected = normalizeComparedAnswer({
      value: detectedRaw,
      optionsPerQuestion,
      treatMissingAsEmpty: false,
    });
    const correct = normalizeComparedAnswer({
      value: correctRaw,
      optionsPerQuestion,
      treatMissingAsEmpty: true,
    });

    if (!correct) {
      omrDebugWarn(`[OMR][answer-compare] Missing answer key for Q${questionNumber}`);
    }

    omrDebugLog('[OMR][answer-compare]', {
      qn: questionNumber,
      detected: detected || null,
      correct: correct || null,
    });

    let status = 'WRONG';
    if (!detected || detected === 'SKIPPED') {
      status = 'SKIPPED';
    } else if (detected === 'INVALID') {
      status = 'INVALID';
    } else if (correct && detected === correct) {
      status = 'CORRECT';
    }

    return {
      questionNumber,
      detected,
      correct,
      status,
    };
  });
};

const buildQuestionAnswerKeyMap = ({
  answers = [],
  totalQuestions = 0,
  optionsPerQuestion = 4,
}) => {
  const count = Math.max(
    totalQuestions,
    Array.isArray(answers)
      ? answers.length
      : (answers && typeof answers === 'object' ? Object.keys(answers).length : 0)
  );
  const answerKey = {};

  for (let index = 0; index < count; index += 1) {
    const questionNumber = index + 1;
    const normalized = normalizeComparedAnswer({
      value: resolveAnswerValueByQuestion(answers, questionNumber, index),
      optionsPerQuestion,
      treatMissingAsEmpty: true,
    });
    if (normalized) {
      answerKey[String(questionNumber)] = normalized;
    }
  }

  return answerKey;
};

const normalizeAnswerKeyArray = ({
  answers = [],
  totalQuestions = 0,
  optionsPerQuestion = 4,
}) => {
  const count = Math.max(
    totalQuestions,
    Array.isArray(answers)
      ? answers.length
      : (answers && typeof answers === 'object' ? Object.keys(answers).length : 0)
  );

  return Array.from({ length: count }, (_unused, index) =>
    normalizeComparedAnswer({
      value: resolveAnswerValueByQuestion(answers, index + 1, index),
      optionsPerQuestion,
      treatMissingAsEmpty: true,
    })
  );
};

const pickAnswerSource = (...sources) => {
  for (const source of sources) {
    if (Array.isArray(source) && source.length > 0) {
      return source;
    }
    if (source && typeof source === 'object' && Object.keys(source).length > 0) {
      return source;
    }
  }

  return (
    sources.find(
      (source) =>
        Array.isArray(source) || (source && typeof source === 'object')
    ) || []
  );
};

const buildStoredMarkingRules = ({ result, optionsPerQuestion = 4 }) => {
  const totalQuestions = toPositiveInt(result?.total_questions, 0) || 0;
  const marksPerQuestion = Number(result?.exam_id?.markingRules?.marksPerQuestion || 1);
  const negativeMarking = Boolean(result?.exam_id?.markingRules?.negativeMarking);

  return {
    totalQuestions,
    optionsPerQuestion,
    marksPerQuestion: Number.isFinite(marksPerQuestion) ? marksPerQuestion : 1,
    negativeMarking,
    negativeMarks: negativeMarking
      ? Number(result?.exam_id?.markingRules?.negativeMarks || 0)
      : 0,
  };
};

const resolveDerivedExamAnswerKey = async ({
  examIdentifier,
  user,
  cache = null,
  fallbackOptionsPerQuestion = 4,
}) => {
  const cacheKey = String(examIdentifier || '').trim();
  if (!cacheKey) return null;

  const loadDerivedAnswerKey = async () => {
    const exam = await ensureExamAccess(examIdentifier, user);
    const evaluationConfig = await resolveExamEvaluationConfig(exam);
    const optionsPerQuestion =
      toPositiveInt(evaluationConfig?.markingRules?.optionsPerQuestion, fallbackOptionsPerQuestion) ||
      fallbackOptionsPerQuestion;

    return {
      answerKey: normalizeAnswerKeyArray({
        answers: evaluationConfig?.answerKey || [],
        totalQuestions: toPositiveInt(evaluationConfig?.markingRules?.totalQuestions, 0) || 0,
        optionsPerQuestion,
      }),
      markingRules: {
        totalQuestions: toPositiveInt(evaluationConfig?.markingRules?.totalQuestions, 0) || 0,
        optionsPerQuestion,
        marksPerQuestion: Number(evaluationConfig?.markingRules?.marksPerQuestion || 1),
        negativeMarking: Boolean(evaluationConfig?.markingRules?.negativeMarking),
        negativeMarks: Boolean(evaluationConfig?.markingRules?.negativeMarking)
          ? Number(evaluationConfig?.markingRules?.negativeMarks || 0)
          : 0,
      },
    };
  };

  if (!cache) {
    return loadDerivedAnswerKey();
  }

  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, loadDerivedAnswerKey());
  }

  return cache.get(cacheKey);
};

const resolveResultAnswerKey = async ({ result, user, cache = null }) => {
  const totalQuestions = toPositiveInt(result?.total_questions, 0) || 0;
  const storedOptionsPerQuestion =
    toPositiveInt(result?.exam_id?.markingRules?.optionsPerQuestion, 4) || 4;
  const storedAnswerSource = pickAnswerSource(
    result?.correct_answers,
    result?.correctAnswers
  );
  const storedAnswerKey = normalizeAnswerKeyArray({
    answers: storedAnswerSource,
    totalQuestions,
    optionsPerQuestion: storedOptionsPerQuestion,
  });
  const storedMarkingRules = buildStoredMarkingRules({
    result,
    optionsPerQuestion: storedOptionsPerQuestion,
  });
  const missingStoredEntries =
    !storedAnswerKey.some(Boolean) ||
    (totalQuestions > 0 && storedAnswerKey.some((value) => !value));

  if (!missingStoredEntries) {
    return {
      answerKey: storedAnswerKey,
      optionsPerQuestion: storedOptionsPerQuestion,
      markingRules: storedMarkingRules,
    };
  }

  const examIdentifier = result?.exam_id?._id || result?.exam_id || result?.examId;
  if (!examIdentifier) {
    return {
      answerKey: storedAnswerKey,
      optionsPerQuestion: storedOptionsPerQuestion,
      markingRules: storedMarkingRules,
    };
  }

  try {
    const derived = await resolveDerivedExamAnswerKey({
      examIdentifier,
      user,
      cache,
      fallbackOptionsPerQuestion: storedOptionsPerQuestion,
    });
    const derivedOptionsPerQuestion =
      toPositiveInt(derived?.markingRules?.optionsPerQuestion, storedOptionsPerQuestion) ||
      storedOptionsPerQuestion;
    const derivedAnswerKey = normalizeAnswerKeyArray({
      answers: derived?.answerKey || [],
      totalQuestions: Math.max(
        totalQuestions,
        toPositiveInt(derived?.markingRules?.totalQuestions, 0) || 0
      ),
      optionsPerQuestion: derivedOptionsPerQuestion,
    });
    const mergedCount = Math.max(totalQuestions, storedAnswerKey.length, derivedAnswerKey.length);
    const mergedAnswerKey = Array.from({ length: mergedCount }, (_unused, index) =>
      storedAnswerKey[index] || derivedAnswerKey[index] || ''
    );

    return {
      answerKey: mergedAnswerKey,
      optionsPerQuestion: derivedOptionsPerQuestion,
      markingRules: {
        ...buildStoredMarkingRules({
          result,
          optionsPerQuestion: derivedOptionsPerQuestion,
        }),
        ...(derived?.markingRules || {}),
        totalQuestions: Math.max(
          totalQuestions,
          toPositiveInt(derived?.markingRules?.totalQuestions, 0) || 0,
          mergedAnswerKey.length
        ),
        optionsPerQuestion: derivedOptionsPerQuestion,
      },
    };
  } catch (error) {
    omrDebugWarn(
      '[OMR][answer-compare] Failed to resolve fallback answer key:',
      error?.message || error
    );
    return {
      answerKey: storedAnswerKey,
      optionsPerQuestion: storedOptionsPerQuestion,
      markingRules: storedMarkingRules,
    };
  }
};

const summarizeAnswerComparison = ({
  answerComparison = [],
  markingRules = {},
  currentStatus = 'PROCESSED',
}) => {
  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;
  let invalidCount = 0;

  for (const row of answerComparison) {
    const rowStatus = String(row?.status || '').trim().toUpperCase();
    if (rowStatus === 'CORRECT') {
      correctCount += 1;
      continue;
    }
    if (rowStatus === 'SKIPPED') {
      skippedCount += 1;
      continue;
    }
    if (rowStatus === 'INVALID') {
      invalidCount += 1;
      continue;
    }
    if (rowStatus === 'WRONG') {
      wrongCount += 1;
    }
  }

  const marksPerQuestion = Number(markingRules?.marksPerQuestion || 1);
  const negativeMarking = Boolean(markingRules?.negativeMarking);
  const negativeMarks = negativeMarking ? Number(markingRules?.negativeMarks || 0) : 0;
  const finalScore = Number(
    (
      correctCount * (Number.isFinite(marksPerQuestion) ? marksPerQuestion : 1) -
      wrongCount * (Number.isFinite(negativeMarks) ? negativeMarks : 0)
    ).toFixed(2)
  );
  const comparedCount = correctCount + wrongCount + skippedCount + invalidCount;
  const status = String(currentStatus || 'PROCESSED').trim().toUpperCase() || 'PROCESSED';

  omrDebugLog('[OMR][result-summary]', {
    correctCount,
    wrongCount,
    unattempted: skippedCount,
    invalidCount,
    finalScore,
    status,
  });

  return {
    correct_count: correctCount,
    wrong_count: wrongCount,
    skipped_count: skippedCount,
    invalid_count: invalidCount,
    final_score: finalScore,
    status,
    compared_count: comparedCount,
  };
};

const applyComputedEvaluationSummary = ({
  result,
  answerComparison = [],
  answerKey = {},
  markingRules = {},
}) => {
  const hasAnswerKey = Boolean(answerKey && Object.keys(answerKey).length > 0);
  if (!Array.isArray(answerComparison) || !answerComparison.length || !hasAnswerKey) {
    return result;
  }

  const summary = summarizeAnswerComparison({
    answerComparison,
    markingRules,
    currentStatus: result?.status || 'PROCESSED',
  });
  const storedCorrect = Number(result?.totalCorrect ?? result?.correct_count ?? 0);
  const storedWrong = Number(result?.totalWrong ?? result?.wrong_count ?? 0);
  const storedSkipped = Number(result?.totalUnattempted ?? result?.skipped_count ?? 0);
  const storedInvalid = Number(result?.invalid_count ?? 0);
  const storedScore = Number(result?.score ?? result?.final_score ?? 0);
  const needsRepair =
    storedCorrect !== summary.correct_count ||
    storedWrong !== summary.wrong_count ||
    storedSkipped !== summary.skipped_count ||
    storedInvalid !== summary.invalid_count ||
    storedScore !== summary.final_score;
  const originalStatus =
    String(result?.status || 'PROCESSED').trim().toUpperCase() || 'PROCESSED';
  const nextStatus =
    hasAnswerKey &&
    summary.compared_count > 0 &&
    originalStatus === 'MANUAL_REVIEW' &&
    needsRepair
      ? 'PROCESSED'
      : originalStatus;
  const nextManualReviewRequired =
    hasAnswerKey &&
    summary.compared_count > 0 &&
    originalStatus === 'MANUAL_REVIEW' &&
    needsRepair
      ? false
      : Boolean(result?.manualReviewRequired);
  const totalQuestions = Math.max(
    toPositiveInt(result?.total_questions, 0) || 0,
    answerComparison.length,
    Object.keys(answerKey).length
  );

  return {
    ...result,
    total_questions: totalQuestions,
    correct_count: summary.correct_count,
    totalCorrect: summary.correct_count,
    wrong_count: summary.wrong_count,
    totalWrong: summary.wrong_count,
    skipped_count: summary.skipped_count,
    totalUnattempted: summary.skipped_count,
    invalid_count: summary.invalid_count,
    final_score: summary.final_score,
    score: summary.final_score,
    status: nextStatus,
    manualReviewRequired: nextManualReviewRequired,
  };
};

const addCandidateKeysToLookup = (lookupMap, user) => {
  const keys = [
    ...(buildCandidateIdentifiers(user?.uniqueId) || []),
    ...(buildCandidateIdentifiers(user?.email) || []),
    ...(buildCandidateIdentifiers(user?.mobile) || []),
  ];

  for (const key of keys) {
    if (!lookupMap.has(key)) {
      lookupMap.set(key, user);
    }
  }
};

const buildCandidateLookup = async (examId, tenantId = null) => {
  const participants = await ExamParticipant.find({
    examId,
    examRole: 'CANDIDATE',
  })
    .populate('userId', '_id uniqueId email mobile name')
    .lean();

  const lookup = new Map();
  const participantUserIds = new Set();

  for (const participant of participants) {
    const user = participant?.userId;
    if (!user) continue;
    participantUserIds.add(user._id);
    addCandidateKeysToLookup(lookup, user);
  }

  // Fallback: if exam participants are missing/incomplete, try tenant candidate users.
  if (tenantId) {
    const fallbackCandidates = await User.find({
      tenantId,
      status: { $ne: 'INACTIVE' },
      role: { $in: CANDIDATE_LIKE_ROLES },
      _id: participantUserIds.size
        ? { $nin: Array.from(participantUserIds).filter(Boolean) }
        : { $exists: true },
    })
      .select('_id uniqueId email mobile name')
      .lean();

    for (const candidate of fallbackCandidates) {
      addCandidateKeysToLookup(lookup, candidate);
    }
  }

  return lookup;
};

const resolveCandidateFromLookup = (lookup, candidateRoll = '') => {
  const identifiers = buildCandidateIdentifiers(candidateRoll);
  for (const key of identifiers) {
    const candidate = lookup.get(key);
    if (candidate?._id) return candidate;
  }
  return null;
};

const buildTenantCandidateLookup = async (tenantId) => {
  if (!tenantId) return new Map();

  const candidates = await User.find({
    tenantId,
    role: { $in: CANDIDATE_LIKE_ROLES },
    status: { $ne: 'INACTIVE' },
  })
    .select('_id uniqueId email mobile name')
    .lean();

  const lookup = new Map();
  for (const candidate of candidates) {
    addCandidateKeysToLookup(lookup, candidate);
  }
  return lookup;
};

const resolveCandidateByRoll = async ({ tenantId, candidateRoll = '' }) => {
  if (!tenantId) return null;
  const identifiers = buildCandidateIdentifiers(candidateRoll);
  if (!identifiers.length) return null;

  const orFilters = [];
  for (const identifier of identifiers) {
    const regex = new RegExp(`^${escapeRegex(identifier)}$`, 'i');
    orFilters.push({ uniqueId: regex }, { email: regex }, { mobile: regex });
  }
  if (!orFilters.length) return null;

  const candidate = await User.findOne({
    tenantId,
    role: { $in: CANDIDATE_LIKE_ROLES },
    status: { $ne: 'INACTIVE' },
    $or: orFilters,
  })
    .select('_id uniqueId email mobile name')
    .lean();

  return candidate || null;
};

const resolveExamCodeFromRollFallback = async ({ tenantId, candidateRoll = '' }) => {
  if (!tenantId) return null;
  const rollToken = String(candidateRoll || '').trim();
  if (!rollToken || ['INVALID', 'INCOMPLETE'].includes(rollToken.toUpperCase())) return null;

  const candidate = await resolveCandidateByRoll({
    tenantId,
    candidateRoll: rollToken,
  });
  if (!candidate?._id) return null;

  const participations = await ExamParticipant.find({
    userId: candidate._id,
    examRole: 'CANDIDATE',
  })
    .populate('examId', '_id uniqueId tenantId examType updatedAt createdAt')
    .lean();

  const examEntries = (participations || [])
    .map((row) => row?.examId)
    .filter((exam) =>
      exam &&
      String(exam?.tenantId || '') === String(tenantId) &&
      String(exam?.examType || '').toUpperCase() === 'OMR'
    );

  const uniqueCodes = new Set(
    examEntries
      .map((exam) => String(exam?.uniqueId || exam?._id || '').trim())
      .filter(Boolean)
  );

  // Only auto-resolve if the candidate is linked to exactly one OMR exam in this tenant.
  if (uniqueCodes.size === 1) {
    return Array.from(uniqueCodes)[0] || null;
  }

  return null;
};

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeExamIdentifier = (value = '') =>
  String(value || '')
    .trim()
    .replace(/^exam\s*code\s*[:#-]?\s*/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();

const createObjectiveCompatibilityError = () => {
  const error = new Error(OBJECTIVE_COMPATIBILITY_ERROR_MESSAGE);
  error.statusCode = 400;
  return error;
};

// Levenshtein distance for fuzzy string matching
const getLevenshteinDistance = (a, b) => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
};

const resolveExamByIdentifier = async (identifierRaw, user = null) => {
  const rawId = String(identifierRaw || '').trim();
  if (!rawId) {
    const error = new Error('examId is required.');
    error.statusCode = 400;
    throw error;
  }

  let exam = null;

  // 1. Try raw ID first (exact match)
  if (OBJECT_ID_REGEX.test(rawId) && mongoose.Types.ObjectId.isValid(rawId)) {
    exam = await Exam.findById(rawId);
  }

  // 2. Try normalized code if not found by raw ID
  const identifier = normalizeExamIdentifier(rawId);
  if (!exam && identifier) {
    // Re-check if normalized version is an ID
    if (OBJECT_ID_REGEX.test(identifier) && mongoose.Types.ObjectId.isValid(identifier)) {
      exam = await Exam.findById(identifier);
    }

    if (!exam) {
      const exactIdentifierRegex = new RegExp(`^${escapeRegex(identifier)}$`, 'i');
      exam = await Exam.findOne({ uniqueId: exactIdentifierRegex });
    }
  }

  // 3. Fallback to fuzzy mapping if the user context is provided (to narrow search)
  if (!exam && identifier && user && user.tenantId) {
    // Only search OMR exams within the user's tenant
    const omrExams = await Exam.find({ tenantId: user.tenantId }).select('_id uniqueId title examType tenantId createdBy');

    let bestMatch = null;
    let minDistance = Infinity;

    for (const candidate of omrExams) {
      if (!candidate.uniqueId) continue;
      const candidateCode = normalizeExamIdentifier(candidate.uniqueId);
      const distance = getLevenshteinDistance(identifier, candidateCode);

      // Allow up to 2 character differences (e.g. S vs 5, O vs 0, Q vs O)
      if (distance <= 2 && distance < minDistance) {
        minDistance = distance;
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      exam = bestMatch;
    }
  }

  return exam;
};

const ensureExamAccess = async (examIdentifier, user) => {
  if (!examIdentifier || String(examIdentifier).trim() === '') {
    const error = new Error('No exam identifier provided. Please select an exam.');
    error.statusCode = 400;
    throw error;
  }

  const exam = await resolveExamByIdentifier(examIdentifier, user);
  if (!exam) {
    const error = new Error(`Exam not found for identifier: "${examIdentifier}". Please check the Exam Code or ID.`);
    error.statusCode = 404;
    throw error;
  }

  if (
    user.role !== 'SUPER_ADMIN' &&
    user.tenantId &&
    exam.tenantId &&
    String(user.tenantId) !== String(exam.tenantId)
  ) {
    const error = new Error('Access denied. This exam belongs to a different organization.');
    error.statusCode = 403;
    throw error;
  }

  return exam;
};


const resolveManualReviewThreshold = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MANUAL_REVIEW_THRESHOLD_DEFAULT;
  return clampNumber(parsed, 0.2, 0.99);
};

const normalizeQuestionOptions = (question, optionLimit = 4) => {
  const safeLimit = Math.max(2, Math.min(8, toPositiveInt(optionLimit, 4) || 4));

  let rawOptions = [];
  if (Array.isArray(question?.options)) {
    rawOptions = question.options;
  } else if (question?.options && typeof question.options === 'object') {
    rawOptions = Object.entries(question.options)
      .sort(([left], [right]) => String(left).localeCompare(String(right), undefined, { numeric: true }))
      .map(([, value]) => value);
  } else if (String(question?.questionType || '').toUpperCase() === 'TRUE_FALSE') {
    rawOptions = ['True', 'False'];
  }

  const normalized = sanitizeQuestionOptions(rawOptions).slice(0, safeLimit);

  if (!normalized.length && safeLimit >= 4) {
    return ['Option A', 'Option B', 'Option C', 'Option D'];
  }
  return normalized;
};

const normalizeOptionText = (value = '') =>
  sanitizeQuestionOptionText(value).toLowerCase();

const normalizeObjectiveQuestionOptions = (question, optionLimit = 4) => {
  const safeLimit = Math.max(2, Math.min(MAX_OMR_OPTIONS, toPositiveInt(optionLimit, 4) || 4));

  let rawOptions = [];
  if (Array.isArray(question?.options)) {
    rawOptions = question.options;
  } else if (question?.options && typeof question.options === 'object') {
    rawOptions = Object.entries(question.options)
      .sort(([left], [right]) => String(left).localeCompare(String(right), undefined, { numeric: true }))
      .map(([, value]) => value);
  } else if (String(question?.questionType || '').toUpperCase() === 'TRUE_FALSE') {
    rawOptions = ['True', 'False'];
  }

  return rawOptions
    .map((value) => sanitizeQuestionOptionText(value))
    .filter(Boolean)
    .slice(0, safeLimit);
};

const resolveCorrectAnswerLabel = ({ question, options = [] }) => {
  const questionType = String(question?.questionType || '').toUpperCase();
  const list = Array.isArray(options) ? options : [];
  if (!list.length) return '';

  const normalizedAnswer = normalizeQuestionCorrectAnswer({
    questionType,
    correctAnswer: question?.correctAnswer,
    options: list,
  });

  if (Array.isArray(normalizedAnswer)) {
    if (normalizedAnswer.length !== 1) return '';
    return resolveCorrectAnswerLabel({
      question: { ...question, correctAnswer: normalizedAnswer[0] },
      options: list,
    });
  }

  const answerText = String(normalizedAnswer ?? '').trim();
  if (!answerText) return '';

  if (/^\d+$/.test(answerText)) {
    const numeric = Number.parseInt(answerText, 10);
    if (numeric >= 1 && numeric <= list.length) {
      return LETTERS[numeric - 1];
    }
  }

  const upperAnswer = answerText.toUpperCase();
  if (/^[A-Z]$/.test(upperAnswer)) {
    const idx = upperAnswer.charCodeAt(0) - 65;
    if (idx >= 0 && idx < list.length) {
      return upperAnswer;
    }
  }

  if (questionType === 'TRUE_FALSE') {
    const truthy = answerText.toLowerCase().startsWith('t');
    const falsy = answerText.toLowerCase().startsWith('f');
    if (truthy || falsy) {
      const target = truthy ? 'true' : 'false';
      const idx = list.findIndex((option) => normalizeOptionText(option) === target);
      if (idx >= 0) {
        return LETTERS[idx];
      }
    }
  }

  const exactIdx = list.findIndex(
    (option) => normalizeOptionText(option) === normalizeOptionText(answerText)
  );
  if (exactIdx >= 0) {
    return LETTERS[exactIdx];
  }

  return '';
};

const buildObjectiveExamConfigFromQuestions = async (exam) => {
  const firstPaper = await QuestionPaper.findOne({ examId: exam._id })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();

  if (!firstPaper?._id) {
    throw createObjectiveCompatibilityError();
  }

  const questionDocs = await Question.find({ questionPaperId: firstPaper._id })
    .sort({ order: 1, createdAt: 1 })
    .select('questionType options correctAnswer')
    .lean();

  if (!questionDocs.length) {
    throw createObjectiveCompatibilityError();
  }

  let optionsPerQuestion = 2;
  const answerKey = [];

  for (const question of questionDocs) {
    const questionType = String(question?.questionType || '').toUpperCase();
    if (!OBJECTIVE_QUESTION_TYPES.has(questionType)) {
      throw createObjectiveCompatibilityError();
    }

    const options = normalizeObjectiveQuestionOptions(question, MAX_OMR_OPTIONS);
    if (!options.length || options.length > MAX_OMR_OPTIONS) {
      throw createObjectiveCompatibilityError();
    }

    optionsPerQuestion = Math.max(optionsPerQuestion, options.length);
    const correctLabel = resolveCorrectAnswerLabel({ question, options });
    if (!correctLabel) {
      throw createObjectiveCompatibilityError();
    }

    answerKey.push(correctLabel);
  }

  if (!answerKey.length) {
    throw createObjectiveCompatibilityError();
  }

  const negativeMarking = Boolean(exam?.markingRules?.negativeMarking);
  return {
    answerKey,
    markingRules: {
      totalQuestions: answerKey.length,
      optionsPerQuestion,
      marksPerQuestion: Number(exam?.markingRules?.marksPerQuestion || 1),
      negativeMarking,
      negativeMarks: negativeMarking ? Number(exam?.markingRules?.negativeMarks || 0) : 0,
    },
  };
};

const resolveExamEvaluationConfig = async (exam) => {
  const baseKey = Array.isArray(exam?.answerKey) ? exam.answerKey : [];
  const totalQuestionsFromRules = toPositiveInt(exam?.markingRules?.totalQuestions, null);
  const hasEmbeddedKey = baseKey.length > 0;

  if (hasEmbeddedKey) {
    const optionsPerQuestion = Math.max(
      2,
      Math.min(
        MAX_OMR_OPTIONS,
        toPositiveInt(exam?.markingRules?.optionsPerQuestion, MAX_OMR_OPTIONS) || MAX_OMR_OPTIONS
      )
    );
    const totalQuestions = Math.max(totalQuestionsFromRules || 0, baseKey.length);
    const normalizedAnswerKey = [];

    for (let index = 0; index < totalQuestions; index += 1) {
      const normalized = normalizeOption(baseKey[index], optionsPerQuestion);
      if (normalized === 'SKIPPED' || normalized === 'INVALID') {
        throw createObjectiveCompatibilityError();
      }
      normalizedAnswerKey.push(normalized);
    }

    if (!normalizedAnswerKey.length) {
      throw createObjectiveCompatibilityError();
    }

    const negativeMarking = Boolean(exam?.markingRules?.negativeMarking);
    return {
      answerKey: normalizedAnswerKey,
      markingRules: {
        totalQuestions: normalizedAnswerKey.length,
        optionsPerQuestion,
        marksPerQuestion: Number(exam?.markingRules?.marksPerQuestion || 1),
        negativeMarking,
        negativeMarks: negativeMarking ? Number(exam?.markingRules?.negativeMarks || 0) : 0,
      },
    };
  }

  return buildObjectiveExamConfigFromQuestions(exam);
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /omr/extract-id
// Lightweight identification-only extraction from a single OMR sheet image.
// Returns { examCode, rollNumber, candidateName } as strict JSON.
// Does NOT evaluate answers. Does NOT save anything to the database.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/extract-id',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  upload.single('file'),
  handleMulterError,
  async (req, res, next) => {
    const file = req.file;
    omrDebugLog(`[OMR][extract-id] Received request for file: ${file?.originalname}`);

    // Cleanup helper — remove temp file after response
    const cleanup = async () => {
      if (file?.path) {
        await fs.unlink(file.path).catch(() => { });
      }
    };

    try {
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded. Send a single image as multipart field "file".' });
      }
      if (!isImageSheetFile(file)) {
        await cleanup();
        return res.status(400).json({ error: 'Only JPG/JPEG/PNG images are supported for ID extraction.' });
      }

      const pythonExecutable = os.platform() === 'win32' ? 'python' : 'python3';
      const omrScriptPath = path.join(__dirname, '..', 'services', 'omr', 'omr.py');

      let pythonResult = {};
      try {
        const { stdout } = await execFileAsync(
          pythonExecutable,
          [omrScriptPath, file.path, '--id-only'],
          { timeout: 60000 }
        );
        pythonResult = JSON.parse(String(stdout || '').trim() || '{}');
      } catch (extractError) {
        console.error('[OMR][extract-id] Python extraction failed:', extractError?.message || extractError);
      }

      const rollRaw = String(pythonResult?.roll_number || '').trim();
      const rollStatus = String(
        pythonResult?.roll_status || pythonResult?.meta?.roll_status || ''
      )
        .trim()
        .toUpperCase();
      const fallbackRoll = extractRollFromFilename(file.originalname);

      const rollNumber =
        rollRaw ||
        fallbackRoll ||
        (rollStatus && rollStatus !== 'OK' ? rollStatus : null);
      let candidateName = sanitizeCandidateName(pythonResult?.candidate_name, rollNumber) || null;
      let detectedExamCode = await resolveDetectedExamCode({
        pythonResult,
        user: req.user,
        rollNumber: rollNumber || '',
      });
      if (!detectedExamCode && rollNumber) {
        detectedExamCode = await resolveExamCodeFromRollFallback({
          tenantId: req.user.tenantId,
          candidateRoll: rollNumber,
        });
      }

      // If name is not extracted from sheet, try resolving by detected roll in current tenant.
      if (!candidateName && rollNumber && !['INVALID', 'INCOMPLETE'].includes(String(rollNumber).toUpperCase())) {
        const matchedUser = await resolveCandidateByRoll({
          tenantId: req.user.tenantId,
          candidateRoll: rollNumber,
        });
        candidateName = String(matchedUser?.name || '').trim() || null;
      }

      await cleanup();
      return res.json({
        examCode: detectedExamCode || null,
        rollNumber: rollNumber || null,
        candidateName,
        meta: pythonResult?.meta && typeof pythonResult.meta === 'object' ? pythonResult.meta : null,
      });
    } catch (error) {
      await cleanup();
      return next(error);
    }
  }
);

const buildTemplatePayload = async (exam, configOverrides = {}) => {
  const [tenant, firstSession, firstPaper] = await Promise.all([
    Tenant.findById(exam.tenantId).select('name').lean(),
    ExamSession.findOne({ examId: exam._id }).sort({ startTime: 1 }).select('startTime').lean(),
    QuestionPaper.findOne({ examId: exam._id })
      .sort({ createdAt: 1 })
      .select('_id setName uniqueId')
      .lean(),
  ]);

  const optionsPerQuestion =
    toPositiveInt(configOverrides?.optionsPerQuestion, null) ||
    exam.markingRules?.optionsPerQuestion ||
    4;
  const questionDocs = firstPaper?._id
    ? await Question.find({ questionPaperId: firstPaper._id })
      .sort({ order: 1, createdAt: 1 })
      .select('questionText options questionType points order')
      .lean()
    : [];

  const questions = questionDocs.map((question, index) => ({
    questionNumber: index + 1,
    questionText: String(question?.questionText || '').trim(),
    options: normalizeQuestionOptions(question, optionsPerQuestion),
    points: Number(question?.points || 1),
  }));

  const totalQuestions =
    questions.length ||
    toPositiveInt(configOverrides?.totalQuestions, null) ||
    exam.markingRules?.totalQuestions ||
    exam.answerKey?.length ||
    0;
  const paperCode =
    String(firstPaper?.uniqueId || '').trim() ||
    String(firstPaper?.setName || '').trim() ||
    String(exam.uniqueId || '').trim() ||
    String(exam._id);
  const omrSheetId = createOmrSheetId();

  return {
    instituteName: String(tenant?.name || 'Institute'),
    examName: String(exam.title || 'Exam'),
    examCode: String(exam.uniqueId || exam._id),
    examId: String(exam._id),
    examDate: firstSession?.startTime || null,
    instructions: [
      'Use black or blue ball pen only.',
      'Fill one bubble per question. Multiple marks will be treated as invalid.',
      'Do not fold or damage this OMR sheet.',
      'Ensure roll number bubbles are filled correctly.',
    ],
    paperCode,
    omrSheetId,
    totalQuestions,
    optionsPerQuestion,
    questions,
  };
};

router.get(
  '/template/:examId',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  async (req, res, next) => {
    try {
      const exam = await ensureExamAccess(req.params.examId, req.user);
      const evaluationConfig = await resolveExamEvaluationConfig(exam);
      const template = await buildTemplatePayload(exam, {
        totalQuestions: evaluationConfig.markingRules.totalQuestions,
        optionsPerQuestion: evaluationConfig.markingRules.optionsPerQuestion,
      });
      return res.json({ template });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/process',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: MAX_BATCH_FILES },
  ]),
  handleMulterError,
  async (req, res, next) => {
    try {
      const examIdentifier = String(
        req.body.exam_code || req.body.examCode || req.body.examId || ''
      ).trim();
      omrDebugLog(`[OMR][process] Received request for exam identifier: "${examIdentifier}"`);
      if (!examIdentifier) {
        return res.status(400).json({ error: 'exam_code is required.' });
      }

      const files = resolveUploadedFiles(req);
      if (!files.length) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const exam = await ensureExamAccess(examIdentifier, req.user);
      const evaluationConfig = await resolveExamEvaluationConfig(exam);
      const examPlanContext = await resolveExamPlanContext(exam._id);
      const effectivePlanType =
        examPlanContext?.planType || (await resolveUserEffectivePlanType(req.user));
      const omrAutoGradingEnabled = isPlanFeatureEnabled(
        effectivePlanType,
        'omrAutoGrading'
      );
      const manualReviewThreshold = resolveManualReviewThreshold(req.body.confidenceThreshold);
      const candidateLookup = await buildCandidateLookup(exam._id, exam.tenantId);
      const savedResults = [];
      let failedFilesCount = 0;
      let firstFailureMessage = '';

      for (const file of files) {
        try {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (file.size > MAX_SINGLE_SHEET_BYTES) {
          throw new Error(
            `File "${file.originalname}" exceeds 5MB. Each sheet file must be 5MB or smaller.`
          );
        }

        const payload = await callOmrService({
          file,
          exam,
          evaluationConfig,
          manualReviewThreshold,
        });
        const sheets = resolveSheetsFromServiceResponse(payload);
        if (!sheets.length) {
          continue;
        }

        // The Python detector needs a real local file (file.path); once it's
        // done with it, persist the same bytes to S3 and drop the scratch
        // copy — the S3 URL is what gets stored on the OMRResult, not the
        // local path.
        let scannedImageUrl = '';
        try {
          const fileBuffer = await fs.readFile(file.path);
          const stored = await putImage({
            tenantId: req.user.tenantId,
            examId: exam._id,
            category: 'omr',
            fileStem: path.parse(file.originalname || 'sheet').name,
            extension: ext,
            buffer: fileBuffer,
          });
          scannedImageUrl = stored?.url || '';
        } finally {
          await fs.unlink(file.path).catch(() => {});
        }

        for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
          const sheet = sheets[sheetIndex] || {};
          const qrPayload = parseQrPayload(sheet.qr_data);
          const qrExamId = qrPayload?.examId || qrPayload?.exam_id || sheet.exam_id || '';
          const qrPaperCode = qrPayload?.paperCode || qrPayload?.paper_code || sheet.paper_code || '';
          const qrSheetId = qrPayload?.omrSheetId || qrPayload?.omr_sheet_id || sheet.omr_sheet_id;
          const qrRoll = qrPayload?.rollNumber || qrPayload?.roll || '';

          const detectedAnswers = Array.isArray(sheet.detected_answers) ? sheet.detected_answers : [];
          const detectedRoll = String(sheet.candidate_roll || '').trim();
          const fallbackRoll = extractRollFromFilename(file.originalname);
          const candidateRoll = String(detectedRoll || qrRoll || fallbackRoll || 'UNKNOWN').trim().toUpperCase();

          // ── Evaluate answers first — undetected questions become SKIPPED ──
          // evaluateAnswers() already maps missing entries to SKIPPED via normalizeOption,
          // so partial detection is fine; it will NOT throw due to missing questions.
          const evaluation = omrAutoGradingEnabled
            ? evaluateAnswers({
              detectedAnswers,
              answerKey: evaluationConfig.answerKey || [],
              markingRules: evaluationConfig.markingRules || {},
            })
            : buildAssistedOmrEvaluation({
              detectedAnswers,
              totalQuestions: evaluationConfig.markingRules?.totalQuestions || 0,
              optionsPerQuestion: evaluationConfig.markingRules?.optionsPerQuestion || 4,
            });

          const confidenceScore = computeConfidenceScore({
            sheet,
            evaluation,
            totalQuestions: evaluationConfig.markingRules?.totalQuestions || 0,
          });

          // ── Resolve status ────────────────────────────────────────────────
          // Inherit LOW_CONFIDENCE status from OpenAI fallback if set
          const sheetStatus = String(sheet.status || '').toUpperCase();
          let status = sheetStatus === 'LOW_CONFIDENCE' ? 'LOW_CONFIDENCE' : 'PROCESSED';
          let errorMessage = String(sheet.error || '').trim();

          // QR exam mismatch is a hard error
          if (qrExamId && String(qrExamId).trim() && String(qrExamId).trim() !== String(exam._id)) {
            status = 'ERROR';
            errorMessage = 'QR exam ID does not match selected exam.';
          }

          // Missing roll number is only a SOFT warning — mark for manual review,
          // NOT a hard error. The sheet can still be scored.
          if (!detectedRoll && !qrRoll && !fallbackRoll) {
            if (status !== 'ERROR') {
              status = 'MANUAL_REVIEW';
              errorMessage = errorMessage || 'Roll number could not be detected; please verify manually.';
            }
          }

          // Preserve hard ERROR from Python/OpenAI service only if there's a real error message
          // AND the sheet has NO detected answers at all (entirely unreadable)
          if (sheetStatus === 'ERROR' && detectedAnswers.length === 0) {
            status = 'ERROR';
          }

          // Low confidence from Python service → LOW_CONFIDENCE (not ERROR)
          const manualReviewRequired =
            !omrAutoGradingEnabled ||
            status === 'LOW_CONFIDENCE' ||
            (status !== 'ERROR' && confidenceScore < manualReviewThreshold);
          if (manualReviewRequired && status !== 'LOW_CONFIDENCE' && status !== 'ERROR') {
            status = 'MANUAL_REVIEW';
          }

          const matchedCandidate =
            resolveCandidateFromLookup(candidateLookup, candidateRoll) ||
            (await resolveCandidateByRoll({
              tenantId: exam.tenantId,
              candidateRoll,
            }));
          const detectedCandidateName = sanitizeCandidateName(sheet.candidate_name, candidateRoll);
          const resolvedStudentName = String(
            matchedCandidate?.name ||
            detectedCandidateName ||
            ''
          ).trim();
          const evaluatedAt = new Date();
          const totalQuestions = evaluationConfig.markingRules?.totalQuestions || 0;
          const omrSheetId = String(qrSheetId || createOmrSheetId()).trim();
          const examCodeValue = String(exam.uniqueId || exam._id || '').trim();
          const scannedImagePath = scannedImageUrl;

          const documentPayload = {
            exam_id: exam._id,
            examId: exam._id,
            exam_code: examCodeValue,
            tenant_id: exam.tenantId,
            candidate_roll: candidateRoll,
            rollNumber: candidateRoll,
            student_roll_no: candidateRoll,
            student_name: resolvedStudentName,
            omrSheetId,
            detected_answers: evaluation.detected_answers,
            detectedAnswers: evaluation.detected_answers,
            correct_answers: omrAutoGradingEnabled ? evaluationConfig.answerKey || [] : [],
            total_questions: totalQuestions,
            correct_count: evaluation.correct_count,
            totalCorrect: evaluation.correct_count,
            wrong_count: evaluation.wrong_count,
            totalWrong: evaluation.wrong_count,
            skipped_count: evaluation.skipped_count,
            totalUnattempted: evaluation.skipped_count,
            invalid_count: evaluation.invalid_count,
            negative_marks: evaluation.negative_marks,
            final_score: evaluation.final_score,
            score: evaluation.final_score,
            confidenceScore,
            confidence: confidenceScore,
            manualReviewRequired,
            status,
            processed_at: evaluatedAt,
            evaluatedAt,
            paper_code: String(qrPaperCode || exam.uniqueId || '').trim(),
            qr_payload: qrPayload,
            candidate_id: matchedCandidate?._id || null,
            candidate_matched: Boolean(matchedCandidate?._id),
            preprocessing_meta: {
              ...(sheet.quality || {}),
              detected_candidate_name: detectedCandidateName,
            },
            source_file: scannedImagePath,
            scanned_image_path: scannedImagePath,
            preview_url:
              sheet.preview_url ||
              (SUPPORTED_IMAGE_EXTENSIONS.has(ext) ? scannedImageUrl : ''),
            sheet_index: sheetIndex,
            error_message: errorMessage,
            created_by: req.user._id,
          };

          let resultDoc;
          // Prevent duplicate roll numbers for same exam_code by updating existing row.
          if (candidateRoll && candidateRoll !== 'UNKNOWN') {
            const existingResult = await OMRResult.findOne({
              exam_id: exam._id,
              candidate_roll: candidateRoll,
            });
            if (existingResult) {
              Object.assign(existingResult, documentPayload);
              existingResult.created_by = existingResult.created_by || req.user._id;
              await existingResult.save();
              resultDoc = existingResult;
            }
          }

          if (!resultDoc) {
            resultDoc = await OMRResult.create(documentPayload);
          }

          if (matchedCandidate?._id && omrAutoGradingEnabled && status !== 'ERROR') {
            try {
              await materializeFromOmrResult({ omrResultId: resultDoc._id, actorUserId: req.user._id });
            } catch (materializeError) {
              console.error('[OMR][materialize]', materializeError?.message || materializeError);
            }
          }

          savedResults.push(resultDoc);
        }
        } catch (fileError) {
          failedFilesCount += 1;
          if (!firstFailureMessage) {
            firstFailureMessage =
              fileError?.message || `Failed to process "${file?.originalname || 'sheet'}".`;
          }
          console.error(
            `[OMR][process] Failed to process file "${file?.originalname || 'unknown'}":`,
            fileError?.message || fileError
          );
        }
      }

      if (!savedResults.length) {
        return res.status(400).json({
          error: firstFailureMessage || 'No OMR sheets were detected in the uploaded file(s).',
        });
      }

      return res.json({
        message: omrAutoGradingEnabled
          ? `Processed ${savedResults.length} sheet(s) from ${files.length} file(s).`
          : `Processed ${savedResults.length} sheet(s) from ${files.length} file(s) in assisted mode. Manual review required.`,
        summary: {
          processed: savedResults.length,
          manualReview: savedResults.filter((result) => result.manualReviewRequired).length,
          errors: savedResults.filter((result) => result.status === 'ERROR').length + failedFilesCount,
          mode: omrAutoGradingEnabled ? 'full' : 'assisted',
        },
        results: savedResults,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  '/results',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  async (req, res, next) => {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
      const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit || '20', 10)));
      const skip = (page - 1) * limit;
      const examId = String(req.query.examId || '').trim();
      const examCode = String(req.query.examCode || '').trim();
      const roll = String(req.query.roll || req.query.rollNumber || '').trim();
      const status = String(req.query.status || '').trim().toUpperCase();
      const search = String(req.query.search || '').trim();
      const uploadDate = String(req.query.uploadDate || '').trim();
      const minScoreRaw = req.query.minScore;
      const maxScoreRaw = req.query.maxScore;
      const minScore = Number.isFinite(Number(minScoreRaw)) ? Number(minScoreRaw) : null;
      const maxScore = Number.isFinite(Number(maxScoreRaw)) ? Number(maxScoreRaw) : null;

      const andConditions = [{ tenant_id: req.user.tenantId }];

      if (examId) {
        const exam = await ensureExamAccess(examId, req.user);
        andConditions.push({ exam_id: exam._id });
      }

      if (examCode) {
        andConditions.push({ exam_code: { $regex: escapeRegex(examCode), $options: 'i' } });
      }

      if (roll) {
        const rollRegex = { $regex: escapeRegex(roll), $options: 'i' };
        andConditions.push({
          $or: [{ candidate_roll: rollRegex }, { student_roll_no: rollRegex }, { rollNumber: rollRegex }],
        });
      }

      if (status) {
        if (status === 'FAILED') {
          andConditions.push({ status: { $in: ['ERROR', 'INVALID'] } });
        } else if (status === 'PROCESSED') {
          andConditions.push({ status: { $in: ['PROCESSED', 'MANUAL_REVIEW', 'LOW_CONFIDENCE'] } });
        } else {
          andConditions.push({ status });
        }
      }

      if (minScore !== null || maxScore !== null) {
        const scoreFilter = {};
        if (minScore !== null) scoreFilter.$gte = minScore;
        if (maxScore !== null) scoreFilter.$lte = maxScore;
        andConditions.push({ score: scoreFilter });
      }

      if (uploadDate) {
        const parsedDate = new Date(uploadDate);
        if (!Number.isNaN(parsedDate.getTime())) {
          const start = new Date(parsedDate);
          start.setHours(0, 0, 0, 0);
          const end = new Date(parsedDate);
          end.setHours(23, 59, 59, 999);
          andConditions.push({
            $or: [
              { processed_at: { $gte: start, $lte: end } },
              { created_at: { $gte: start, $lte: end } },
              { createdAt: { $gte: start, $lte: end } },
            ],
          });
        }
      }

      if (search) {
        const searchRegex = new RegExp(escapeRegex(search), 'i');
        const matchedUsers = await User.find({
          tenantId: req.user.tenantId,
          name: searchRegex,
        })
          .select('_id')
          .lean();
        const matchedUserIds = matchedUsers.map((user) => user._id).filter(Boolean);

        andConditions.push({
          $or: [
            { candidate_roll: searchRegex },
            { student_roll_no: searchRegex },
            { rollNumber: searchRegex },
            { student_name: searchRegex },
            { exam_code: searchRegex },
            ...(matchedUserIds.length ? [{ candidate_id: { $in: matchedUserIds } }] : []),
          ],
        });
      }

      const filter = andConditions.length > 1 ? { $and: andConditions } : andConditions[0];

      const [results, total] = await Promise.all([
        OMRResult.find(filter)
          .populate('exam_id', 'title examType uniqueId markingRules')
          .populate('candidate_id', 'name email uniqueId')
          .sort({ processed_at: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        OMRResult.countDocuments(filter),
      ]);

      const hasMissingCandidateNames = results.some((result = {}) => {
        const existingName = String(
          result?.candidate_id?.name ||
          sanitizeCandidateName(result.student_name, result.student_roll_no || result.rollNumber || result.candidate_roll)
        ).trim();
        const existingRoll = String(
          result.student_roll_no || result.rollNumber || result.candidate_roll || ''
        ).trim();
        return !existingName && Boolean(existingRoll);
      });
      const tenantCandidateLookup = hasMissingCandidateNames
        ? await buildTenantCandidateLookup(req.user.tenantId)
        : null;
      const answerKeyCache = new Map();

      const normalizedResults = await Promise.all(results.map(async (result = {}) => {
        const normalizedExamCode = String(
          result.exam_code || result?.exam_id?.uniqueId || result?.examId?.uniqueId || ''
        ).trim();
        const normalizedRoll = String(
          result.student_roll_no || result.rollNumber || result.candidate_roll || ''
        ).trim();
        const storedStudentName = sanitizeCandidateName(result.student_name, normalizedRoll);
        const detectedCandidateName = sanitizeCandidateName(
          result?.preprocessing_meta?.detected_candidate_name || '',
          normalizedRoll
        );
        const hasPopulatedCandidateName = Boolean(
          String(result?.candidate_id?.name || '').trim()
        );
        const resolvedCandidate =
          (!hasPopulatedCandidateName && tenantCandidateLookup && normalizedRoll
            ? resolveCandidateFromLookup(tenantCandidateLookup, normalizedRoll)
            : null) || null;
        const normalizedName = String(
          storedStudentName ||
          result?.candidate_id?.name ||
          resolvedCandidate?.name ||
          detectedCandidateName ||
          ''
        ).trim();
        const normalizedConfidence = Number(
          result.confidence ?? result.confidenceScore ?? 0
        );
        const resolvedAnswerKey = await resolveResultAnswerKey({
          result,
          user: req.user,
          cache: answerKeyCache,
        });
        const answerKey = buildQuestionAnswerKeyMap({
          answers: resolvedAnswerKey.answerKey,
          totalQuestions:
            toPositiveInt(result.total_questions, 0) || resolvedAnswerKey.answerKey.length || 0,
          optionsPerQuestion: resolvedAnswerKey.optionsPerQuestion,
        });
        const detectedAnswers = pickAnswerSource(
          result.detected_answers,
          result.detectedAnswers
        );
        const answerComparison = buildAnswerComparison({
          detectedAnswers,
          correctAnswers: resolvedAnswerKey.answerKey,
          totalQuestions:
            toPositiveInt(result.total_questions, 0) || resolvedAnswerKey.answerKey.length || 0,
          optionsPerQuestion: resolvedAnswerKey.optionsPerQuestion,
        });
        const normalizedResult = {
          ...result,
          candidate_id:
            (hasPopulatedCandidateName ? result?.candidate_id : null) ||
            (resolvedCandidate
              ? {
                _id: resolvedCandidate._id,
                name: resolvedCandidate.name || '',
                email: resolvedCandidate.email || '',
                uniqueId: resolvedCandidate.uniqueId || '',
              }
              : result?.candidate_id || null),
          exam_code: normalizedExamCode,
          student_roll_no: normalizedRoll,
          student_name: normalizedName,
          confidence: Number.isFinite(normalizedConfidence) ? normalizedConfidence : 0,
          correct_answers: resolvedAnswerKey.answerKey,
          correctAnswers: resolvedAnswerKey.answerKey,
        };

        return applyComputedEvaluationSummary({
          result: normalizedResult,
          answerComparison,
          answerKey,
          markingRules: resolvedAnswerKey.markingRules,
        });
      }));

      return res.json({
        results: normalizedResults,
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  '/results/:resultId',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  async (req, res, next) => {
    try {
      const result = await OMRResult.findOne({
        _id: req.params.resultId,
        tenant_id: req.user.tenantId,
      })
        .populate('exam_id', 'title uniqueId examType markingRules')
        .populate('candidate_id', 'name email uniqueId')
        .lean();

      if (!result) {
        return res.status(404).json({ error: 'OMR result not found.' });
      }

      const resolvedAnswerKey = await resolveResultAnswerKey({
        result,
        user: req.user,
      });
      const answerKey = buildQuestionAnswerKeyMap({
        answers: resolvedAnswerKey.answerKey,
        totalQuestions:
          toPositiveInt(result.total_questions, 0) || resolvedAnswerKey.answerKey.length || 0,
        optionsPerQuestion: resolvedAnswerKey.optionsPerQuestion,
      });
      const resultWithResolvedAnswerKey = {
        ...result,
        correct_answers: resolvedAnswerKey.answerKey,
        correctAnswers: resolvedAnswerKey.answerKey,
      };
      const detectedAnswers = pickAnswerSource(
        resultWithResolvedAnswerKey.detected_answers,
        resultWithResolvedAnswerKey.detectedAnswers
      );

      const answerComparison = buildAnswerComparison({
        detectedAnswers,
        correctAnswers: resultWithResolvedAnswerKey.correct_answers || [],
        totalQuestions:
          toPositiveInt(resultWithResolvedAnswerKey.total_questions, 0) ||
          resolvedAnswerKey.answerKey.length ||
          0,
        optionsPerQuestion: resolvedAnswerKey.optionsPerQuestion,
      });
      const summarizedResult = applyComputedEvaluationSummary({
        result: resultWithResolvedAnswerKey,
        answerComparison,
        answerKey,
        markingRules: resolvedAnswerKey.markingRules,
      });

      return res.json({
        result: summarizedResult,
        answerKey,
        answerComparison,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  '/results/:resultId/report',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  async (req, res, next) => {
    try {
      const result = await OMRResult.findOne({
        _id: req.params.resultId,
        tenant_id: req.user.tenantId,
      })
        .populate('exam_id', 'title uniqueId examType markingRules')
        .populate('candidate_id', 'name email uniqueId')
        .lean();

      if (!result) {
        return res.status(404).json({ error: 'OMR result not found.' });
      }

      const resolvedAnswerKey = await resolveResultAnswerKey({
        result,
        user: req.user,
      });
      const answerKey = buildQuestionAnswerKeyMap({
        answers: resolvedAnswerKey.answerKey,
        totalQuestions:
          toPositiveInt(result.total_questions, 0) || resolvedAnswerKey.answerKey.length || 0,
        optionsPerQuestion: resolvedAnswerKey.optionsPerQuestion,
      });
      const resultWithResolvedAnswerKey = {
        ...result,
        correct_answers: resolvedAnswerKey.answerKey,
        correctAnswers: resolvedAnswerKey.answerKey,
      };
      const detectedAnswers = pickAnswerSource(
        resultWithResolvedAnswerKey.detected_answers,
        resultWithResolvedAnswerKey.detectedAnswers
      );

      const answerComparison = buildAnswerComparison({
        detectedAnswers,
        correctAnswers: resultWithResolvedAnswerKey.correct_answers || [],
        totalQuestions:
          toPositiveInt(resultWithResolvedAnswerKey.total_questions, 0) ||
          resolvedAnswerKey.answerKey.length ||
          0,
        optionsPerQuestion: resolvedAnswerKey.optionsPerQuestion,
      });
      const summarizedResult = applyComputedEvaluationSummary({
        result: resultWithResolvedAnswerKey,
        answerComparison,
        answerKey,
        markingRules: resolvedAnswerKey.markingRules,
      });

      return res.json({
        report: {
          exam: result.exam_id || null,
          result: summarizedResult,
          answerKey,
          answerComparison,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/results/:resultId/reprocess',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  async (req, res, next) => {
    try {
      const result = await OMRResult.findOne({
        _id: req.params.resultId,
        tenant_id: req.user.tenantId,
      });
      if (!result) {
        return res.status(404).json({ error: 'OMR result not found.' });
      }

      const exam = await ensureExamAccess(result.exam_id, req.user);
      const evaluationConfig = await resolveExamEvaluationConfig(exam);
      const examPlanContext = await resolveExamPlanContext(exam._id);
      const effectivePlanType =
        examPlanContext?.planType || (await resolveUserEffectivePlanType(req.user));
      const omrAutoGradingEnabled = isPlanFeatureEnabled(
        effectivePlanType,
        'omrAutoGrading'
      );
      if (!result.source_file) {
        return res.status(400).json({ error: 'No source file available for reprocessing.' });
      }

      if (!(await imageExists({ url: result.source_file }))) {
        return res.status(400).json({ error: 'Source file was not found in storage.' });
      }

      const sourceExt = path.extname(result.source_file || '').toLowerCase();
      // The Python detector needs a real local file — materialize a fresh
      // scratch copy from S3, use it for this reprocess, then discard it.
      const tempPath = path.join(os.tmpdir(), `omr-reprocess-${Date.now()}-${Math.round(Math.random() * 1e9)}${sourceExt || '.jpg'}`);
      const sourceBuffer = await getImageBuffer({ url: result.source_file });
      if (!sourceBuffer?.length) {
        return res.status(400).json({ error: 'Source file is empty or invalid.' });
      }
      await fs.writeFile(tempPath, sourceBuffer);

      const pseudoFile = {
        path: tempPath,
        originalname: path.basename(result.source_file),
        mimetype:
          sourceExt === '.png'
            ? 'image/png'
            : sourceExt === '.pdf'
              ? 'application/pdf'
              : 'image/jpeg',
      };

      const manualReviewThreshold = resolveManualReviewThreshold(req.body?.confidenceThreshold);
      let payload;
      try {
        payload = await callOmrService({
          file: pseudoFile,
          exam,
          evaluationConfig,
          manualReviewThreshold,
        });
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
      const sheets = resolveSheetsFromServiceResponse(payload);
      const currentSheet = sheets[0];

      if (!currentSheet) {
        return res.status(400).json({ error: 'No valid sheet was detected during reprocess.' });
      }

      const qrPayload = parseQrPayload(currentSheet.qr_data);
      const qrExamId = qrPayload?.examId || qrPayload?.exam_id || currentSheet.exam_id || '';
      const qrRoll = qrPayload?.rollNumber || qrPayload?.roll || '';
      const qrSheetId = qrPayload?.omrSheetId || qrPayload?.omr_sheet_id || currentSheet.omr_sheet_id;
      const qrPaperCode = qrPayload?.paperCode || qrPayload?.paper_code || currentSheet.paper_code || '';

      const evaluation = omrAutoGradingEnabled
        ? evaluateAnswers({
          detectedAnswers: currentSheet.detected_answers,
          answerKey: evaluationConfig.answerKey || [],
          markingRules: evaluationConfig.markingRules || {},
        })
        : buildAssistedOmrEvaluation({
          detectedAnswers: currentSheet.detected_answers,
          totalQuestions: evaluationConfig.markingRules?.totalQuestions || 0,
          optionsPerQuestion: evaluationConfig.markingRules?.optionsPerQuestion || 4,
        });

      const confidenceScore = computeConfidenceScore({
        sheet: currentSheet,
        evaluation,
        totalQuestions: evaluationConfig.markingRules?.totalQuestions || 0,
      });

      const candidateLookup = await buildCandidateLookup(exam._id, exam.tenantId);
      const nextRoll = String(currentSheet.candidate_roll || qrRoll || result.candidate_roll || '').trim();
      const matchedCandidate =
        resolveCandidateFromLookup(candidateLookup, nextRoll) ||
        (await resolveCandidateByRoll({
          tenantId: exam.tenantId,
          candidateRoll: nextRoll,
        }));
      const detectedCandidateName = sanitizeCandidateName(currentSheet.candidate_name, nextRoll);
      const existingStudentName = sanitizeCandidateName(result.student_name, result.candidate_roll || nextRoll);
      const resolvedStudentName = String(
        matchedCandidate?.name ||
        detectedCandidateName ||
        existingStudentName ||
        ''
      ).trim();

      let reprocessError = String(currentSheet.error || '').trim();
      let status = String(currentSheet.status || '').toUpperCase() === 'ERROR' ? 'ERROR' : 'PROCESSED';
      if (qrExamId && String(qrExamId).trim() && String(qrExamId).trim() !== String(exam._id)) {
        reprocessError = reprocessError || 'QR exam ID does not match selected exam.';
      }
      if (reprocessError) {
        status = 'ERROR';
      }
      const manualReviewRequired =
        !omrAutoGradingEnabled ||
        (status !== 'ERROR' && confidenceScore < manualReviewThreshold);
      if (manualReviewRequired && status !== 'ERROR') {
        status = 'MANUAL_REVIEW';
      }

      const evaluatedAt = new Date();
      result.examId = exam._id;
      result.exam_code = String(exam.uniqueId || exam._id || '').trim();
      result.candidate_roll = nextRoll || 'UNKNOWN';
      result.rollNumber = result.candidate_roll;
      result.student_roll_no = result.candidate_roll;
      result.student_name = resolvedStudentName;
      result.omrSheetId = String(qrSheetId || result.omrSheetId || createOmrSheetId()).trim();
      result.detected_answers = evaluation.detected_answers;
      result.detectedAnswers = evaluation.detected_answers;
      result.correct_answers = omrAutoGradingEnabled ? evaluationConfig.answerKey || [] : [];
      result.total_questions = evaluationConfig.markingRules?.totalQuestions || 0;
      result.correct_count = evaluation.correct_count;
      result.totalCorrect = evaluation.correct_count;
      result.wrong_count = evaluation.wrong_count;
      result.totalWrong = evaluation.wrong_count;
      result.skipped_count = evaluation.skipped_count;
      result.totalUnattempted = evaluation.skipped_count;
      result.invalid_count = evaluation.invalid_count;
      result.negative_marks = evaluation.negative_marks;
      result.final_score = evaluation.final_score;
      result.score = evaluation.final_score;
      result.confidenceScore = confidenceScore;
      result.confidence = confidenceScore;
      result.manualReviewRequired = manualReviewRequired;
      result.status = status;
      result.error_message = reprocessError;
      result.paper_code = String(qrPaperCode || result.paper_code || exam.uniqueId || '').trim();
      result.qr_payload = qrPayload || result.qr_payload || null;
      result.candidate_id = matchedCandidate?._id || null;
      result.candidate_matched = Boolean(matchedCandidate?._id);
      result.preprocessing_meta = {
        ...(currentSheet.quality || {}),
        detected_candidate_name: detectedCandidateName,
      };
      result.scanned_image_path = result.source_file || '';
      result.processed_at = evaluatedAt;
      result.evaluatedAt = evaluatedAt;
      await result.save();

      return res.json({
        message: 'Result reprocessed successfully.',
        result,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  '/results/:resultId',
  requireAuth,
  requireTenant,
  blockFreePlanOmr,
  requireRole(...OMR_ALLOWED_ROLES),
  async (req, res, next) => {
    try {
      const removed = await OMRResult.findOneAndDelete({
        _id: req.params.resultId,
        tenant_id: req.user.tenantId,
      });
      if (!removed) {
        return res.status(404).json({ error: 'OMR result not found.' });
      }
      return res.json({ message: 'OMR result deleted successfully.' });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
