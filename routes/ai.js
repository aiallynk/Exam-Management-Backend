import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { requireTenant } from '../middleware/multiTenant.js';
import { generateQuestions, extractQuestionsFromContent } from '../services/aiService.js';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import path from 'path';
import pdfParse from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';
import { parse as parseCsv } from 'csv-parse/sync';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.txt', '.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, TXT, CSV, XLSX, XLS'));
    }
  },
});

const extractContentFromUploadedFile = async (file) => {
  const ext = path.extname(file.originalname || '').toLowerCase();

  if (ext === '.pdf') {
    const result = await pdfParse(file.buffer);
    return {
      text: result.text || '',
      structuredRows: null,
    };
  }

  if (ext === '.txt') {
    return {
      text: file.buffer.toString('utf-8'),
      structuredRows: null,
    };
  }

  if (ext === '.csv') {
    const text = file.buffer.toString('utf-8');
    let structuredRows = [];
    try {
      structuredRows = parseCsv(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (error) {
      const rows = parseCsv(text, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
      });
      if (rows.length > 1) {
        const headers = rows[0];
        structuredRows = rows.slice(1).map((row) => {
          const obj = {};
          headers.forEach((header, idx) => {
            const key = header || `Column${idx + 1}`;
            obj[key] = row[idx];
          });
          return obj;
        });
      }
    }
    return {
      text,
      structuredRows,
    };
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const rows = await readXlsxFile(file.buffer);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { text: '', structuredRows: [] };
    }

    const headers = rows[0].map((header, idx) => {
      if (header === undefined || header === null || header === '') {
        return `Column${idx + 1}`;
      }
      return String(header).trim();
    });

    const structuredRows = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, idx) => {
        const value = row[idx];
        obj[header] = value === undefined || value === null ? '' : String(value);
      });
      return obj;
    });

    const text = rows
      .map((row) => row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))).join(','))
      .join('\n');

    return { text, structuredRows };
  }

  throw new Error('Unsupported file type');
};

const router = express.Router();

// Generate questions using AI
router.post(
  '/import-questions',
  requireAuth,
  requireRole('DESIGNER', 'ADMIN', 'TEACHER', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { text, structuredRows } = await extractContentFromUploadedFile(req.file);
      const questions = await extractQuestionsFromContent({
        content: text,
        structuredRows,
        filename: req.file.originalname,
      });

      res.json({ questions });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/generate-questions',
  requireAuth,
  requireTenant,
  requireRole('DESIGNER', 'ADMIN', 'TEACHER', 'INSTITUTE_ADMIN', 'ORG_ADMIN'),
  [
    body('topic').trim().notEmpty().withMessage('Topic is required'),
    body('count').isInt({ min: 5, max: 50 }).withMessage('Count must be between 5 and 50'),
    body('difficulty').isIn(['easy', 'medium', 'hard', 'ultra_hard']).withMessage('Invalid difficulty'),
    body('questionTypes').isArray().withMessage('Question types must be an array'),
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
        duration,
        uploadedContent,
        examTitle,
        examDescription,
      } = req.body;

      // Store tenant metadata for AI generation tracking
      const aiMetadata = {
        organizationId: req.user.organizationId || null,
        instituteId: req.user.instituteId || null,
        inputSource: uploadedContent ? 'DETAILED_CONTENT' : 'TOPIC_ONLY',
        generatedBy: req.user._id,
        generatedAt: new Date(),
      };

      const questions = await generateQuestions({
        topic,
        count,
        difficulty,
        questionTypes,
        duration,
        uploadedContent,
        examTitle,
        examDescription,
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

export default router;

