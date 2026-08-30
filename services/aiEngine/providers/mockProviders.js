import { AI_OPERATIONS } from '../aiOperations.js';

export const createMockOpenAIProvider = () => ({
  id: 'mock_openai',
  supports: (operation) => [
    AI_OPERATIONS.QUESTION_GENERATION,
    AI_OPERATIONS.EMBEDDING,
    AI_OPERATIONS.QUESTION_CLASSIFICATION,
  ].includes(operation),
  getHealth: () => ({ configured: true, status: 'HEALTHY' }),
  async generateStructured({ operation }) {
    if (operation === AI_OPERATIONS.QUESTION_GENERATION) {
      return {
        provider: 'mock_openai',
        model: 'mock-question',
        operation,
        content: JSON.stringify({ questions: [{ questionText: 'Mock question?', questionType: 'MULTIPLE_CHOICE', options: ['A', 'B'], correctAnswer: 'A' }] }),
        parsed: { questions: [{ questionText: 'Mock question?', questionType: 'MULTIPLE_CHOICE', options: ['A', 'B'], correctAnswer: 'A' }] },
      };
    }
    return { provider: 'mock_openai', model: 'mock', operation, content: '{}', parsed: {} };
  },
  async generateText(params) {
    return this.generateStructured(params);
  },
  async embed({ texts }) {
    return {
      provider: 'mock_openai',
      model: 'mock-embedding',
      embeddings: (texts || []).map(() => [0.1, 0.2, 0.3]),
    };
  },
});

export const createMockGeminiProvider = () => ({
  id: 'mock_gemini',
  supports: (operation) => [
    AI_OPERATIONS.HANDWRITING_EXTRACTION,
    AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION,
    AI_OPERATIONS.DIAGRAM_RESPONSE_EVALUATION,
  ].includes(operation),
  getHealth: () => ({ configured: true, status: 'HEALTHY' }),
  async generateStructured({ operation }) {
    if (operation === AI_OPERATIONS.HANDWRITING_EXTRACTION) {
      return {
        provider: 'mock_gemini',
        model: 'mock-vision',
        operation,
        content: JSON.stringify({ isBlank: false, segments: [{ detectedQuestionNumber: '1', text: 'mock answer', confidence: 0.9 }], pageConfidence: 0.9 }),
        parsed: { isBlank: false, segments: [{ detectedQuestionNumber: '1', text: 'mock answer', confidence: 0.9 }], pageConfidence: 0.9 },
      };
    }
    if (operation === AI_OPERATIONS.ANSWER_RUBRIC_EVALUATION) {
      return {
        provider: 'mock_gemini',
        model: 'mock-eval',
        operation,
        content: JSON.stringify({
          criterionScores: [{ criterionId: 'c1', score: 2, maxScore: 3, reason: 'mock', confidence: 0.8 }],
          totalScore: 2,
          maxScore: 3,
          overallConfidence: 0.8,
          feedback: 'Mock feedback',
          reviewRequired: false,
        }),
        parsed: {
          criterionScores: [{ criterionId: 'c1', score: 2, maxScore: 3, reason: 'mock', confidence: 0.8 }],
          totalScore: 2,
          maxScore: 3,
          overallConfidence: 0.8,
          feedback: 'Mock feedback',
          reviewRequired: false,
        },
      };
    }
    return { provider: 'mock_gemini', model: 'mock', operation, content: '{}', parsed: {} };
  },
  async generateText(params) {
    return this.generateStructured(params);
  },
  async analyzeImages(params) {
    return this.generateStructured(params);
  },
});
