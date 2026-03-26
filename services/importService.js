/**
 * Enhanced Import Service
 * Handles Excel import with strict validation, PDF parsing, image OCR,
 * preview generation, and error highlighting
 */

import { extractQuestionsFromContent } from './aiService.js';
import pdfParse from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';
import { parse as parseCsv } from 'csv-parse/sync';
import path from 'path';
import {
  normalizeQuestionCorrectAnswer,
  sanitizeQuestionOptions,
} from '../utils/questionOptionSanitizer.js';

const VALID_QUESTION_TYPES = [
  'MULTIPLE_CHOICE',
  'MULTIPLE_OPTIONS',
  'MULTI_SELECT_MCQ',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'PARAGRAPH',
  'ESSAY',
  'ESSAY_LETTER',
  'ESSAY_STORY',
  'NUMBER',
];

const REQUIRED_COLUMNS = ['questionText', 'questionType'];
const OPTIONAL_COLUMNS = ['options', 'correctAnswer', 'points', 'order', 'passage', 'sectionId'];

/**
 * Validate Excel/CSV row structure
 */
const validateRow = (row, index, headers) => {
  const errors = [];
  const warnings = [];
  
  // Check required columns
  if (!row.questionText || String(row.questionText).trim() === '') {
    errors.push(`Row ${index + 1}: questionText is required`);
  }
  
  if (!row.questionType || String(row.questionType).trim() === '') {
    errors.push(`Row ${index + 1}: questionType is required`);
  } else {
    const questionType = String(row.questionType).trim().toUpperCase();
    if (!VALID_QUESTION_TYPES.includes(questionType)) {
      errors.push(`Row ${index + 1}: Invalid questionType "${row.questionType}". Must be one of: ${VALID_QUESTION_TYPES.join(', ')}`);
    }
  }
  
  // Validate question type specific requirements
  if (row.questionType) {
    const questionType = String(row.questionType).trim().toUpperCase();
    
    if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType)) {
      if (!row.options || String(row.options).trim() === '') {
        warnings.push(`Row ${index + 1}: Options recommended for ${questionType} questions`);
      }
    }
    
    if (row.options) {
      try {
        const options = typeof row.options === 'string' 
          ? JSON.parse(row.options) 
          : row.options;
        if (!Array.isArray(options) || options.length === 0) {
          errors.push(`Row ${index + 1}: Options must be a non-empty array`);
        }
      } catch (e) {
        errors.push(`Row ${index + 1}: Invalid options format. Expected JSON array`);
      }
    }
  }
  
  // Validate points
  if (row.points !== undefined && row.points !== null && row.points !== '') {
    const points = parseFloat(row.points);
    if (isNaN(points) || points < 0) {
      errors.push(`Row ${index + 1}: Points must be a non-negative number`);
    }
  }
  
  // Validate order
  if (row.order !== undefined && row.order !== null && row.order !== '') {
    const order = parseInt(row.order);
    if (isNaN(order) || order < 0) {
      errors.push(`Row ${index + 1}: Order must be a non-negative integer`);
    }
  }
  
  return { errors, warnings };
};

/**
 * Normalize row data types
 */
const normalizeRow = (row, index) => {
  const normalized = { ...row };
  
  // Normalize questionText
  if (normalized.questionText) {
    normalized.questionText = String(normalized.questionText).trim();
  }
  
  // Normalize questionType
  if (normalized.questionType) {
    normalized.questionType = String(normalized.questionType).trim().toUpperCase();
  }
  
  // Normalize options
  if (normalized.options) {
    try {
      if (typeof normalized.options === 'string') {
        normalized.options = JSON.parse(normalized.options);
      }
      if (!Array.isArray(normalized.options)) {
        normalized.options = undefined;
      } else {
        normalized.options = sanitizeQuestionOptions(normalized.options);
      }
    } catch (e) {
      normalized.options = undefined;
    }
  }
  
  // Normalize correctAnswer
  if (normalized.correctAnswer !== undefined && normalized.correctAnswer !== null) {
    const resolvedAnswer = normalizeQuestionCorrectAnswer({
      questionType: normalized.questionType,
      correctAnswer: normalized.correctAnswer,
      options: normalized.options,
    });
    normalized.correctAnswer = Array.isArray(resolvedAnswer)
      ? JSON.stringify(resolvedAnswer)
      : String(resolvedAnswer).trim();
  }
  
  // Normalize points
  if (normalized.points !== undefined && normalized.points !== null && normalized.points !== '') {
    const points = parseFloat(normalized.points);
    normalized.points = isNaN(points) ? 1 : Math.max(0, points);
  } else {
    normalized.points = 1;
  }
  
  // Normalize order
  if (normalized.order !== undefined && normalized.order !== null && normalized.order !== '') {
    const order = parseInt(normalized.order);
    normalized.order = isNaN(order) ? index + 1 : Math.max(0, order);
  } else {
    normalized.order = index + 1;
  }
  
  // Normalize passage
  if (normalized.passage) {
    normalized.passage = String(normalized.passage).trim();
  }
  
  return normalized;
};

