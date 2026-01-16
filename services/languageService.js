/**
 * Language Service
 * Handles language CRUD operations, translation management, and default language handling
 */

import Language from '../models/Language.js';
import Exam from '../models/Exam.js';
import Question from '../models/Question.js';

/**
 * Default languages to seed if database is empty
 */
const DEFAULT_LANGUAGES = [
  { code: 'EN', name: 'English', nativeName: 'English', isDefault: true },
  { code: 'HI', name: 'Hindi', nativeName: 'हिन्दी', isDefault: false },
  { code: 'MR', name: 'Marathi', nativeName: 'मराठी', isDefault: false },
  { code: 'GU', name: 'Gujarati', nativeName: 'ગુજરાતી', isDefault: false },
  { code: 'TA', name: 'Tamil', nativeName: 'தமிழ்', isDefault: false },
  { code: 'TE', name: 'Telugu', nativeName: 'తెలుగు', isDefault: false },
  { code: 'KN', name: 'Kannada', nativeName: 'ಕನ್ನಡ', isDefault: false },
  { code: 'ML', name: 'Malayalam', nativeName: 'മലയാളം', isDefault: false },
  { code: 'BN', name: 'Bengali', nativeName: 'বাংলা', isDefault: false },
  { code: 'UR', name: 'Urdu', nativeName: 'اردو', isDefault: false },
];

/**
 * Seed default languages if none exist
 */
const seedDefaultLanguages = async () => {
  try {
    const existingCount = await Language.countDocuments({ isActive: true });
    
    if (existingCount === 0) {
      console.log('No languages found. Seeding default languages...');
      
      for (const langData of DEFAULT_LANGUAGES) {
        try {
          const existing = await Language.findOne({ code: langData.code });
          if (!existing) {
            const language = new Language({
              ...langData,
              isActive: true,
            });
            await language.save();
            console.log(`  ✓ Created language: ${langData.name} (${langData.code})`);
          }
        } catch (error) {
          // Skip if language already exists (race condition)
          if (error.code !== 11000) {
            console.error(`  ✗ Error creating language ${langData.code}:`, error.message);
          }
        }
      }
      
      console.log('Default languages seeded successfully.');
    }
  } catch (error) {
    console.error('Error seeding default languages:', error);
  }
};

/**
 * Get all active languages
 * Auto-seeds default languages if database is empty
 */
export const getAllLanguages = async (includeInactive = false) => {
  // Ensure default languages exist
  await seedDefaultLanguages();
  
  const query = includeInactive ? {} : { isActive: true };
  return await Language.find(query).sort({ name: 1 });
};

/**
 * Get language by code
 */
export const getLanguageByCode = async (code) => {
  return await Language.findOne({ code: code.toUpperCase() });
};

/**
 * Get default language
 */
export const getDefaultLanguage = async () => {
  let defaultLang = await Language.findOne({ isDefault: true, isActive: true });
  
  if (!defaultLang) {
    // Fallback to English
    defaultLang = await Language.findOne({ code: 'EN' });
    
    if (!defaultLang) {
      // Create default English if it doesn't exist
      defaultLang = new Language({
        code: 'EN',
        name: 'English',
        nativeName: 'English',
        isActive: true,
        isDefault: true,
      });
      await defaultLang.save();
    } else {
      defaultLang.isDefault = true;
      await defaultLang.save();
    }
  }
  
  return defaultLang;
};

/**
 * Create a new language
 */
export const createLanguage = async (languageData) => {
  const { code, name, nativeName, isActive = true, isDefault = false } = languageData;
  
  // If setting as default, unset other defaults
  if (isDefault) {
    await Language.updateMany({}, { $set: { isDefault: false } });
  }
  
  const language = new Language({
    code: code.toUpperCase(),
    name,
    nativeName: nativeName || name,
    isActive,
    isDefault,
  });
  
  return await language.save();
};

/**
 * Update language
 */
export const updateLanguage = async (languageId, updateData) => {
  const language = await Language.findById(languageId);
  if (!language) {
    throw new Error('Language not found');
  }
  
  // If setting as default, unset other defaults
  if (updateData.isDefault === true) {
    await Language.updateMany({ _id: { $ne: languageId } }, { $set: { isDefault: false } });
  }
  
  if (updateData.code) {
    updateData.code = updateData.code.toUpperCase();
  }
  
  Object.assign(language, updateData);
  return await language.save();
};

/**
 * Delete language (soft delete by setting isActive to false)
 */
export const deleteLanguage = async (languageId) => {
  const language = await Language.findById(languageId);
  if (!language) {
    throw new Error('Language not found');
  }
  
  // Don't allow deleting default language
  if (language.isDefault) {
    throw new Error('Cannot delete default language');
  }
  
  language.isActive = false;
  return await language.save();
};

/**
 * Add translation to a question
 */
export const addQuestionTranslation = async (questionId, languageCode, translationData) => {
  const question = await Question.findById(questionId);
  if (!question) {
    throw new Error('Question not found');
  }
  
  if (!question.translations) {
    question.translations = new Map();
  }
  
  question.translations.set(languageCode.toUpperCase(), {
    questionText: translationData.questionText || '',
    options: translationData.options || question.options,
    passage: translationData.passage || '',
  });
  
  return await question.save();
};

/**
 * Get question translation
 */
export const getQuestionTranslation = async (questionId, languageCode) => {
  const question = await Question.findById(questionId);
  if (!question) {
    throw new Error('Question not found');
  }
  
  if (!question.translations || question.translations.size === 0) {
    // Return default language data
    return {
      questionText: question.questionText,
      options: question.options,
      passage: question.passage || '',
    };
  }
  
  const translation = question.translations.get(languageCode.toUpperCase());
  if (translation) {
    return translation;
  }
  
  // Fallback to default language
  const defaultLang = await getDefaultLanguage();
  const defaultTranslation = question.translations.get(defaultLang.code);
  
  if (defaultTranslation) {
    return defaultTranslation;
  }
  
  // Final fallback to original question data
  return {
    questionText: question.questionText,
    options: question.options,
    passage: question.passage || '',
  };
};

/**
 * Remove translation from question
 */
export const removeQuestionTranslation = async (questionId, languageCode) => {
  const question = await Question.findById(questionId);
  if (!question) {
    throw new Error('Question not found');
  }
  
  if (question.translations) {
    question.translations.delete(languageCode.toUpperCase());
    return await question.save();
  }
  
  return question;
};

/**
 * Get exam's supported languages
 */
export const getExamLanguages = async (examId) => {
  const exam = await Exam.findById(examId);
  if (!exam) {
    throw new Error('Exam not found');
  }
  
  const languages = await Language.find({
    code: { $in: exam.supportedLanguages || ['en'] },
    isActive: true,
  }).sort({ name: 1 });
  
  return {
    languages,
    defaultLanguage: exam.defaultLanguage || 'en',
    allowMultiLanguage: exam.allowMultiLanguage || false,
  };
};

/**
 * Update exam languages
 */
export const updateExamLanguages = async (examId, languageData) => {
  const exam = await Exam.findById(examId);
  if (!exam) {
    throw new Error('Exam not found');
  }
  
  if (languageData.supportedLanguages) {
    exam.supportedLanguages = languageData.supportedLanguages.map(code => code.toUpperCase());
  }
  
  if (languageData.defaultLanguage) {
    exam.defaultLanguage = languageData.defaultLanguage.toLowerCase();
  }
  
  if (languageData.allowMultiLanguage !== undefined) {
    exam.allowMultiLanguage = languageData.allowMultiLanguage;
  }
  
  return await exam.save();
};
