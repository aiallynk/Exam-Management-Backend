import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import config from '../config/env.js';
import { generateImportPreview } from '../services/importService.js';
import { putImage } from '../services/storage/imageStorage.js';

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

// Allowed file extensions and their corresponding MIME types
const ALLOWED_DOC_EXTENSIONS = ['.pdf', '.txt', '.doc', '.docx'];
const ALLOWED_DOC_MIMETYPES = [
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

// Sanitize filename to prevent path traversal and other attacks
const sanitizeFilename = (filename) => {
  if (!filename || typeof filename !== 'string') {
    return 'file';
  }
  
  // Remove path components
  const basename = path.basename(filename);
  
  // Remove or replace dangerous characters
  const sanitized = basename
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace non-alphanumeric (except . _ -) with _
    .replace(/^\.+/, '') // Remove leading dots
    .replace(/\.{2,}/g, '.') // Replace multiple dots with single dot
    .substring(0, 255); // Limit length
  
  return sanitized || 'file';
};

const docUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1, // Only allow single file
  },
  fileFilter: (req, file, cb) => {
    if (!file || !file.originalname) {
      return cb(new Error('Invalid file'));
    }
    
    // Get file extension
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Validate extension
    if (!ALLOWED_DOC_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Invalid file extension. Allowed: ${ALLOWED_DOC_EXTENSIONS.join(', ')}`));
    }
    
    // Validate MIME type (but don't rely solely on it)
    if (!ALLOWED_DOC_MIMETYPES.includes(file.mimetype)) {
      // Warn but allow if extension is valid (mimetype can be spoofed)
      console.warn(`MIME type mismatch for file ${file.originalname}: ${file.mimetype}`);
    }
    
    // Sanitize filename
    file.originalname = sanitizeFilename(file.originalname);
    
    cb(null, true);
  },
});

// Error handler for multer errors
const handleMulterError = (err, req, res, next) => {
  if (err && err.code && err.code.startsWith('LIMIT_')) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB for documents, 5MB for images.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Only one file allowed per upload.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'File upload failed' });
  }
  next();
};

// Upload and extract text content
router.post(
  '/content',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'), // Only EXAM_CREATOR and TENANT_ADMIN can upload files
  docUpload.single('file'),
  handleMulterError,
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      
      // Additional validation: check file actually exists and has content
      try {
        const stats = await fs.stat(req.file.path);
        if (stats.size === 0) {
          await fs.unlink(req.file.path);
          return res.status(400).json({ error: 'Uploaded file is empty' });
        }
      } catch (statError) {
        return res.status(400).json({ error: 'Failed to validate uploaded file' });
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

// Allowed image extensions
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const ALLOWED_IMAGE_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
];

const createImageUploadMiddleware = () =>
  multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      files: 1, // Only allow single file
    },
    fileFilter: (req, file, cb) => {
      if (!file || !file.originalname) {
        return cb(new Error('Invalid file'));
      }
      
      // Get file extension
      const ext = path.extname(file.originalname).toLowerCase();
      
      // Validate extension
      if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
        return cb(new Error(`Invalid image extension. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`));
      }
      
      // Validate MIME type
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        // Check if it's in our allowed list
        if (!ALLOWED_IMAGE_MIMETYPES.includes(file.mimetype)) {
          console.warn(`MIME type mismatch for image ${file.originalname}: ${file.mimetype}`);
        }
      }
      
      // Sanitize filename
      file.originalname = sanitizeFilename(file.originalname);
      
      cb(null, true);
    },
  });

const imageUpload = createImageUploadMiddleware();
const legacyImageUpload = createImageUploadMiddleware();

const getUploadedImageFile = (req) =>
  req.file || req.files?.image?.[0] || req.files?.file?.[0] || null;

const handleImageUploadRequest = async (req, res, next) => {
  try {
    const uploadedFile = getUploadedImageFile(req);
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    if (!uploadedFile.buffer || !uploadedFile.buffer.length) {
      return res.status(400).json({ error: 'Uploaded image is empty' });
    }

    const sanitizedName = sanitizeFilename(uploadedFile.originalname);
    const extension = path.extname(sanitizedName) || '.png';
    const requestedExamId = String(req.body?.examId || '').trim();
    const examId = /^[a-fA-F0-9]{24}$/.test(requestedExamId) ? requestedExamId : undefined;

    const stored = await putImage({
      tenantId: req.user.tenantId,
      examId,
      category: 'misc',
      fileStem: path.parse(sanitizedName).name,
      extension,
      buffer: uploadedFile.buffer,
    });

    if (!stored) {
      return res.status(400).json({ error: 'Failed to store uploaded image' });
    }

    res.json({
      success: true,
      url: stored.url,
      fileName: uploadedFile.originalname,
      storedFileName: stored.key.split('/').pop(),
      mimeType: uploadedFile.mimetype,
      size: uploadedFile.size,
    });
  } catch (error) {
    next(error);
  }
};

router.post(
  '/',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  legacyImageUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  handleMulterError,
  handleImageUploadRequest
);

router.post(
  '/image',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  imageUpload.single('image'),
  handleMulterError,
  handleImageUploadRequest
);

// Import preview endpoint (for Excel, CSV, PDF, Image)
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExtensions = ['.csv', '.xlsx', '.xls', '.pdf', '.jpg', '.jpeg', '.png'];
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedExtensions.join(', ')}`));
    }
  },
});

router.post(
  '/import-preview',
  requireAuth,
  requireRole('EXAM_CREATOR', 'TENANT_ADMIN'),
  importUpload.single('file'),
  handleMulterError,
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const result = await generateImportPreview(req.file, req.file.originalname, {
        tenantId: req.user?.tenantId || null,
        userId: req.user?._id || null,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;

