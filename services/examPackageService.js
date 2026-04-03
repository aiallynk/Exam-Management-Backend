/**
 * Exam Package Service
 * Handles generation, compression, encryption, and validation of offline exam packages
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import ExamPackage from '../models/ExamPackage.js';
import Exam from '../models/Exam.js';
import QuestionPaper from '../models/QuestionPaper.js';
import Section from '../models/Section.js';
import Question from '../models/Question.js';
import { logInfo, logError } from '../utils/logger.js';
import { sanitizeQuestionOptions } from '../utils/questionOptionSanitizer.js';
import { ensureQuestionsImageAvailability } from './questionImportImageService.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Encryption algorithm
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits
const MIN_ENCRYPTED_PAYLOAD_LENGTH = IV_LENGTH + TAG_LENGTH + 1;
const DEFAULT_MAX_QUESTIONS_PER_PACKAGE = 30;
const DEFAULT_MIN_REQUIRED_QUESTIONS = 10;
const DEFAULT_RECOMMENDED_QUESTIONS = 10;
const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024; // 5 MB uncompressed
const DEFAULT_MAX_COMPRESSED_BYTES = 8 * 1024 * 1024; // 8 MB gzip
const DEFAULT_MAX_ENCRYPTED_BYTES = 12 * 1024 * 1024; // stay below BSON 16MB ceiling
const DEFAULT_MAX_TEXT_LENGTH = 3000;
const DEFAULT_MAX_OPTION_TEXT_LENGTH = 300;
const DEFAULT_MAX_OPTIONS_PER_QUESTION = 8;
const DEFAULT_MAX_TRANSLATION_LANGUAGES = 4;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
};

const MAX_QUESTIONS_PER_PACKAGE = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_QUESTIONS,
  DEFAULT_MAX_QUESTIONS_PER_PACKAGE
);
const MIN_REQUIRED_QUESTIONS_PER_PACKAGE = parsePositiveInt(
  process.env.EXAM_PACKAGE_MIN_QUESTIONS_REQUIRED,
  DEFAULT_MIN_REQUIRED_QUESTIONS
);
const RECOMMENDED_QUESTIONS_PER_PACKAGE = Math.max(
  MIN_REQUIRED_QUESTIONS_PER_PACKAGE,
  parsePositiveInt(
    process.env.EXAM_PACKAGE_RECOMMENDED_QUESTIONS,
    DEFAULT_RECOMMENDED_QUESTIONS
  )
);
const MAX_PACKAGE_JSON_BYTES = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_JSON_BYTES,
  DEFAULT_MAX_JSON_BYTES
);
const MAX_PACKAGE_COMPRESSED_BYTES = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_COMPRESSED_BYTES
);
const MAX_PACKAGE_ENCRYPTED_BYTES = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_ENCRYPTED_BYTES,
  DEFAULT_MAX_ENCRYPTED_BYTES
);
const MAX_TEXT_FIELD_LENGTH = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_TEXT_LENGTH,
  DEFAULT_MAX_TEXT_LENGTH
);
const MAX_OPTION_TEXT_LENGTH = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_OPTION_TEXT_LENGTH,
  DEFAULT_MAX_OPTION_TEXT_LENGTH
);
const MAX_OPTIONS_PER_QUESTION = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_OPTIONS_PER_QUESTION,
  DEFAULT_MAX_OPTIONS_PER_QUESTION
);
const MAX_TRANSLATION_LANGUAGES = parsePositiveInt(
  process.env.EXAM_PACKAGE_MAX_TRANSLATION_LANGUAGES,
  DEFAULT_MAX_TRANSLATION_LANGUAGES
);

// Server secret for key derivation (in production, use environment variable)
const SERVER_SECRET = process.env.EXAM_PACKAGE_SECRET || 'default-secret-change-in-production';

/**
 * Derive encryption key from exam and package identifiers
 * Both server and client can derive the same key
 */
const deriveKey = (examId, packageId, version) => {
  const input = `${examId}:${packageId}:${version}:${SERVER_SECRET}`;
  return crypto.createHash('sha256').update(input).digest();
};

const toPlainObject = (value) => {
  if (!value) return {};
  if (typeof value.toObject === 'function') {
    return value.toObject({ depopulate: true, flattenMaps: true, virtuals: false });
  }
  return value;
};

const toSafeText = (value, maxLength = MAX_TEXT_FIELD_LENGTH) => {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.slice(0, maxLength);
};

