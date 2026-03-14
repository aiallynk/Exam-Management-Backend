import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { aiRateLimiter } from '../middleware/rateLimiter.js';
import { generateQuestions, extractQuestionsFromContent } from '../services/aiService.js';
import {
  parseQuestionImportFile,
  attachImagesToImportedQuestions,
  extractTextFromImageArtifacts,
  extractTextFromPdfBufferWithVision,
} from '../services/questionImportImageService.js';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import path from 'path';
import pdfParse from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';
import OpenAI from 'openai';
import config from '../config/env.js';
import { normalizeQuestionFormat } from '../utils/questionTypes.js';

const handleMulterUploadError = (err, req, res, next) => {
  if (!err) {
    return next();
  }

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }

    return res.status(400).json({ error: err.message || 'File upload failed' });
  }

  return res.status(400).json({ error: err.message || 'File upload failed' });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.txt', '.csv', '.xlsx', '.xls', '.docx', '.png', '.jpg', '.jpeg', '.svg'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, TXT, CSV, XLSX, XLS, DOCX, PNG, JPG, JPEG, SVG'));
    }
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.xlsx', '.xls', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, Excel, JPG, JPEG, PNG'));
    }
  },
});

const router = express.Router();

// Generate questions using AI (available to EXAM_CREATOR)
router.post(
  '/import-questions',
  aiRateLimiter, // Rate limit AI operations
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can generate questions
  upload.single('file'),
  handleMulterUploadError,
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const importData = await parseQuestionImportFile(req.file);
      let { text, structuredRows } = importData;
      let hasText = typeof text === 'string' && text.trim().length > 0;
      const hasStructuredRows = Array.isArray(structuredRows) && structuredRows.length > 0;

      if (!hasText && !hasStructuredRows) {
        if (importData.extension === '.pdf') {
          const pdfOcr = await extractTextFromPdfBufferWithVision({
            pdfBuffer: req.file.buffer,
          });
          if (Array.isArray(pdfOcr.warnings) && pdfOcr.warnings.length) {
            importData.extractionErrors.push(...pdfOcr.warnings);
          }
          if (typeof pdfOcr.text === 'string' && pdfOcr.text.trim().length > 0) {
            text = pdfOcr.text;
            hasText = true;
          }
        }
      }

      if (!hasText && !hasStructuredRows && Array.isArray(importData.extractedArtifacts) && importData.extractedArtifacts.length) {
        const imageOcr = await extractTextFromImageArtifacts({
          artifacts: importData.extractedArtifacts,
        });
        if (Array.isArray(imageOcr.warnings) && imageOcr.warnings.length) {
          importData.extractionErrors.push(...imageOcr.warnings);
        }
        if (typeof imageOcr.text === 'string' && imageOcr.text.trim().length > 0) {
          text = imageOcr.text;
          hasText = true;
        }
      }

      if (!hasText && !hasStructuredRows) {
        return res.status(400).json({
          error:
            'No extractable content found in the uploaded file. OCR fallback also could not extract readable text.',
          importReport: {
            extractionErrors: Array.isArray(importData.extractionErrors)
              ? importData.extractionErrors
              : [],
          },
        });
      }

      const questions = await extractQuestionsFromContent({
        content: text,
        structuredRows,
        filename: req.file.originalname,
      });

      const imageAttachmentResult = await attachImagesToImportedQuestions({
        questions: Array.isArray(questions) ? questions : [],
        structuredRows,
        extractedArtifacts: importData.extractedArtifacts,
        rowImageReferences: importData.rowImageReferences,
        rowEmbeddedArtifacts: importData.rowEmbeddedArtifacts,
        extractionErrors: importData.extractionErrors,
        importSessionId: importData.importSessionId,
      });

      if (Array.isArray(imageAttachmentResult?.report?.extractionErrors) && imageAttachmentResult.report.extractionErrors.length) {
        console.warn(
          '[import-questions] completed with extraction warnings:',
          imageAttachmentResult.report.extractionErrors
        );
      }

      res.json({
        questions: Array.isArray(imageAttachmentResult?.questions)
          ? imageAttachmentResult.questions.map((question) => {
              const questionFormat =
                normalizeQuestionFormat({
                  ...question,
                  questionText: question?.questionText || question?.question_text || '',
                }) || '';

              return {
                ...question,
                questionFormat,
                question_type: questionFormat,
              };
            })
          : [],
        importReport: imageAttachmentResult?.report || {},
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      next(error);
    }
  }
);

