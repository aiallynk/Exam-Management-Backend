/**
 * Answer Key Service
 * Handles answer key import (PDF, Excel, Image with OCR), mapping, and mismatch detection
 */

import AnswerKey from '../models/AnswerKey.js';
import Question from '../models/Question.js';
import Exam from '../models/Exam.js';
import { syncExamQuestionCount } from '../utils/planUsage.js';
import { extractQuestionsFromContent } from './aiService.js';
import pdfParse from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';
import { parse as parseCsv } from 'csv-parse/sync';

/**
 * Get answer key for exam/question paper
 */
export const getAnswerKey = async (examId, questionPaperId = null) => {
  const query = { examId, isActive: true };
  if (questionPaperId) {
    query.questionPaperId = questionPaperId;
  }
  
  return await AnswerKey.findOne(query).sort({ version: -1 });
};

/**
 * Get all answer keys for exam
 */
export const getAllAnswerKeys = async (examId) => {
  return await AnswerKey.find({ examId, isActive: true }).sort({ version: -1 });
};

/**
 * Create manual answer key
 */
export const createManualAnswerKey = async (answerKeyData, userId) => {
  const { examId, questionPaperId, answers, notes } = answerKeyData;
  
  // Get latest version
  const latest = await AnswerKey.findOne({ examId, questionPaperId })
    .sort({ version: -1 });
  const version = latest ? latest.version + 1 : 1;
  
  const answerKey = new AnswerKey({
    examId,
    questionPaperId,
    version,
    answers: new Map(Object.entries(answers || {})),
    source: 'MANUAL',
    importedBy: userId,
    notes: notes || '',
    isActive: true,
  });
  
  return await answerKey.save();
};

/**
 * Parse PDF answer key
 */
const parsePDFAnswerKey = async (fileBuffer) => {
  try {
    const data = await pdfParse(fileBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`Failed to parse PDF: ${error.message}`);
  }
};

/**
 * Parse Excel answer key
 */
const parseExcelAnswerKey = async (fileBuffer) => {
  try {
    const rows = await readXlsxFile(fileBuffer);
    return rows;
  } catch (error) {
    throw new Error(`Failed to parse Excel: ${error.message}`);
  }
};

/**
 * Parse CSV answer key
 */
const parseCSVAnswerKey = async (fileBuffer) => {
  try {
    const text = fileBuffer.toString('utf-8');
    const rows = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
    });
    return rows;
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }
};

/**
 * Extract answers from structured data (Excel/CSV rows)
 */
const extractAnswersFromRows = (rows) => {
  const answers = {};
  
  for (const row of rows) {
    // Try to find question identifier (questionId, questionNumber, order, etc.)
    const questionId = row.questionId || row.question_id || row.id;
    const questionNumber = row.questionNumber || row.question_number || row.order || row.number;
    
    if (!questionId && !questionNumber) {
      continue; // Skip rows without question identifier
    }
    
    const key = questionId || `q${questionNumber}`;
    const correctAnswer = row.correctAnswer || row.correct_answer || row.answer || row.correct;
    const points = parseFloat(row.points || row.point || 1);
    const explanation = row.explanation || row.explanation_text || '';
    
    if (correctAnswer !== undefined && correctAnswer !== null && correctAnswer !== '') {
      answers[key] = {
        correctAnswer,
        points: isNaN(points) ? 1 : points,
        explanation,
      };
    }
  }
  
  return answers;
};

/**
 * Extract answers from text (PDF/OCR)
 */
const extractAnswersFromText = async (text, { tenantId = null, userId = null } = {}) => {
  try {
    // Use AI service to extract structured answers
    const extracted = await extractQuestionsFromContent({
      content: text,
      filename: 'answer_key',
      tenantId,
      userId,
      metadata: {
        tenantId,
        userId,
      },
    });
    
    // Convert extracted questions to answer key format
    const answers = {};
    const extractedQuestions = Array.isArray(extracted)
      ? extracted
      : Array.isArray(extracted?.questions)
        ? extracted.questions
        : [];
    if (extractedQuestions.length) {
      extractedQuestions.forEach((q, index) => {
        if (q.correctAnswer) {
          answers[`q${index + 1}`] = {
            correctAnswer: q.correctAnswer,
            points: q.points || 1,
            explanation: q.explanation || '',
          };
        }
      });
    }
    
    return answers;
  } catch (error) {
    throw new Error(`Failed to extract answers from text: ${error.message}`);
  }
};

/**
 * Map answer key to questions
 */
export const mapAnswerKeyToQuestions = async (examId, questionPaperId, answers) => {
  const questions = await Question.find({ questionPaperId }).sort({ order: 1 });
  const mappings = [];
  const mismatches = [];
  
  // Try to match answers to questions
  for (const question of questions) {
    let matched = false;
    
    // Try direct ID match
    if (answers[question._id.toString()]) {
      mappings.push({
        questionId: question._id,
        questionOrder: question.order,
        answer: answers[question._id.toString()],
        matchType: 'id',
      });
      matched = true;
    }
    // Try order-based match
    else if (answers[`q${question.order}`] || answers[question.order.toString()]) {
      const answer = answers[`q${question.order}`] || answers[question.order.toString()];
      mappings.push({
        questionId: question._id,
        questionOrder: question.order,
        answer,
        matchType: 'order',
      });
      matched = true;
    }
    // Try text-based match (fuzzy)
    else {
      const questionText = question.questionText.toLowerCase().substring(0, 50);
      for (const [key, answer] of Object.entries(answers)) {
        // Simple text matching (can be enhanced with fuzzy matching)
        if (key.toLowerCase().includes(questionText) || questionText.includes(key.toLowerCase())) {
          mappings.push({
            questionId: question._id,
            questionOrder: question.order,
            answer,
            matchType: 'text',
          });
          matched = true;
          break;
        }
      }
    }
    
    if (!matched) {
      mismatches.push({
        questionId: question._id,
        questionOrder: question.order,
        questionText: question.questionText.substring(0, 100),
      });
    }
  }
  
  return {
    mappings,
    mismatches,
    totalQuestions: questions.length,
    matchedQuestions: mappings.length,
    unmatchedQuestions: mismatches.length,
  };
};