const sanitizeOptionList = (value) => {
  const options = sanitizeQuestionOptions(Array.isArray(value) ? value : []);
  return options
    .map((item) => toSafeText(item, MAX_OPTION_TEXT_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS_PER_QUESTION);
};

const sanitizeQuestionTranslations = (translations) => {
  if (!translations || typeof translations !== 'object') {
    return {};
  }

  const entries = Object.entries(translations)
    .filter(([language]) => toSafeText(language, 16))
    .slice(0, MAX_TRANSLATION_LANGUAGES)
    .map(([language, translation]) => {
      const languageKey = toSafeText(language, 16);
      const translationSource =
        translation && typeof translation === 'object' ? translation : {};
      const translatedQuestion = toSafeText(
        translationSource.questionText ??
          translationSource.question_text ??
          translationSource.question ??
          '',
        MAX_TEXT_FIELD_LENGTH
      );
      const translatedOptions = sanitizeOptionList(translationSource.options);
      const payload = {};
      if (translatedQuestion) {
        payload.question = translatedQuestion;
        payload.questionText = translatedQuestion;
        payload.question_text = translatedQuestion;
      }
      if (translatedOptions.length > 0) {
        payload.options = translatedOptions;
      }
      return [languageKey, payload];
    })
    .filter(([, payload]) => Object.keys(payload).length > 0);

  return Object.fromEntries(entries);
};

const sanitizeSectionForPackage = (section) => {
  const source = toPlainObject(section);
  return {
    id: source?._id ? String(source._id) : '',
    uniqueId: toSafeText(source?.uniqueId, 64),
    name: toSafeText(source?.name, 200),
    description: toSafeText(source?.description, 500),
    order: Number.isFinite(Number(source?.order)) ? Number(source.order) : 0,
    duration: Number.isFinite(Number(source?.duration)) ? Number(source.duration) : 0,
    marks: Number.isFinite(Number(source?.marks)) ? Number(source.marks) : 0,
    negativeMarking: Boolean(source?.negativeMarking),
    navigationRule: toSafeText(source?.navigationRule, 64),
    instructions: toSafeText(source?.instructions, 600),
    expectedQuestions: Number.isFinite(Number(source?.expectedQuestions))
      ? Number(source.expectedQuestions)
      : 0,
  };
};

const sanitizeQuestionForPackage = (question, questionIndex = 0) => {
  const source = toPlainObject(question);
  const questionId = source?._id ? String(source._id) : '';
  const questionText = toSafeText(
    source?.questionText ?? source?.question_text ?? source?.question ?? '',
    MAX_TEXT_FIELD_LENGTH
  );
  const questionType = toSafeText(source?.questionType, 64).toUpperCase();
  const options = sanitizeOptionList(source?.options);
  const imageUrl = toSafeText(
    source?.imageUrl ?? source?.generatedImage ?? source?.generated_image ?? source?.image_path ?? '',
    1000
  );
  const safePassage = toSafeText(source?.passage, MAX_TEXT_FIELD_LENGTH);
  const safeTranslations = sanitizeQuestionTranslations(source?.translations);

  return {
    id: questionId,
    uniqueId: toSafeText(source?.uniqueId, 64),
    question: questionText,
    questionText,
    question_text: questionText,
    questionType,
    options,
    image: imageUrl,
    imageUrl,
    image_path: imageUrl,
    generatedImage: imageUrl,
    generated_image: imageUrl,
    passage: safePassage,
    paragraphGroupId: toSafeText(source?.paragraphGroupId, 128),
    points: Number.isFinite(Number(source?.points)) ? Number(source.points) : 1,
    order: Number.isFinite(Number(source?.order)) ? Number(source.order) : questionIndex,
    sectionId: source?.sectionId ? String(source.sectionId) : '',
    translations: safeTranslations,
  };
};

const safeJsonStringify = (value) => {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, currentValue) => {
    if (currentValue && typeof currentValue === 'object') {
      if (seen.has(currentValue)) {
        return undefined;
      }
      seen.add(currentValue);
    }
    return currentValue;
  });
};

const isLikelySerializationError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  const stack = String(error?.stack || '').toLowerCase();
  return (
    message.includes('offset is out of bounds') ||
    message.includes('bson') ||
    message.includes('serialize') ||
    message.includes('rangeerror') ||
    stack.includes('bson')
  );
};

const normalizeSerializationError = (error, context = '') => {
  if (!isLikelySerializationError(error)) {
    return error;
  }
  const contextSuffix = context ? ` (${context})` : '';
  return new Error(
    `Package payload serialization failed${contextSuffix}. Reduce payload size and retry.`
  );
};

