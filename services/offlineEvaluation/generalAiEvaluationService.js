import { executeAIOperation } from '../aiEngine/aiEngine.js';
import { AI_OPERATIONS } from '../aiEngine/aiOperations.js';

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const cleanText = (value, maximum = 1000) => String(value || '').trim().slice(0, maximum);
const cleanList = (value, maximum = 10, itemMaximum = 500) => (
  Array.isArray(value)
    ? value.map((item) => cleanText(item, itemMaximum)).filter(Boolean).slice(0, maximum)
    : []
);

const normalizeConfidence = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value, 0, 1);
  const label = String(value || 'MEDIUM').trim().toUpperCase();
  if (label === 'HIGH') return 0.9;
  if (label === 'LOW') return 0.45;
  return 0.7;
};

const confidenceLabel = (value) => {
  const numeric = normalizeConfidence(value);
  if (numeric >= 0.8) return 'HIGH';
  if (numeric < 0.6) return 'LOW';
  return 'MEDIUM';
};

const normalizeRequirements = (value) => (
  Array.isArray(value)
    ? value.slice(0, 12).map((item, index) => ({
      key: cleanText(item?.key || `requirement_${index + 1}`, 80),
      description: cleanText(item?.description, 600),
      status: ['MET', 'PARTIAL', 'MISSING', 'INCORRECT', 'NOT_APPLICABLE'].includes(String(item?.status || '').toUpperCase())
        ? String(item.status).toUpperCase()
        : 'PARTIAL',
    })).filter((item) => item.description)
    : []
);

const normalizeFindings = (value) => (
  Array.isArray(value)
    ? value.slice(0, 15).map((item) => ({
      type: ['CORRECT', 'INCORRECT', 'PARTIAL', 'MISSING', 'IRRELEVANT', 'UNCLEAR'].includes(String(item?.type || '').toUpperCase())
        ? String(item.type).toUpperCase()
        : 'UNCLEAR',
      description: cleanText(item?.description, 600),
      evidenceText: cleanText(item?.evidenceText, 500),
    })).filter((item) => item.description)
    : []
);

/**
 * General subjective scoring is intentionally separate from rubric scoring.
 * It uses the canonical text-evaluation operation and returns only a proposal;
 * callers are responsible for keeping it out of final-score fields.
 */
export const evaluateGeneralAnswer = async ({
  question,
  correctAnswer,
  studentAnswer,
  questionType,
  points,
  evaluationConfig = {},
  tenantId,
  userId,
  qualityTier = 'STANDARD',
  model,
}) => {
  const maxMarks = Math.max(Number(points) || 0, 0);
  const config = evaluationConfig && typeof evaluationConfig === 'object' ? evaluationConfig : {};
  const result = await executeAIOperation(
    AI_OPERATIONS.ANSWER_TEXT_EVALUATION,
    {
      request: {
        system: `You are an academic examiner preparing a PROVISIONAL recommendation for an authorized evaluator. There is no configured rubric for this question.

Evaluate meaning and concepts, never exact wording. First identify the explicit requirements in the question, including counts such as TWO reasons or THREE changes. Distinct valid points count once only; repeated points do not satisfy multiple requirements. Treat the expected answer and marking guidance as semantic guidance, not a string match. Assess factual correctness, completeness, relevance, and reasoning only when the question or guidance calls for it. Do not invent grammar, handwriting, presentation, or style criteria.

Return strict JSON only:
{
  "proposedScore": number,
  "maxMarks": number,
  "confidence": "HIGH|MEDIUM|LOW",
  "strengths": ["..."],
  "issues": ["..."],
  "requirements": [{"key":"requirement_1","description":"...","status":"MET|PARTIAL|MISSING|INCORRECT|NOT_APPLICABLE"}],
  "findings": [{"type":"CORRECT|INCORRECT|PARTIAL|MISSING|IRRELEVANT|UNCLEAR","description":"...","evidenceText":"..."}],
  "feedback": "..."
}`,
        user: `Question type: ${cleanText(questionType, 100)}
Question: ${cleanText(question, 12000)}
Maximum marks: ${maxMarks}
Expected answer / marking guidance: ${cleanText(correctAnswer || config.expectedAnswer || config.markingGuidance || '', 12000) || 'Not provided'}
Question-specific guidance: ${cleanText(config.markingGuidance || config.minimumAnswerRequirements || config.instructions || '', 8000) || 'Not provided'}
Assessment subject/context: ${cleanText(config.assessmentSubject || config.subject || config.supportingContext || config.passage || '', 8000) || 'Not provided'}
Grade/level: ${cleanText(config.gradeLevel || config.grade || config.level || '', 200) || 'Not provided'}
Student response: ${cleanText(studentAnswer, 16000)}
Quality tier: ${cleanText(qualityTier, 50)}`,
        response_format: { type: 'json_object' },
      },
    },
    { tenantId, userId, feature: 'evaluation', ...(model ? { model } : {}) },
  );

  const parsed = result?.parsed || {};
  const rawScore = Number(parsed.proposedScore);
  if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > maxMarks) {
    const error = new Error('The AI evaluation response did not contain a valid proposed score.');
    error.code = 'AI_OUTPUT_VALIDATION_FAILED';
    throw error;
  }

  const confidence = normalizeConfidence(parsed.confidence);
  return {
    proposedScore: Number(rawScore.toFixed(2)),
    maxMarks,
    confidence,
    confidenceLabel: confidenceLabel(parsed.confidence),
    strengths: cleanList(parsed.strengths),
    issues: cleanList(parsed.issues),
    requirements: normalizeRequirements(parsed.requirements),
    findings: normalizeFindings(parsed.findings),
    feedback: cleanText(parsed.feedback, 2000) || 'No feedback provided.',
    provider: result.provider,
    model: result.model || '',
    operation: AI_OPERATIONS.ANSWER_TEXT_EVALUATION,
  };
};

export default evaluateGeneralAnswer;