/**
 * Import answer key from file
 */
export const importAnswerKey = async (examId, questionPaperId, file, source, userId) => {
  const fileBuffer = file.buffer || Buffer.from(file);
  const fileName = file.originalname || 'answer_key';
  const fileExtension = fileName.toLowerCase().split('.').pop();
  
  let answers = {};
  let extractedData = null;
  const exam = await Exam.findById(examId).select('tenantId').lean();
  const trackingTenantId = exam?.tenantId || null;
  
  try {
    if (['xlsx', 'xls'].includes(fileExtension)) {
      // Excel import
      const rows = await parseExcelAnswerKey(fileBuffer);
      answers = extractAnswersFromRows(rows);
      extractedData = { rows, type: 'excel' };
    } else if (fileExtension === 'csv') {
      // CSV import
      const rows = await parseCSVAnswerKey(fileBuffer);
      answers = extractAnswersFromRows(rows);
      extractedData = { rows, type: 'csv' };
    } else if (fileExtension === 'pdf') {
      // PDF import
      const text = await parsePDFAnswerKey(fileBuffer);
      answers = await extractAnswersFromText(text, {
        tenantId: trackingTenantId,
        userId,
      });
      extractedData = { text, type: 'pdf' };
    } else if (['jpg', 'jpeg', 'png'].includes(fileExtension)) {
      // Image import (OCR via AI service)
      // For now, we'll need to convert image to text first
      // This would require additional OCR library or AI vision API
      throw new Error('Image OCR import not yet implemented. Please convert image to PDF first.');
    } else {
      throw new Error(`Unsupported file format: ${fileExtension}`);
    }
    
    if (Object.keys(answers).length === 0) {
      throw new Error('No answers found in the uploaded file');
    }
    
    // Map to questions
    const mapping = await mapAnswerKeyToQuestions(examId, questionPaperId, answers);
    
    // Get latest version
    const latest = await AnswerKey.findOne({ examId, questionPaperId })
      .sort({ version: -1 });
    const version = latest ? latest.version + 1 : 1;
    
    // Create answer key
    const answerKey = new AnswerKey({
      examId,
      questionPaperId,
      version,
      answers: new Map(Object.entries(answers)),
      source: source.toUpperCase(),
      importedAt: new Date(),
      importedBy: userId,
      isActive: true,
    });
    
    await answerKey.save();
    
    return {
      answerKey,
      mapping,
      extractedData,
    };
  } catch (error) {
    throw new Error(`Failed to import answer key: ${error.message}`);
  }
};

/**
 * Compare answer key with existing question correct answers
 */
export const detectMismatches = async (answerKeyId) => {
  const answerKey = await AnswerKey.findById(answerKeyId);
  if (!answerKey) {
    throw new Error('Answer key not found');
  }
  
  const questions = await Question.find({
    questionPaperId: answerKey.questionPaperId,
  });
  
  const mismatches = [];
  
  for (const question of questions) {
    const answerKeyAnswer = answerKey.answers.get(question._id.toString());
    
    if (answerKeyAnswer) {
      const existingAnswer = question.correctAnswer;
      const keyAnswer = answerKeyAnswer.correctAnswer;
      
      // Compare answers (handle different formats)
      const normalizedExisting = String(existingAnswer || '').trim().toLowerCase();
      const normalizedKey = String(keyAnswer || '').trim().toLowerCase();
      
      if (normalizedExisting !== normalizedKey) {
        mismatches.push({
          questionId: question._id,
          questionOrder: question.order,
          questionText: question.questionText.substring(0, 100),
          existingAnswer,
          keyAnswer,
          points: question.points,
          keyPoints: answerKeyAnswer.points,
        });
      }
    }
  }
  
  return {
    totalQuestions: questions.length,
    matchedQuestions: questions.length - mismatches.length,
    mismatches,
  };
};

/**
 * Apply answer key to questions (update correctAnswer)
 */
export const applyAnswerKey = async (answerKeyId, questionIds = null) => {
  const answerKey = await AnswerKey.findById(answerKeyId);
  if (!answerKey) {
    throw new Error('Answer key not found');
  }
  
  const query = { questionPaperId: answerKey.questionPaperId };
  if (questionIds && questionIds.length > 0) {
    query._id = { $in: questionIds };
  }
  
  const questions = await Question.find(query);
  let updated = 0;
  
  for (const question of questions) {
    const answerKeyAnswer = answerKey.answers.get(question._id.toString());
    
    if (answerKeyAnswer) {
      question.correctAnswer = answerKeyAnswer.correctAnswer;
      if (answerKeyAnswer.points) {
        question.points = answerKeyAnswer.points;
      }
      await question.save();
      updated++;
    }
  }

  if (updated > 0 && answerKey.examId) {
    // Applying the key can change Question.points — keep the exam's cached
    // question count / total marks in sync (previously this went stale).
    await syncExamQuestionCount(answerKey.examId);
  }

  return {
    totalQuestions: questions.length,
    updated,
  };
};