const buildQuestionFetchFilter = (questionPaperId) => ({
  questionPaperId,
  // Some historical records may not have isActive. Include those + explicit true.
  $or: [{ isActive: { $exists: false } }, { isActive: true }],
});

const splitEncryptedPayload = (encryptedData, context = 'ExamPackageService') => {
  if (!Buffer.isBuffer(encryptedData)) {
    throw new Error('Encrypted package payload must be a Buffer');
  }

  const totalLength = encryptedData.length;
  const ivStart = 0;
  const ivEnd = Math.min(IV_LENGTH, totalLength);
  const tagStart = ivEnd;
  const tagEnd = Math.min(tagStart + TAG_LENGTH, totalLength);
  const cipherStart = tagEnd;
  const cipherEnd = totalLength;

  logInfo(
    `[${context}] offset trace total=${totalLength} iv=[${ivStart},${ivEnd}) tag=[${tagStart},${tagEnd}) cipher=[${cipherStart},${cipherEnd})`,
    'ExamPackageService'
  );

  if (totalLength < MIN_ENCRYPTED_PAYLOAD_LENGTH) {
    throw new Error(
      `Encrypted package payload is too short (${totalLength} bytes); expected at least ${MIN_ENCRYPTED_PAYLOAD_LENGTH}`
    );
  }

  if (
    ivEnd - ivStart !== IV_LENGTH ||
    tagEnd - tagStart !== TAG_LENGTH ||
    cipherStart < 0 ||
    cipherStart >= totalLength
  ) {
    throw new Error('Invalid encrypted package offsets detected');
  }

  return {
    iv: encryptedData.subarray(ivStart, ivEnd),
    tag: encryptedData.subarray(tagStart, tagEnd),
    encrypted: encryptedData.subarray(cipherStart, cipherEnd),
  };
};

const isIsoDateString = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp);
};

const validatePackageSchema = (payload) => {
  const issues = [];
  const questionCount = Array.isArray(payload?.questions) ? payload.questions.length : 0;
  if (!payload?.exam || typeof payload.exam !== 'object') {
    issues.push('exam');
  }
  if (!payload?.metadata || typeof payload.metadata !== 'object') {
    issues.push('metadata');
  }
  if (!Array.isArray(payload?.questions) || questionCount < MIN_REQUIRED_QUESTIONS_PER_PACKAGE) {
    issues.push('questions');
  }
  const timing = payload?.timing;
  const duration = Number(timing?.duration);
  if (
    !timing ||
    typeof timing !== 'object' ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !isIsoDateString(timing?.startTime) ||
    !isIsoDateString(timing?.endTime)
  ) {
    issues.push('timing');
  }

  return {
    isValid: issues.length === 0,
    issues,
    questionCount,
  };
};

/**
 * Encrypt data using AES-256-GCM
 */
const encrypt = (data, key) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(data);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  const tag = cipher.getAuthTag();
  
  // Combine: iv + tag + encrypted data
  return Buffer.concat([iv, tag, encrypted]);
};

/**
 * Decrypt data using AES-256-GCM
 */
const decrypt = (encryptedData, key) => {
  const { iv, tag, encrypted } = splitEncryptedPayload(
    encryptedData,
    'ExamPackageService/decrypt'
  );
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted;
};

/**
 * Generate SHA-256 hash
 */
const generateHash = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

/**
 * Generate exam package
 * @param {string} examId - Exam ID
 * @param {string} questionPaperId - Question Paper ID
 * @param {string} userId - User creating the package
 * @param {Date} expiresAt - Package expiry date
 * @returns {Promise<Object>} Package info
 */