router.post(
  '/generate-questions',
  aiRateLimiter, // Rate limit AI operations
  requireAuth,
  requireTenant,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can generate questions
  [
    body('topic').trim().notEmpty().withMessage('Topic/Domain is required'), // Universal: clarified as Topic/Domain
    body('count').isInt({ min: 5, max: 50 }).withMessage('Count must be between 5 and 50'),
    body('difficulty').isIn(['easy', 'medium', 'hard', 'ultra_hard']).withMessage('Invalid difficulty'),
    body('questionTypes').isArray().withMessage('Question types must be an array'),
    body('enableImageQuestions').optional().isBoolean().withMessage('enableImageQuestions must be boolean'),
    body('imageQuestionCount').optional().isInt({ min: 0, max: 50 }).withMessage('imageQuestionCount must be between 0 and 50'),
    body('imageQuestionRatio').optional().isFloat({ min: 0, max: 100 }).withMessage('imageQuestionRatio must be between 0 and 100'),
    body('imageQuestionPerCount').optional().isInt({ min: 1, max: 50 }).withMessage('imageQuestionPerCount must be between 1 and 50'),
    body('imageQuestionsPerImage').optional().isInt({ min: 1, max: 50 }).withMessage('imageQuestionsPerImage must be between 1 and 50'),
    body('questionsPerParagraph').optional().isInt({ min: 1, max: 50 }).withMessage('questionsPerParagraph must be between 1 and 50'),
    body('scenarioQuestionTypes').optional().isArray().withMessage('scenarioQuestionTypes must be an array'),
    body('imageQuestionMode').optional().isIn(['percentage', 'per_count']).withMessage('Invalid imageQuestionMode'),
    body('imageQuestionTypes').optional().isArray().withMessage('imageQuestionTypes must be an array'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        topic,
        count,
        difficulty,
        questionTypes,
        questionTypeDistribution, // NEW: Array of { type, count } objects for specific distribution
        duration,
        uploadedContent,
        examTitle,
        examDescription,
        existingQuestions, // Array of existing question texts to avoid duplicates
        enableImageQuestions,
        imageQuestionCount,
        imageQuestionRatio,
        imageQuestionPerCount,
        imageQuestionsPerImage,
        questionsPerParagraph,
        scenarioQuestionTypes,
        imageQuestionMode,
        imageQuestionTypes,
      } = req.body;

      // Store tenant metadata for AI generation tracking
      const aiMetadata = {
        tenantId: req.user.tenantId || null,
        inputSource: uploadedContent ? 'DETAILED_CONTENT' : 'TOPIC_ONLY',
        generatedBy: req.user._id,
        generatedAt: new Date(),
      };

      const questions = await generateQuestions({
        topic,
        count,
        difficulty,
        questionTypes,
        questionTypeDistribution: Array.isArray(questionTypeDistribution) ? questionTypeDistribution : undefined,
        duration,
        uploadedContent,
        examTitle,
        examDescription,
        existingQuestions: Array.isArray(existingQuestions) ? existingQuestions : [],
        enableImageQuestions: enableImageQuestions === true,
        imageQuestionCount,
        imageQuestionRatio,
        imageQuestionPerCount,
        imageQuestionsPerImage,
        questionsPerParagraph,
        scenarioQuestionTypes: Array.isArray(scenarioQuestionTypes) ? scenarioQuestionTypes : undefined,
        imageQuestionMode,
        imageQuestionTypes: Array.isArray(imageQuestionTypes) ? imageQuestionTypes : [],
        metadata: aiMetadata, // Pass metadata to AI service for logging
      });

      res.json({ 
        questions,
        metadata: aiMetadata, // Return metadata for frontend to store with exam
      });
    } catch (error) {
      next(error);
    }
  }
);

