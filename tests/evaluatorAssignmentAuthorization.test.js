import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examEvaluatorsSource = readFileSync(path.join(__dirname, '../routes/examEvaluators.js'), 'utf8');
const examinerAssignmentsSource = readFileSync(path.join(__dirname, '../routes/examinerAssignments.js'), 'utf8');
const examPermissionsSource = readFileSync(path.join(__dirname, '../middleware/examPermissions.js'), 'utf8');

describe('evaluator assignment authorization', () => {
  test('exam evaluator routes allow academic admins and use exam-operation scope', () => {
    assert.match(examEvaluatorsSource, /EVALUATOR_MANAGER_ROLES = \['EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER', 'TENANT_ADMIN'\]/);
    assert.match(examEvaluatorsSource, /requireExamEvaluatorManager\(\)/);
    assert.equal(examEvaluatorsSource.includes("requireRole('EXAM_CREATOR')"), false);
  });

  test('tenant examiner assignment create uses exam-operation scope', () => {
    assert.match(examinerAssignmentsSource, /requireExamEvaluatorManager\(\{ examIdFrom: 'body' \}\)/);
    assert.match(examinerAssignmentsSource, /requireRole\('EXAM_CREATOR', 'ACADEMIC_ADMIN', 'TEACHER', 'TENANT_ADMIN'\)/);
  });

  test('requireExamEvaluatorManager delegates to canOperateExam', () => {
    assert.match(examPermissionsSource, /export const requireExamEvaluatorManager/);
    assert.match(examPermissionsSource, /canOperateExam\(req\.user, exam\)/);
  });
});