export const generateExamPackage = async (examId, questionPaperId, userId, expiresAt) => {
  let exam = null;
  try {
    // Get exam
    exam = await Exam.findById(examId);
    if (!exam) {
      throw new Error('Exam not found');
    }
    if (!exam.tenantId) {
      throw new Error(`Exam ${examId} is missing tenantId. Cannot generate package.`);
    }
    const tenantId = exam.tenantId.toString();

    exam.packageStatus = 'PROCESSING';
    exam.packageLastError = '';
    exam.latestPackageUrl = `/api/exam-packages/${examId}/download`;
    await exam.save();

    logInfo(
      `Package generation started for exam ${examId} (tenantId=${tenantId}, questionPaper=${questionPaperId})`,
      'ExamPackageService'
    );

    // Get question paper
    const questionPaper = await QuestionPaper.findById(questionPaperId);
    if (!questionPaper) {
      throw new Error('Question paper not found');
    }

    if (questionPaper.examId.toString() !== examId) {
      throw new Error('Question paper does not belong to this exam');
    }

  // Get all sections for this question paper
  const sections = await Section.find({
    questionPaperId,
    isActive: true,
  }).sort({ order: 1 });

  // Get all questions for this question paper
  const questions = await Question.find(
    buildQuestionFetchFilter(questionPaperId)
  ).sort({ order: 1 });

  await ensureQuestionsImageAvailability({
    questions,
    examId,
    // Avoid package-generation side-effect writes that can trigger BSON serialization issues.
    persist: false,
  });

  const fetchedQuestions = Array.isArray(questions) ? questions : [];
  const tenantSafeQuestions = fetchedQuestions.filter((question) => {
    const questionTenantId = question?.tenantId ? String(question.tenantId) : null;
    return !questionTenantId || questionTenantId === tenantId;
  });
  const filteredOutQuestions = fetchedQuestions.length - tenantSafeQuestions.length;
  const limitedQuestions = tenantSafeQuestions.slice(0, MAX_QUESTIONS_PER_PACKAGE);
  logInfo(
    `Question paper ${questionPaperId} fetched question count: ${fetchedQuestions.length}, eligible=${tenantSafeQuestions.length} (tenantId=${tenantId})`,
    'ExamPackageService'
  );
  if (filteredOutQuestions > 0) {
    logInfo(
      `[WARN] Question paper ${questionPaperId} filtered out ${filteredOutQuestions} question(s) due to tenant mismatch (tenantId=${tenantId})`,
      'ExamPackageService'
    );
  }

  if (tenantSafeQuestions.length === 0) {
    throw new Error(
      `No questions found for question paper ${questionPaperId}. Package generation aborted.`
    );
  }
  if (tenantSafeQuestions.length < MIN_REQUIRED_QUESTIONS_PER_PACKAGE) {
    throw new Error(
      `Question paper ${questionPaperId} has only ${tenantSafeQuestions.length} active question(s). Minimum ${MIN_REQUIRED_QUESTIONS_PER_PACKAGE} question(s) required for package generation.`
    );
  }
  if (tenantSafeQuestions.length < RECOMMENDED_QUESTIONS_PER_PACKAGE) {
    logInfo(
      `[WARN] Question paper ${questionPaperId} has low question count (${tenantSafeQuestions.length}). Recommended minimum is ${RECOMMENDED_QUESTIONS_PER_PACKAGE}.`,
      'ExamPackageService'
    );
  }
  if (tenantSafeQuestions.length > MAX_QUESTIONS_PER_PACKAGE) {
    logInfo(
      `Question paper ${questionPaperId} exceeds package question limit (${tenantSafeQuestions.length} > ${MAX_QUESTIONS_PER_PACKAGE}); truncating payload to first ${MAX_QUESTIONS_PER_PACKAGE} questions`,
      'ExamPackageService'
    );
  }

  // Get or increment version FIRST (needed for package data and key derivation)
  // Look at ALL packages (active and inactive) to ensure version increments correctly on regeneration
  const latestPackage = await ExamPackage.findOne({
    examId,
  }).sort({ version: -1 });

  const version = latestPackage ? latestPackage.version + 1 : 1;

  const packageQuestions = [];
  for (let questionIndex = 0; questionIndex < limitedQuestions.length; questionIndex += 1) {
    if (questionIndex < 0 || questionIndex >= limitedQuestions.length) {
      logInfo(
        `Skipping out-of-range question index ${questionIndex} for question paper ${questionPaperId}`,
        'ExamPackageService'
      );
      continue;
    }

    const question = limitedQuestions[questionIndex];
    if (!question) {
      logInfo(
        `Skipping null question at index ${questionIndex} for question paper ${questionPaperId}`,
        'ExamPackageService'
      );
      continue;
    }

    packageQuestions.push(sanitizeQuestionForPackage(question, questionIndex));
  }

  logInfo(
    `Question paper ${questionPaperId} package question count: ${packageQuestions.length} (tenantId=${tenantId})`,
    'ExamPackageService'
  );

  if (packageQuestions.length === 0) {
    throw new Error(
      `No valid questions generated for question paper ${questionPaperId}. Package generation aborted.`
    );
  }

  // Build package structure (without correct answers)
  const duration = Number.isFinite(Number(exam.duration)) ? Number(exam.duration) : 0;
  const gracePeriod = Number.isFinite(Number(exam.gracePeriod))
    ? Number(exam.gracePeriod)
    : 0;
  const maxAttempts = Number.isFinite(Number(exam.maxAttempts))
    ? Number(exam.maxAttempts)
    : 1;
  const packageCreatedAt = new Date();
  const packageStartTime = new Date(packageCreatedAt);
  const packageEndTime = new Date(
    packageCreatedAt.getTime() + Math.max(0, duration) * 60 * 1000
  );
  const packageData = {
    examId: exam._id.toString(),
    version: version,
    title: toSafeText(exam.title, 300),
    description: toSafeText(exam.description, 1000),
    duration,
    gracePeriod,
    maxAttempts,
    exam: {
      title: toSafeText(exam.title, 300),
      description: toSafeText(exam.description, 1000),
      duration,
      gracePeriod,
      maxAttempts,
      passingPercentage: Number.isFinite(Number(exam.passingPercentage))
        ? Number(exam.passingPercentage)
        : 0,
    },
    timing: {
      duration,
      startTime: packageStartTime.toISOString(),
      endTime: packageEndTime.toISOString(),
    },
    sections: sections.map((section) => sanitizeSectionForPackage(section)),
    questions: packageQuestions,
    metadata: {
      createdAt: packageCreatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      tenantId,
      questionPaperId: questionPaperId.toString(),
      questionPaperSetName: toSafeText(questionPaper?.setName, 120),
      questionCount: packageQuestions.length,
      minimumQuestionsRequired: MIN_REQUIRED_QUESTIONS_PER_PACKAGE,
      recommendedQuestions: RECOMMENDED_QUESTIONS_PER_PACKAGE,
    },
  };
  const packageSchemaValidation = validatePackageSchema(packageData);
  if (!packageSchemaValidation.isValid) {
    throw new Error(
      `Generated package schema is invalid. Missing/invalid: ${packageSchemaValidation.issues.join(', ')}`
    );
  }

  // Convert to JSON string with circular-reference protection
  const jsonData = safeJsonStringify(packageData);
  if (!jsonData) {
    throw new Error('Failed to serialize package data to JSON');
  }
  const jsonBytes = Buffer.byteLength(jsonData, 'utf8');
  if (jsonBytes > MAX_PACKAGE_JSON_BYTES) {
    throw new Error(
      `Package JSON payload too large (${jsonBytes} bytes). Limit is ${MAX_PACKAGE_JSON_BYTES} bytes.`
    );
  }
  logInfo(
    `Package JSON payload size for question paper ${questionPaperId}: ${jsonBytes} bytes`,
    'ExamPackageService'
  );

  // Compress using gzip
  const compressedData = await gzip(jsonData);
  if (compressedData.length > MAX_PACKAGE_COMPRESSED_BYTES) {
    throw new Error(
      `Package compressed payload too large (${compressedData.length} bytes). Limit is ${MAX_PACKAGE_COMPRESSED_BYTES} bytes.`
    );
  }
  logInfo(
    `Package compressed payload size for question paper ${questionPaperId}: ${compressedData.length} bytes`,
    'ExamPackageService'
  );

  // Create package first to get ID for key derivation
  const tempPackageId = crypto.randomBytes(16).toString('hex');
  
  // Derive encryption key from exam and package identifiers
  const key = deriveKey(examId, tempPackageId, version);

  // Encrypt compressed data
  const encryptedData = encrypt(compressedData, key);
  if (encryptedData.length > MAX_PACKAGE_ENCRYPTED_BYTES) {
    throw new Error(
      `Package encrypted payload too large (${encryptedData.length} bytes). Limit is ${MAX_PACKAGE_ENCRYPTED_BYTES} bytes.`
    );
  }

  // Generate hash of encrypted data
  const packageHash = generateHash(encryptedData);

  // Hash the encryption key derivation info (for validation)
  const encryptionKeyHash = generateHash(`${examId}:${tempPackageId}:${version}`);

  // Calculate size
  const size = encryptedData.length;

  // Deactivate old packages for this exam/question paper
  await ExamPackage.updateMany(
    {
      examId,
      questionPaperId,
      isActive: true,
    },
    {
      isActive: false,
    }
  );

  // Create new package
  const examPackage = new ExamPackage({
    examId,
    questionPaperId,
    version,
    packageHash,
    encryptedData,
    encryptionKeyHash, // Store hash for reference
    size,
    expiresAt,
    tenantId: exam.tenantId,
    createdBy: userId,
    isActive: true,
  });

  try {
    await examPackage.save();
  } catch (saveError) {
    throw normalizeSerializationError(saveError, 'initial package save');
  }

  // Re-encrypt with actual package ID for key derivation
  const actualKey = deriveKey(examId, examPackage._id.toString(), version);
  const reEncryptedData = encrypt(compressedData, actualKey);
  if (reEncryptedData.length > MAX_PACKAGE_ENCRYPTED_BYTES) {
    throw new Error(
      `Package encrypted payload too large after final key derivation (${reEncryptedData.length} bytes). Limit is ${MAX_PACKAGE_ENCRYPTED_BYTES} bytes.`
    );
  }
  const rePackageHash = generateHash(reEncryptedData);
  const reEncryptionKeyHash = generateHash(`${examId}:${examPackage._id.toString()}:${version}`);

  // Update with correct hash and encrypted data
  examPackage.encryptedData = reEncryptedData;
  examPackage.packageHash = rePackageHash;
  examPackage.encryptionKeyHash = reEncryptionKeyHash;
  examPackage.size = reEncryptedData.length;
  try {
    await examPackage.save();
  } catch (saveError) {
    throw normalizeSerializationError(saveError, 'final package save');
  }

  // Ensure the final package is persisted and readable before exposing it as GENERATED.
  const persistedPackage = await ExamPackage.findOne({
    _id: examPackage._id,
    examId,
    questionPaperId,
    isActive: true,
  }).select('_id encryptedData packageHash size version createdAt');

  if (
      !persistedPackage?._id ||
      !persistedPackage.encryptedData ||
      persistedPackage.encryptedData.length < MIN_ENCRYPTED_PAYLOAD_LENGTH ||
      !persistedPackage.packageHash ||
      !Number.isFinite(Number(persistedPackage.size)) ||
      Number(persistedPackage.size) <= 0
    ) {
      throw new Error('Package persistence verification failed');
    }

  const verifiedPackage = await decryptPackage(
    persistedPackage.encryptedData,
    examId,
    persistedPackage._id.toString(),
    Number(persistedPackage.version || version || 0)
  );
  const verifiedQuestionCount = Array.isArray(verifiedPackage?.questions)
    ? verifiedPackage.questions.length
    : 0;
  logInfo(
    `Verified decrypted package question count for question paper ${questionPaperId}: ${verifiedQuestionCount}`,
    'ExamPackageService'
  );
  if (verifiedQuestionCount < MIN_REQUIRED_QUESTIONS_PER_PACKAGE) {
    throw new Error(
      `Generated package contains only ${verifiedQuestionCount} question(s) after verification. Minimum ${MIN_REQUIRED_QUESTIONS_PER_PACKAGE} required.`
    );
  }
  const verifiedSchemaValidation = validatePackageSchema(verifiedPackage);
  if (!verifiedSchemaValidation.isValid) {
    throw new Error(
      `Generated package is missing required structure fields: ${verifiedSchemaValidation.issues.join(', ')}`
    );
  }

  // Update exam with package version
  const generatedAt = persistedPackage.createdAt
    ? new Date(persistedPackage.createdAt)
    : new Date();
    exam.offlinePackageVersion = Number(persistedPackage.version || version || 0);
    exam.offlinePackageGeneratedAt = generatedAt;
    exam.offlinePackageEnabled = true;
    exam.packageVersion = Number(persistedPackage.version || version || 0);
    exam.packageStatus = 'READY';
    exam.packageGeneratedAt = generatedAt;
    exam.packageLastGeneratedAt = generatedAt;
    exam.latestPackageUrl = `/api/exam-packages/${examId}/download`;
    exam.packageLastError = '';
    await exam.save();

    logInfo(
      `Package generation completed for exam ${examId} (tenantId=${tenantId}, questionPaper=${questionPaperId}, version=${version}, questionCount=${packageQuestions.length})`,
      'ExamPackageService'
    );
    logInfo(
      `Package status DB updated to READY for exam ${examId}`,
      'ExamPackageService'
    );

    return {
      packageId: examPackage._id.toString(),
      version,
      size: examPackage.size, // Use final size after re-encryption
      hash: examPackage.packageHash, // Use final hash after re-encryption
      expiresAt,
      createdAt: examPackage.createdAt,
    };
  } catch (error) {
    const normalizedError = normalizeSerializationError(error, 'package generation');
    if (exam?._id) {
      await Exam.updateOne(
        { _id: exam._id },
        {
          $set: {
            packageStatus: 'FAILED',
            packageLastError: String(
              normalizedError?.message || 'Package generation failed'
            ).slice(0, 500),
            latestPackageUrl: '',
          },
        }
      ).catch(() => {});
    }

    logError(
      normalizedError,
      `ExamPackageService - package generation failed for exam ${examId} (tenantId=${exam?.tenantId?.toString?.() || 'missing'}, questionPaper=${questionPaperId})`
    );
    throw normalizedError;
  }
};

