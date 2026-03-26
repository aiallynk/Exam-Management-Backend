import { parse } from 'csv-parse/sync';

export const parseCSV = (csvContent) => {
  try {
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    return records;
  } catch (error) {
    throw new Error(`CSV parsing error: ${error.message}`);
  }
};

export const validateQuestionCSV = (records) => {
  const requiredFields = ['questionText', 'questionType'];
  const errors = [];

  records.forEach((record, index) => {
    requiredFields.forEach((field) => {
      if (!record[field]) {
        errors.push(`Row ${index + 2}: Missing required field "${field}"`);
      }
    });

    const validTypes = [
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
      'CODING',
      'IMAGE_BASED',
    ];

    const normalizedType = String(record.questionType || '').trim().toUpperCase();
    if (normalizedType && !validTypes.includes(normalizedType)) {
      errors.push(
        `Row ${index + 2}: Invalid questionType "${record.questionType}"`
      );
    }
  });

  if (errors.length > 0) {
    throw new Error(`CSV validation errors:\n${errors.join('\n')}`);
  }

  return records;
};

