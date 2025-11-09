import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import config from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '..', config.uploadDir);
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

// Configure multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const docUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, TXT, and DOC files are allowed.'));
    }
  },
});

// Upload and extract text content
router.post(
  '/content',
  requireAuth,
  requireRole('DESIGNER', 'ADMIN'),
  docUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const fileExtension = path.extname(req.file.originalname).toLowerCase();

      let extractedText = '';

      try {
        if (fileExtension === '.txt') {
          // Read text file
          extractedText = await fs.readFile(filePath, 'utf-8');
        } else if (fileExtension === '.pdf') {
          // For PDF, you would need a library like pdf-parse
          // For now, return a placeholder
          extractedText = '[PDF content extraction requires pdf-parse library]';
        } else {
          // For DOC/DOCX, you would need a library like mammoth or docx
          extractedText = '[DOC content extraction requires additional library]';
        }

        // Clean up file after extraction
        await fs.unlink(filePath);

        res.json({
          success: true,
          extractedText,
          fileName: req.file.originalname,
        });
      } catch (error) {
        // Clean up file on error
        try {
          await fs.unlink(filePath);
        } catch (unlinkError) {
          console.error('Error deleting file:', unlinkError);
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  }
);

const imageUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only image files are allowed.'));
    }
  },
});

const buildPublicUrl = (req, filename) => {
  const configured = (config.assetBaseUrl || '').trim();
  const sanitizeBase = (base) => base.replace(/\/$/, '');

  let base = configured ? sanitizeBase(configured) : '';

  if (!base) {
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0];
    const protocol = forwardedProto || req.protocol || 'http';
    const host = req.get('host');
    if (host) {
      base = sanitizeBase(`${protocol}://${host}`);
    }
  }

  if (!base) {
    return `/uploads/${filename}`;
  }

  return `${base}/uploads/${filename}`;
};

router.post(
  '/image',
  requireAuth,
  requireRole('DESIGNER', 'ADMIN'),
  imageUpload.single('image'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const fileName = req.file.filename;
      const fileUrl = buildPublicUrl(req, fileName);

      res.json({
        success: true,
        url: fileUrl,
        fileName: req.file.originalname,
        storedFileName: fileName,
        mimeType: req.file.mimetype,
        size: req.file.size,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