// Generate answer key from uploaded file using AI
router.post(
  '/generate-answer-key',
  aiRateLimiter,
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  imageUpload.single('file'),
  handleMulterUploadError,
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const fileExtension = path.extname(req.file.originalname || '').toLowerCase();
      let extractedContent = '';
      let structuredRows = null;

      // Handle different file types
      if (fileExtension === '.pdf') {
        const result = await pdfParse(req.file.buffer);
        extractedContent = result.text || '';
      } else if (['.xlsx', '.xls'].includes(fileExtension)) {
        const rows = await readXlsxFile(req.file.buffer);
        if (Array.isArray(rows) && rows.length > 0) {
          const headers = rows[0].map((header, idx) => {
            if (header === undefined || header === null || header === '') {
              return `Column${idx + 1}`;
            }
            return String(header).trim();
          });
          structuredRows = rows.slice(1).map((row) => {
            const obj = {};
            headers.forEach((header, idx) => {
              const value = row[idx];
              obj[header] = value === undefined || value === null ? '' : String(value);
            });
            return obj;
          });
          extractedContent = rows
            .map((row) => row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))).join(','))
            .join('\n');
        }
      } else if (['.jpg', '.jpeg', '.png'].includes(fileExtension)) {
        // For images, we'll use OpenAI Vision API if available
        // Otherwise, return error suggesting to convert to PDF
        if (!config.openaiApiKey) {
          return res.status(400).json({ 
            error: 'Image OCR requires OpenAI API key. Please convert image to PDF or use Excel format.' 
          });
        }

        const client = new OpenAI({ apiKey: config.openaiApiKey });
        
        // Convert image buffer to base64
        const base64Image = req.file.buffer.toString('base64');
        const mimeType = fileExtension === '.png' ? 'image/png' : 'image/jpeg';
        
        try {
          const response = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Extract all text content from this image. If this is an answer key or exam paper, extract all questions and their correct answers. Return the text in a structured format.',
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${mimeType};base64,${base64Image}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 4000,
          });
          
          extractedContent = response.choices[0].message.content || '';
        } catch (visionError) {
          console.error('OpenAI Vision API error:', visionError);
          return res.status(500).json({ 
            error: 'Failed to process image. Please convert image to PDF or use Excel format.' 
          });
        }
      } else {
        return res.status(400).json({ error: 'Unsupported file type' });
      }

      if (!extractedContent.trim() && !structuredRows) {
        return res.status(400).json({ error: 'No content extracted from file' });
      }

      // Use AI to extract answer key from content
      const systemPrompt = `You are an expert at extracting answer keys from exam papers and documents. 
Extract all questions and their correct answers from the provided content.
Return a JSON object with an "answers" object where keys are question numbers (q1, q2, q3, etc.) and values contain:
- questionText: The question text
- correctAnswer: The correct answer (string or array for multiple correct answers)
- points: Points for this question (default 1)

Format: { "answers": { "q1": { "questionText": "...", "correctAnswer": "...", "points": 1 }, ... } }`;

      const userPrompt = `Extract the answer key from the following content:\n\n${extractedContent.substring(0, 15000)}`;

      if (!config.openaiApiKey) {
        return res.status(500).json({ 
          error: 'OpenAI API key not configured. Cannot generate answer key.' 
        });
      }

      const client = new OpenAI({ apiKey: config.openaiApiKey });

      try {
        const completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });

        const responseContent = completion.choices[0].message.content;
        let parsedResponse;

        try {
          parsedResponse = JSON.parse(responseContent);
        } catch (parseError) {
          const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
          if (jsonMatch) {
            parsedResponse = JSON.parse(jsonMatch[1]);
          } else {
            throw new Error('Failed to parse AI response as JSON');
          }
        }

        // Extract answers
        const answers = parsedResponse.answers || parsedResponse || {};

        // Validate and normalize answers
        const normalizedAnswers = {};
        Object.entries(answers).forEach(([key, value]) => {
          if (value && typeof value === 'object') {
            normalizedAnswers[key] = {
              questionText: String(value.questionText || '').trim(),
              correctAnswer: Array.isArray(value.correctAnswer) 
                ? value.correctAnswer 
                : String(value.correctAnswer || '').trim(),
              points: Number.isFinite(Number(value.points)) ? Number(value.points) : 1,
            };
          }
        });

        if (Object.keys(normalizedAnswers).length === 0) {
          return res.status(400).json({ error: 'No answer key found in the uploaded file' });
        }

        res.json({
          answerKey: {
            answers: normalizedAnswers,
            source: req.file.originalname,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (aiError) {
        console.error('AI answer key generation error:', aiError);
        return res.status(500).json({ 
          error: `Failed to generate answer key: ${aiError.message}` 
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;