/**
 * Get exam package for download
 * @param {string} examId - Exam ID
 * @param {string} questionPaperId - Question Paper ID
 * @param {number} version - Package version (optional, defaults to latest)
 * @returns {Promise<Object>} Package data and metadata
 */
export const getExamPackage = async (examId, questionPaperId = null, version = null) => {
  const query = {
    examId,
    isActive: true,
  };

  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }

  if (version) {
    query.version = version;
  }

  const examPackage = await ExamPackage.findOne(query).sort({ version: -1 });

  if (!examPackage) {
    throw new Error('Exam package not found');
  }

  // Check expiry
  if (examPackage.expiresAt < new Date()) {
    throw new Error('Exam package has expired');
  }

  return {
    packageId: examPackage._id.toString(),
    examId: examPackage.examId.toString(),
    questionPaperId: examPackage.questionPaperId?.toString(),
    version: examPackage.version,
    encryptedData: examPackage.encryptedData,
    hash: examPackage.packageHash,
    size: examPackage.size,
    expiresAt: examPackage.expiresAt,
    createdAt: examPackage.createdAt,
  };
};

/**
 * Get package info (metadata only, no data)
 * @param {string} examId - Exam ID
 * @param {string} questionPaperId - Question Paper ID (optional, if not provided returns latest package for exam)
 * @returns {Promise<Object>} Package metadata
 */
