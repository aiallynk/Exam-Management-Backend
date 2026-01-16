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

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Encryption algorithm
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

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
  const iv = encryptedData.slice(0, IV_LENGTH);
  const tag = encryptedData.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = encryptedData.slice(IV_LENGTH + TAG_LENGTH);
  
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
  // Get exam
  const exam = await Exam.findById(examId);
  if (!exam) {
    throw new Error('Exam not found');
  }

  // Get question paper
  const questionPaper = await QuestionPaper.findById(questionPaperId)
    .populate('sections');
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
  const questions = await Question.find({
    questionPaperId,
  }).sort({ order: 1 });

  // Build package structure (without correct answers)
  const packageData = {
    examId: exam._id.toString(),
    version: (exam.offlinePackageVersion || 0) + 1,
    exam: {
      title: exam.title,
      description: exam.description,
      duration: exam.duration,
      gracePeriod: exam.gracePeriod,
      maxAttempts: exam.maxAttempts,
      passingPercentage: exam.passingPercentage,
    },
    sections: sections.map(section => ({
      id: section._id.toString(),
      uniqueId: section.uniqueId,
      name: section.name,
      description: section.description,
      order: section.order,
      duration: section.duration,
      marks: section.marks,
      negativeMarking: section.negativeMarking,
      navigationRule: section.navigationRule,
      instructions: section.instructions,
      expectedQuestions: section.expectedQuestions,
    })),
    questions: questions.map(question => ({
      id: question._id.toString(),
      uniqueId: question.uniqueId,
      questionText: question.questionText,
      questionType: question.questionType,
      options: question.options, // Include options but NOT correct answers
      imageUrl: question.imageUrl,
      passage: question.passage,
      points: question.points,
      order: question.order,
      sectionId: question.sectionId?.toString(),
      translations: question.translations ? Object.fromEntries(question.translations) : {},
    })),
    metadata: {
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      questionPaperId: questionPaperId.toString(),
      questionPaperSetName: questionPaper.setName,
    },
  };

  // Convert to JSON string
  const jsonData = JSON.stringify(packageData);

  // Compress using gzip
  const compressedData = await gzip(jsonData);

  // Create package first to get ID for key derivation
  const tempPackageId = crypto.randomBytes(16).toString('hex');
  
  // Derive encryption key from exam and package identifiers
  const key = deriveKey(examId, tempPackageId, version);

  // Encrypt compressed data
  const encryptedData = encrypt(compressedData, key);

  // Generate hash of encrypted data
  const packageHash = generateHash(encryptedData);

  // Hash the encryption key derivation info (for validation)
  const encryptionKeyHash = generateHash(`${examId}:${tempPackageId}:${version}`);

  // Calculate size
  const size = encryptedData.length;

  // Get or increment version
  const latestPackage = await ExamPackage.findOne({
    examId,
    questionPaperId,
    isActive: true,
  }).sort({ version: -1 });

  const version = latestPackage ? latestPackage.version + 1 : 1;

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

  await examPackage.save();

  // Re-encrypt with actual package ID for key derivation
  const actualKey = deriveKey(examId, examPackage._id.toString(), version);
  const reEncryptedData = encrypt(compressedData, actualKey);
  const rePackageHash = generateHash(reEncryptedData);
  const reEncryptionKeyHash = generateHash(`${examId}:${examPackage._id.toString()}:${version}`);

  // Update with correct hash and encrypted data
  examPackage.encryptedData = reEncryptedData;
  examPackage.packageHash = rePackageHash;
  examPackage.encryptionKeyHash = reEncryptionKeyHash;
  examPackage.size = reEncryptedData.length;
  await examPackage.save();

  // Update exam with package version
  exam.offlinePackageVersion = version;
  exam.offlinePackageGeneratedAt = new Date();
  exam.offlinePackageEnabled = true;
  await exam.save();

  return {
    packageId: examPackage._id.toString(),
    version,
    size,
    hash: packageHash,
    expiresAt,
    createdAt: examPackage.createdAt,
  };
};

/**
 * Get exam package for download
 * @param {string} examId - Exam ID
 * @param {string} questionPaperId - Question Paper ID
 * @param {number} version - Package version (optional, defaults to latest)
 * @returns {Promise<Object>} Package data and metadata
 */
export const getExamPackage = async (examId, questionPaperId, version = null) => {
  const query = {
    examId,
    questionPaperId,
    isActive: true,
  };

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
 * @param {string} questionPaperId - Question Paper ID
 * @returns {Promise<Object>} Package metadata
 */
export const getPackageInfo = async (examId, questionPaperId) => {
  const examPackage = await ExamPackage.findOne({
    examId,
    questionPaperId,
    isActive: true,
  }).sort({ version: -1 });

  if (!examPackage) {
    return null;
  }

  return {
    packageId: examPackage._id.toString(),
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
 * Auto-generate exam packages when exam is published
 * Generates packages for all active question papers with valid sections and questions
 * @param {string} examId - Exam ID
 * @param {string} userId - User ID who published the exam
 * @returns {Promise<Object>} Generation results
 */
export const autoGeneratePackagesOnPublish = async (examId, userId) => {
  try {
    logInfo(`Starting auto-generation of packages for exam ${examId}`, 'ExamPackageService');

    // Get exam
    const exam = await Exam.findById(examId);
    if (!exam) {
      throw new Error('Exam not found');
    }

    // Get all active question papers for this exam
    const questionPapers = await QuestionPaper.find({
      examId,
      isActive: true,
    });

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
    };

    // Default expiry: 30 days from now
    const defaultExpiry = new Date();
    defaultExpiry.setDate(defaultExpiry.getDate() + 30);

    // Generate package for each question paper
    for (const questionPaper of questionPapers) {
      try {
        // Validate question paper has sections
        const sections = await Section.find({
          questionPaperId: questionPaper._id,
          isActive: true,
        }).sort({ order: 1 });

        if (sections.length === 0) {
          logInfo(`Question paper ${questionPaper._id} has no active sections. Skipping.`, 'ExamPackageService');
          results.skipped++;
          continue;
        }

        // Validate sections have questions
        const questions = await Question.find({
          questionPaperId: questionPaper._id,
        });

        if (questions.length === 0) {
          logInfo(`Question paper ${questionPaper._id} has no questions. Skipping.`, 'ExamPackageService');
          results.skipped++;
          continue;
        }

        // Check if package already exists and is valid
        const existingPackage = await ExamPackage.findOne({
          examId,
          questionPaperId: questionPaper._id,
          isActive: true,
        });

        if (existingPackage && existingPackage.expiresAt > new Date()) {
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

    logInfo(`Package generation completed for exam ${examId}. Generated: ${results.generated}, Skipped: ${results.skipped}, Errors: ${results.errors.length}`, 'ExamPackageService');

    return results;
  } catch (error) {
    logError(error, `ExamPackageService - autoGeneratePackagesOnPublish for exam ${examId}`);
    throw error;
  }
};
