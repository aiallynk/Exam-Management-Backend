import Section from '../../models/Section.js';
import Question from '../../models/Question.js';
import offlineEvaluationConfig from '../../config/offlineEvaluationConfig.js';

// Part H — answer segmentation & question mapping. Walks the FROZEN,
// already-delivered QuestionPaper structure (Section.order then
// Question.order — see docs/XAMIGO_V2_OFFLINE_EVALUATION_INSPECTION.md
// Part 14) to reconstruct the printed-paper question sequence. Never
// consults mutable QuestionVersion / the Question Bank — only the actual
// Question documents on this specific paper are authoritative for
// evaluation.

// Builds the deterministic 1..N printed-paper numbering. If an exam's
// actual paper prints per-section numbering (e.g. Section B restarting at
// 1), this continuous scheme will misalign for that section — flagged in
// the Phase 4 status doc as a known limitation rather than silently
// assumed correct.
export const buildExpectedQuestionSequence = async ({ questionPaperId, tenantId }) => {
  const sections = await Section.find({ questionPaperId }).sort({ order: 1 }).select('_id order').lean();
  const sequence = [];
  for (const section of sections) {
    const questions = await Question.find({ sectionId: section._id, questionPaperId }).sort({ order: 1 }).select('_id questionType points').lean();
    questions.forEach((question) => {
      sequence.push({ displayNumber: sequence.length + 1, questionId: question._id, questionType: question.questionType, points: question.points, sectionId: section._id });
    });
  }
  // A no-section (isNoSectionExam) paper has questions directly on the
  // paper with no Section — fall back to paper-scoped Question.order.
  if (!sequence.length) {
    const questions = await Question.find({ questionPaperId }).sort({ order: 1 }).select('_id questionType points').lean();
    questions.forEach((question) => {
      sequence.push({ displayNumber: sequence.length + 1, questionId: question._id, questionType: question.questionType, points: question.points, sectionId: null });
    });
  }
  return sequence;
};

// Extracts the leading integer from a detected label like "3", "Q3",
// "3(b)", "Question 3" — the sub-part letter (if any) is kept only for
// display, since the current Question schema has no sub-part concept (a
// printed "3(a)"/"3(b)" both point at the same Question document unless
// the paper genuinely modeled them as separate Question records with
// their own order value, in which case both would already appear as
// distinct sequence entries and this numeric match still resolves each
// correctly by position).
const parseDetectedNumber = (label) => {
  const match = String(label || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

export const mapSegmentToQuestion = ({ detectedQuestionNumber, extractionConfidence, sequence }) => {
  const number = parseDetectedNumber(detectedQuestionNumber);
  if (number === null) {
    return { questionId: null, mappingConfidence: 0, mappingStatus: 'NEEDS_REVIEW' };
  }
  const candidate = sequence.find((entry) => entry.displayNumber === number);
  if (!candidate) {
    return { questionId: null, mappingConfidence: 0, mappingStatus: 'NEEDS_REVIEW' };
  }
  // Mapping confidence combines "did we read the number clearly" with "did
  // that number resolve to exactly one real question" (always true here,
  // since displayNumber is unique) — extraction confidence dominates.
  const mappingConfidence = Number((Math.max(0, Math.min(1, extractionConfidence ?? 0.5)) * 0.95).toFixed(3));
  // Part H's 3 tiers, split across two stages: LOW here means we don't
  // even know which question this is — mandatory manual mapping before
  // anything can be evaluated. HIGH and MEDIUM both proceed to evaluation
  // (mapping succeeded either way); MEDIUM's "evaluate but require review"
  // is enforced later by attemptMaterializationService, which folds this
  // same mappingConfidence into the Answer's needsReview decision alongside
  // the evaluation-step confidence (Part K) — not decided here in isolation.
  const mappingStatus = mappingConfidence >= offlineEvaluationConfig.QUESTION_MAPPING_LOW_CONFIDENCE
    ? 'AUTO_MAPPED'
    : 'NEEDS_REVIEW';
  return { questionId: candidate.questionId, questionType: candidate.questionType, points: candidate.points, mappingConfidence, mappingStatus };
};