export const getPackageInfo = async (examId, questionPaperId = null) => {
  const query = {
    examId,
    isActive: true,
  };

  // If questionPaperId provided, filter by it; otherwise get latest package for exam
  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }

  const examPackage = await ExamPackage.findOne(query).sort({ version: -1 });

  if (!examPackage) {
    return null;
  }

  return {
    packageId: examPackage._id.toString(),
    questionPaperId: examPackage.questionPaperId?.toString(),
    version: examPackage.version,
    size: examPackage.size,
    hash: examPackage.packageHash,
    expiresAt: examPackage.expiresAt,
    createdAt: examPackage.createdAt,
    isExpired: examPackage.expiresAt < new Date(),
  };
};

/**
 * Validate package hash
 * @param {Buffer} packageData - Package data
 * @param {string} expectedHash - Expected hash
 * @returns {boolean} True if valid
 */
export const validatePackageHash = (packageData, expectedHash) => {
  const actualHash = generateHash(packageData);
  return actualHash === expectedHash;
};

/**
 * Decrypt and decompress package (for reference/testing)
 * Note: In production, decryption happens on the client side
 * @param {Buffer} encryptedData - Encrypted package data
 * @param {string} examId - Exam ID for key derivation
 * @param {string} packageId - Package ID for key derivation
 * @param {number} version - Package version for key derivation
 * @returns {Promise<Object>} Decrypted package data
 */
