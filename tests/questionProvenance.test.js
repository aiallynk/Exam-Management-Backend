import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_FORBIDDEN_PROVENANCE_KEYS,
  buildEvidenceKeyMap,
  sanitizeEvidenceKeys,
  stripModelSuppliedProvenance,
  buildQuestionProvenance,
  toProvenanceView,
} from '../services/questionProvenanceService.js';

describe('evidence-key indirection (spec Part 10)', () => {
  const chunks = [{ _id: 'c1' }, { _id: 'c2' }, { _id: 'c3' }];
  test('Xamigo issues evidence_1..N mapped to real chunk ids', () => {
    const map = buildEvidenceKeyMap(chunks);
    assert.equal(map.get('evidence_1'), 'c1');
    assert.equal(map.get('evidence_3'), 'c3');
    assert.equal(map.size, 3);
  });
  test('keys the model invented (never issued) are ignored', () => {
    const map = buildEvidenceKeyMap(chunks);
    assert.deepEqual(sanitizeEvidenceKeys(['evidence_2', 'evidence_99', 'chapter_3', 'evidence_2'], map), ['evidence_2']);
  });
});

describe('the model can never supply provenance metadata (spec Part 1)', () => {
  test('forbidden keys are stripped from raw model output', () => {
    const raw = stripModelSuppliedProvenance({
      questionText: 'Q',
      bookTitle: 'NCERT Science',
      chapter: 'Nutrition in Plants',
      page: 14,
      libraryResourceId: 'deadbeef',
      keepThis: 1,
    });
    assert.equal(raw.keepThis, 1);
    for (const k of ['bookTitle', 'chapter', 'page', 'libraryResourceId']) {
      assert.equal(k in raw, false, `${k} must be stripped`);
    }
  });
  test('the forbidden list covers title/author/chapter/page/id families', () => {
    for (const k of ['author', 'pageNumber', 'resourceId', 'sourceId', 'topic', 'unit']) {
      assert.ok(MODEL_FORBIDDEN_PROVENANCE_KEYS.includes(k));
    }
  });
});

describe('buildQuestionProvenance + toProvenanceView', () => {
  const ref = {
    libraryResourceId: 'lib1',
    contextSourceId: 'src1',
    resourceTitleSnapshot: 'NCERT Grade VII Science',
    resourceTypeSnapshot: 'TEXTBOOK',
    chapterSnapshot: 'Nutrition in Plants',
    topicSnapshot: 'Photosynthesis',
    pageStart: 12,
    pageEnd: 14,
    evidenceChunkIdsInternal: ['c1', 'c2'],
    evidenceHash: 'abc123',
    evidenceTextSnapshot: 'Plants use sunlight, water and carbon dioxide...',
    relevanceScoreInternal: 0.71,
    usage: ['QUESTION_CONCEPT', 'ANSWER_SUPPORT'],
  };

  test('assembles compat view (sourceIds/chunkIds) from the frozen refs', () => {
    const p = buildQuestionProvenance({
      generationMode: 'SOURCE_GROUNDED',
      sourcePolicy: 'STRICT_SOURCE',
      creatorInstruction: 'focus on the process',
      sourceReferences: [ref],
      groundingVerdict: 'SUPPORTED',
    });
    assert.deepEqual(p.chunkIds, ['c1', 'c2']);
    assert.deepEqual(p.sourceIds, ['src1']);
    assert.equal(p.revalidationState, 'CURRENT');
    assert.equal(p.groundingVerdict, 'SUPPORTED');
  });

  test('educator view exposes real book/chapter/page and NOTHING technical (spec Parts 2, 3, 31)', () => {
    const view = toProvenanceView(buildQuestionProvenance({ generationMode: 'SOURCE_GROUNDED', sourceReferences: [ref], groundingVerdict: 'SUPPORTED' }));
    assert.equal(view.sourceLabel, 'NCERT Grade VII Science');
    assert.equal(view.grounding, 'Verified');
    assert.equal(view.references[0].basedOn, 'NCERT Grade VII Science');
    assert.equal(view.references[0].pagesLabel, '12–14');
    assert.match(view.references[0].usageLabel, /Question concept/);
    const json = JSON.stringify(view);
    for (const banned of ['evidenceChunkIdsInternal', 'evidenceHash', 'relevanceScoreInternal', 'noveltySignatures', 'cosine', 'embedding', 'vector', 'chunkId']) {
      assert.equal(json.includes(banned), false, `educator view must not contain ${banned}`);
    }
  });

  test('missing metadata → "Source metadata unavailable", never a fabricated reference (spec Part 1)', () => {
    const bare = { contextSourceId: 'src9', evidenceChunkIdsInternal: ['c9'], evidenceHash: 'z', usage: ['QUESTION_CONCEPT'] };
    const view = toProvenanceView(buildQuestionProvenance({ generationMode: 'SOURCE_GROUNDED', sourceReferences: [bare] }));
    assert.equal(view.references[0].basedOn, 'Source metadata unavailable');
    assert.equal(view.references[0].pagesLabel, 'Referenced pages: unavailable');
    assert.equal(view.references[0].metadataAvailable, false);
  });

  test('non-source question → "Generated from creator instructions", not a textbook', () => {
    const view = toProvenanceView(buildQuestionProvenance({ generationMode: 'STANDARD', sourcePolicy: 'NONE', creatorInstruction: 'make 5 MCQs on gravity' }));
    assert.equal(view.sourceLabel, 'Generated from creator instructions');
    assert.equal(view.referenceCount, 0);
    assert.equal(view.grounding, 'Not source-grounded');
  });

  test('manual + question-bank modes carry their own honest labels', () => {
    assert.equal(toProvenanceView({ generationMode: 'MANUAL' }).sourceLabel, 'Manual authoring');
    assert.equal(toProvenanceView({ generationMode: 'QUESTION_BANK_REUSE', questionBankItemId: 'x' }).sourceLabel, 'Question Bank');
  });
});

describe('no automatic fine-tuning (spec Parts 12, 30, 35-K)', () => {
  test('no service in the loop invokes a provider fine-tuning API', async () => {
    const fs = await import('node:fs');
    const files = [
      'services/questionHistoryService.js',
      'services/tenantGenerationProfileService.js',
      'services/questionProvenanceService.js',
      'services/sourceDiscoveryService.js',
    ];
    // Real fine-tuning entry points — not prose. (The service comments do say
    // "NOT fine-tuning", which is the point.)
    const bannedApiCalls = [
      'createFineTuningJob', 'fine_tuning.jobs', 'fineTuning.jobs', '.fineTunes',
      'createFineTune', 'fine-tuning/jobs', 'FineTuningJob',
    ];
    for (const f of files) {
      const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      for (const banned of bannedApiCalls) {
        assert.equal(src.includes(banned), false, `${f} must not call ${banned}`);
      }
    }
  });
});
