import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveEvaluationStrategy } from '../services/offlineEvaluation/evaluationStrategyResolver.js';
import {
  applyEvaluatorApproval,
  applyEvaluatorOverride,
  isUnresolvedScore,
  resolveAuthoritativeScore,
} from '../services/offlineEvaluation/scoreResolutionService.js';
import { buildNotAttemptedPayload } from '../services/offlineEvaluation/materializationIntegrity.js';
import { computeWeightedQuestionScore } from '../services/offlineEvaluation/rubricWeightService.js';
import { buildFinalizeReadiness } from '../services/offlineEvaluation/answerScriptFinalizeReadiness.js';

const validRubric = [
  { key: 'accuracy', criterion: 'Accuracy', maxMarks: 3 },
  { key: 'coverage', criterion: 'Coverage', maxMarks: 2 },
];

describe('subjective evaluation fallback policy', () => {
  test('no configured rubric selects general AI provisional scoring, not a rubric failure', () => {
    const strategy = resolveEvaluationStrategy({ questionType: 'ESSAY', evaluationConfig: {} });
    assert.equal(strategy.scoringMode, 'AI_GENERAL_PROVISIONAL');
    assert.equal(strategy.rubric.configured, false);
  });

  test('a valid frozen rubric selects rubric-based scoring', () => {
    const strategy = resolveEvaluationStrategy({
      questionType: 'ESSAY',
      rubricSnapshot: { criteria: validRubric },
      evaluationConfig: { rubric: [{ key: 'wrong-source', maxMarks: 5 }] },
    });
    assert.equal(strategy.scoringMode, 'RUBRIC_BASED');
    assert.equal(strategy.rubric.source, 'RUBRIC_SNAPSHOT');
  });

  test('a configured but invalid rubric becomes evaluation failed and cannot fall back generically', () => {
    const strategy = resolveEvaluationStrategy({
      questionType: 'ESSAY',
      rubricSnapshot: { criteria: [{ key: 'accuracy', criterion: 'Accuracy', weight: 70 }] },
    });
    assert.equal(strategy.scoringMode, 'EVALUATION_FAILED');
    assert.equal(strategy.rubric.configured, true);
  });

  test('strict weighted scoring rejects incomplete or mismatched criterion IDs', () => {
    const result = computeWeightedQuestionScore({
      questionMaxMarks: 5,
      criteria: validRubric,
      achievements: [{ criterionRef: 'accuracy', achievementPercentage: 100 }],
      strictCriterionRefs: true,
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'CRITERION_ID_MISMATCH');
  });

  test('a general AI proposal has no authoritative score before evaluator approval', () => {
    const answer = {
      scoringMode: 'AI_GENERAL_PROVISIONAL', aiProposedScore: 4,
      evaluatorDecision: 'PENDING', finalScore: null, scoreResolved: false, requiresReview: true,
    };
    assert.equal(isUnresolvedScore(answer), true);
    assert.equal(resolveAuthoritativeScore(answer), null);
  });

  test('evaluator approval promotes a proposed 4/5 score while preserving the proposal', () => {
    const answer = {
      scoringMode: 'AI_GENERAL_PROVISIONAL', aiProposedScore: 4,
      evaluatorDecision: 'PENDING', finalScore: null, scoreResolved: false, requiresReview: true,
    };
    applyEvaluatorApproval({ answer, evaluatorId: 'evaluator-1', maximumMarks: 5 });
    assert.equal(answer.aiProposedScore, 4);
    assert.equal(answer.evaluatorDecision, 'APPROVE_AI');
    assert.equal(answer.finalScore, 4);
    assert.equal(answer.pointsEarned, 4);
    assert.equal(answer.scoreResolved, true);
  });

  test('evaluator override preserves a proposed score and finalizes a different score', () => {
    const answer = {
      scoringMode: 'AI_GENERAL_PROVISIONAL', aiProposedScore: 4,
      evaluatorDecision: 'PENDING', finalScore: null, scoreResolved: false, requiresReview: true,
    };
    applyEvaluatorOverride({ answer, evaluatorId: 'evaluator-1', score: 3 });
    assert.equal(answer.aiProposedScore, 4);
    assert.equal(answer.evaluatorOverrideScore, 3);
    assert.equal(answer.finalScore, 3);
    assert.equal(answer.evaluatorDecision, 'OVERRIDE');
  });

  test('a human override resolves a prior evaluation failure and records a manual scoring mode', () => {
    const answer = {
      scoringMode: 'EVALUATION_FAILED', aiProposedScore: null,
      evaluatorDecision: 'PENDING', finalScore: null, scoreResolved: false, requiresReview: true,
    };
    applyEvaluatorOverride({ answer, evaluatorId: 'evaluator-1', score: 0 });
    assert.equal(answer.scoringMode, 'MANUAL');
    assert.equal(answer.scoreResolved, true);
    assert.equal(isUnresolvedScore(answer), false);
  });

  test('a historic human override on an evaluation failure is treated as resolved', () => {
    const answer = {
      scoringMode: 'EVALUATION_FAILED', evaluatorDecision: 'OVERRIDE',
      finalScore: 3, scoreResolved: true, requiresReview: false, evaluationStatus: 'REVIEWED',
    };
    assert.equal(isUnresolvedScore(answer), false);
    assert.equal(resolveAuthoritativeScore(answer), 3);
  });

  test('a proposed zero remains pending until the evaluator explicitly approves it', () => {
    const answer = {
      scoringMode: 'AI_GENERAL_PROVISIONAL', aiProposedScore: 0,
      evaluatorDecision: 'PENDING', finalScore: null, scoreResolved: false, requiresReview: true,
    };
    applyEvaluatorApproval({ answer, evaluatorId: 'evaluator-1', maximumMarks: 5 });
    assert.equal(answer.finalScore, 0);
    assert.equal(answer.pointsEarned, 0);
    assert.equal(answer.scoreResolved, true);
  });

  test('a blank handwritten subjective answer gets a proposed zero and still requires review', () => {
    const payload = buildNotAttemptedPayload({
      attemptId: 'attempt-1',
      question: { _id: 'question-1', questionType: 'ESSAY', points: 5, evaluationConfig: {} },
    });
    assert.equal(payload.answerStatus, 'NOT_ATTEMPTED');
    assert.equal(payload.aiProposedScore, 0);
    assert.equal(payload.finalScore, null);
    assert.equal(payload.evaluationStatus, 'PENDING_REVIEW');
    assert.equal(payload.requiresReview, true);
  });

  test('a blank answer with a broken configured rubric does not become a deterministic zero', () => {
    const payload = buildNotAttemptedPayload({
      attemptId: 'attempt-1',
      question: {
        _id: 'question-1', questionType: 'ESSAY', points: 5,
        rubricSnapshot: { criteria: [{ key: 'accuracy', criterion: 'Accuracy', weight: 70 }] },
      },
    });
    assert.equal(payload.scoringMode, 'EVALUATION_FAILED');
    assert.equal(payload.aiProposedScore, null);
    assert.equal(payload.finalScore, null);
    assert.equal(payload.requiresReview, true);
  });

  test('one unresolved provisional answer blocks offline-paper finalization', () => {
    const readiness = buildFinalizeReadiness({
      scriptStatus: 'NEEDS_REVIEW', candidateId: 'candidate-1', materializedAttemptId: 'attempt-1', pendingReviewCount: 1,
    });
    assert.equal(readiness.canFinalize, false);
    assert.equal(readiness.blockers[0].code, 'EVALUATOR_REVIEW');
  });

  test('candidate-result resolution never uses a pending proposed score', () => {
    assert.equal(resolveAuthoritativeScore({
      scoringMode: 'AI_GENERAL_PROVISIONAL', aiProposedScore: 5,
      finalScore: null, scoreResolved: false, evaluatorDecision: 'PENDING', requiresReview: true,
    }), null);
  });
});