export const decryptPackage = async (encryptedData, examId, packageId, version) => {
  // Derive key
  const key = deriveKey(examId, packageId, version);

  // Decrypt
  const decryptedBuffer = decrypt(encryptedData, key);

  // Decompress
  const decompressedData = await gunzip(decryptedBuffer);

  // Parse JSON
  return JSON.parse(decompressedData.toString('utf8'));
};

/**
 * Check if exam has valid question paper ready for package generation
 * @param {string} examId - Exam ID
 * @returns {Promise<boolean>} True if exam has valid question paper
 */
export const examHasValidQuestionPaper = async (examId) => {
  const questionPapers = await QuestionPaper.find({ examId, isActive: true });
  if (questionPapers.length === 0) return false;
  
  for (const qp of questionPapers) {
    const sections = await Section.find({ questionPaperId: qp._id, isActive: true });
    const questions = await Question.find(buildQuestionFetchFilter(qp._id));
    if (questions.length < MIN_REQUIRED_QUESTIONS_PER_PACKAGE) continue;

    const hasSectionLinkedQuestions = questions.some((question) => Boolean(question.sectionId));
    if (!hasSectionLinkedQuestions || sections.length > 0) {
      return true;
    }
  }
  return false;
};

/**
 * Auto-generate exam packages when exam is published
 * Generates packages for all active question papers with valid sections and questions
 * @param {string} examId - Exam ID
 * @param {string} userId - User ID who published the exam
 * @returns {Promise<Object>} Generation results
 */