/**
 * Parse Excel file with validation
 */
export const parseExcelFile = async (fileBuffer, fileName) => {
  try {
    const rows = await readXlsxFile(fileBuffer);
    
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        success: false,
        error: 'Excel file is empty or invalid',
        preview: [],
        errors: [],
        warnings: [],
      };
    }
    
    // Extract headers
    const headers = rows[0].map((header, idx) => {
      if (header === undefined || header === null || header === '') {
        return `Column${idx + 1}`;
      }
      return String(header).trim();
    });
    
    // Convert to objects
    const dataRows = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, idx) => {
        const value = row[idx];
        obj[header] = value === undefined || value === null ? '' : String(value);
      });
      return obj;
    });
    
    // Validate and normalize
    const preview = [];
    const allErrors = [];
    const allWarnings = [];
    
    dataRows.forEach((row, index) => {
      const validation = validateRow(row, index, headers);
      const normalized = normalizeRow(row, index);
      
      preview.push({
        ...normalized,
        _rowIndex: index + 2, // Excel row number (1-based, +1 for header)
        _errors: validation.errors,
        _warnings: validation.warnings,
        _isValid: validation.errors.length === 0,
      });
      
      allErrors.push(...validation.errors.map(err => ({ row: index + 2, error: err })));
      allWarnings.push(...validation.warnings.map(warn => ({ row: index + 2, warning: warn })));
    });
    
    // Check for required columns
    const missingColumns = REQUIRED_COLUMNS.filter(col => !headers.includes(col));
    if (missingColumns.length > 0) {
      allErrors.push({
        row: 0,
        error: `Missing required columns: ${missingColumns.join(', ')}`,
      });
    }
    
    return {
      success: allErrors.length === 0,
      preview,
      errors: allErrors,
      warnings: allWarnings,
      totalRows: dataRows.length,
      validRows: preview.filter(p => p._isValid).length,
      invalidRows: preview.filter(p => !p._isValid).length,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse Excel file: ${error.message}`,
      preview: [],
      errors: [{ row: 0, error: error.message }],
      warnings: [],
    };
  }
};

/**
 * Parse CSV file with validation
 */
export const parseCSVFile = async (fileBuffer, fileName) => {
  try {
    const text = fileBuffer.toString('utf-8');
    
    let rows = [];
    try {
      rows = parseCsv(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (error) {
      // Try without headers
      const rawRows = parseCsv(text, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
      });
      
      if (rawRows.length > 1) {
        const headers = rawRows[0];
        rows = rawRows.slice(1).map((row) => {
          const obj = {};
          headers.forEach((header, idx) => {
            const key = header || `Column${idx + 1}`;
            obj[key] = row[idx] || '';
          });
          return obj;
        });
      }
    }
    
    if (rows.length === 0) {
      return {
        success: false,
        error: 'CSV file is empty or invalid',
        preview: [],
        errors: [],
        warnings: [],
      };
    }
    
    // Validate and normalize
    const preview = [];
    const allErrors = [];
    const allWarnings = [];
    
    rows.forEach((row, index) => {
      const validation = validateRow(row, index, Object.keys(row));
      const normalized = normalizeRow(row, index);
      
      preview.push({
        ...normalized,
        _rowIndex: index + 2, // CSV row number (1-based, +1 for header)
        _errors: validation.errors,
        _warnings: validation.warnings,
        _isValid: validation.errors.length === 0,
      });
      
      allErrors.push(...validation.errors.map(err => ({ row: index + 2, error: err })));
      allWarnings.push(...validation.warnings.map(warn => ({ row: index + 2, warning: warn })));
    });
    
    // Check for required columns
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const missingColumns = REQUIRED_COLUMNS.filter(col => !headers.includes(col));
    if (missingColumns.length > 0) {
      allErrors.push({
        row: 0,
        error: `Missing required columns: ${missingColumns.join(', ')}`,
      });
    }
    
    return {
      success: allErrors.length === 0,
      preview,
      errors: allErrors,
      warnings: allWarnings,
      totalRows: rows.length,
      validRows: preview.filter(p => p._isValid).length,
      invalidRows: preview.filter(p => !p._isValid).length,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse CSV file: ${error.message}`,
      preview: [],
      errors: [{ row: 0, error: error.message }],
      warnings: [],
    };
  }
};