export const autoGeneratePackagesOnPublish = async (examId, userId, options = {}) => {
  const forceRegenerate = Boolean(options?.forceRegenerate);
  const targetQuestionPaperIds = Array.isArray(options?.questionPaperIds)
    ? options.questionPaperIds
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : null;
  try {
    logInfo(`Starting auto-generation of packages for exam ${examId}`, 'ExamPackageService');

    // Get exam
    const exam = await Exam.findById(examId);
    if (!exam) {
      throw new Error('Exam not found');
    }
    if (!exam.tenantId) {
      throw new Error(`Exam ${examId} is missing tenantId. Cannot auto-generate packages.`);
    }

    // Get all active question papers for this exam
    const questionPaperFilter = {
      examId,
      isActive: true,
    };
    if (targetQuestionPaperIds?.length) {
      questionPaperFilter._id = { $in: targetQuestionPaperIds };
    }

    const questionPapers = await QuestionPaper.find(questionPaperFilter);

    if (questionPapers.length === 0) {
      logInfo(`No active question papers found for exam ${examId}. Skipping package generation.`, 'ExamPackageService');
      return {
        success: false,
        message: 'No active question papers found',
        generated: 0,
        skipped: 0,
        errors: [],
      };
    }

    const results = {
      success: true,
      generated: 0,
      skipped: 0,
      errors: [],
      noQuestionPapers: 0,
    };

    // Default expiry: 30 days from now
    const defaultExpiry = new Date();
    defaultExpiry.setDate(defaultExpiry.getDate() + 30);

    // Generate package for each question paper
    for (const questionPaper of questionPapers) {
      try {
        // Validate question paper content
        const sections = await Section.find({
          questionPaperId: questionPaper._id,
          isActive: true,
        }).sort({ order: 1 });

        const questions = await Question.find(
          buildQuestionFetchFilter(questionPaper._id)
        );
        const questionCount = Array.isArray(questions) ? questions.length : 0;

        logInfo(
          `Question paper ${questionPaper._id} (${questionPaper.setName}) question count before generation: ${questionCount} (tenantId=${exam.tenantId.toString()})`,
          'ExamPackageService'
        );

        if (questionCount < MIN_REQUIRED_QUESTIONS_PER_PACKAGE) {
          const noQuestionError = `Question paper ${questionPaper._id} has insufficient questions (${questionCount}/${MIN_REQUIRED_QUESTIONS_PER_PACKAGE})`;
          logInfo(`${noQuestionError}. Marking generation as failed for this paper.`, 'ExamPackageService');
          results.skipped++;
          results.noQuestionPapers++;
          results.errors.push({
            questionPaperId: questionPaper._id.toString(),
            questionPaperSetName: questionPaper.setName,
            error: noQuestionError,
          });
          continue;
        }
        if (questionCount < RECOMMENDED_QUESTIONS_PER_PACKAGE) {
          logInfo(
            `[WARN] Question paper ${questionPaper._id} has low question count (${questionCount}/${RECOMMENDED_QUESTIONS_PER_PACKAGE})`,
            'ExamPackageService'
          );
        }

        const hasSectionLinkedQuestions = questions.some((question) => Boolean(question.sectionId));
        if (hasSectionLinkedQuestions && sections.length === 0) {
          logInfo(
            `Question paper ${questionPaper._id} has section-linked questions but no active sections. Skipping.`,
            'ExamPackageService'
          );
          results.skipped++;
          continue;
        }

        // Check if package already exists and is valid
        const existingPackage = await ExamPackage.findOne({
          examId,
          questionPaperId: questionPaper._id,
          isActive: true,
        });

        if (!forceRegenerate && existingPackage && existingPackage.expiresAt > new Date()) {
          logInfo(`Valid package already exists for question paper ${questionPaper._id}. Skipping generation.`, 'ExamPackageService');
          results.skipped++;
          continue;
        }

        // Generate package
        await generateExamPackage(
          examId,
          questionPaper._id.toString(),
          userId,
          defaultExpiry
        );

        logInfo(`Successfully generated package for question paper ${questionPaper._id} (${questionPaper.setName})`, 'ExamPackageService');
        results.generated++;
      } catch (error) {
        const errorMsg = `Failed to generate package for question paper ${questionPaper._id}: ${error.message}`;
        logError(error, `ExamPackageService - ${errorMsg}`);
        results.errors.push({
          questionPaperId: questionPaper._id.toString(),
          questionPaperSetName: questionPaper.setName,
          error: error.message,
        });
      }
    }

    results.success = results.errors.length === 0;

    logInfo(
      `Package generation completed for exam ${examId}. Generated: ${results.generated}, Skipped: ${results.skipped}, Errors: ${results.errors.length}, NoQuestionPapers: ${results.noQuestionPapers}`,
      'ExamPackageService'
    );

    return results;
  } catch (error) {
    logError(error, `ExamPackageService - autoGeneratePackagesOnPublish for exam ${examId}`);
    throw error;
  }
};