/**
 * Parse PDF file
 */
export const parsePDFFile = async (
  fileBuffer,
  fileName,
  { tenantId = null, userId = null } = {}
) => {
  try {
    const data = await pdfParse(fileBuffer);
    const text = data.text || '';
    
    if (!text.trim()) {
      return {
        success: false,
        error: 'PDF file contains no extractable text',
        text: '',
        preview: [],
      };
    }
    
    // Extract questions using AI service
    try {
      const extracted = await extractQuestionsFromContent({
        content: text,
        structuredRows: null,
        filename: fileName,
        tenantId,
        userId,
        metadata: {
          tenantId,
          userId,
        },
      });

      const questions = Array.isArray(extracted)
        ? extracted
        : Array.isArray(extracted?.questions)
          ? extracted.questions
          : [];
      
      // Validate extracted questions
      const preview = questions.map((q, index) => {
        const row = {
          questionText: q.questionText || '',
          questionType: q.questionType || 'SHORT_ANSWER',
          options: q.options,
          correctAnswer: q.correctAnswer || '',
          points: q.points || 1,
          order: q.order || index + 1,
          passage: q.passage || '',
        };
        
        const validation = validateRow(row, index, []);
        return {
          ...normalizeRow(row, index),
          _rowIndex: index + 1,
          _errors: validation.errors,
          _warnings: validation.warnings,
          _isValid: validation.errors.length === 0,
        };
      });
      
      return {
        success: true,
        text,
        preview,
        totalQuestions: questions.length,
        validQuestions: preview.filter(p => p._isValid).length,
        invalidQuestions: preview.filter(p => !p._isValid).length,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to extract questions from PDF: ${error.message}`,
        text,
        preview: [],
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse PDF file: ${error.message}`,
      text: '',
      preview: [],
    };
  }
};

/**
 * Parse image file with OCR (placeholder - would need OCR library)
 */
export const parseImageFile = async (fileBuffer, fileName) => {
  // For now, return error - OCR would require additional library
  // In production, this would use Tesseract.js or similar
  return {
    success: false,
    error: 'Image OCR not yet implemented. Please convert image to PDF or use Excel/CSV format.',
    preview: [],
  };
};

/**
 * Generate import preview
 */
export const generateImportPreview = async (
  file,
  fileName,
  { tenantId = null, userId = null } = {}
) => {
  const fileExtension = path.extname(fileName || '').toLowerCase();
  const fileBuffer = file.buffer || Buffer.from(file);
  
  if (['.xlsx', '.xls'].includes(fileExtension)) {
    return await parseExcelFile(fileBuffer, fileName);
  } else if (fileExtension === '.csv') {
    return await parseCSVFile(fileBuffer, fileName);
  } else if (fileExtension === '.pdf') {
    return await parsePDFFile(fileBuffer, fileName, { tenantId, userId });
  } else if (['.jpg', '.jpeg', '.png'].includes(fileExtension)) {
    return await parseImageFile(fileBuffer, fileName);
  } else {
    return {
      success: false,
      error: `Unsupported file type: ${fileExtension}`,
      preview: [],
    };
  }
};

/**
 * Clean invalid rows from preview
 */
export const cleanInvalidRows = (preview) => {
  return preview.filter(row => row._isValid !== false);
};

/**
 * Get template structure for download
 */
export const getTemplateStructure = () => {
  return {
    version: '1.0',
    requiredColumns: REQUIRED_COLUMNS,
    optionalColumns: OPTIONAL_COLUMNS,
    validQuestionTypes: VALID_QUESTION_TYPES,
    sampleRow: {
      questionText: 'What is 2 + 2?',
      questionType: 'MULTIPLE_CHOICE',
      options: JSON.stringify(['2', '3', '4', '5']),
      correctAnswer: '4',
      points: 1,
      order: 1,
      passage: '',
      sectionId: '',
    },
  };
};
