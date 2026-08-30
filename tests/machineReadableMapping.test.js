import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import AnswerScript from '../models/AnswerScript.js';
import {
  decodeMappingTokenFromImageBuffer,
  extractAnswerScriptMappingToken,
  generateOpaqueMappingToken,
  hashMappingToken,
  renderMappingSymbols,
} from '../services/offlineEvaluation/machineReadableMappingService.js';

describe('offline QR/barcode answer-script mapping', () => {
  test('the printed value is opaque and contains no direct candidate PII', () => {
    const token = generateOpaqueMappingToken();
    assert.match(token, /^xam1_[A-Za-z0-9_-]{43}$/);
    assert.equal(token.includes('@'), false);
    assert.equal(token.includes('+'), false);
    assert.equal(extractAnswerScriptMappingToken(`https://example.test/intake?token=${token}`), token);
    assert.equal(hashMappingToken(token).length, 64);
    assert.notEqual(hashMappingToken(token), token);
  });

  test('one opaque value renders as both QR and Code 128 and the QR decodes losslessly', async () => {
    const token = generateOpaqueMappingToken();
    const symbols = await renderMappingSymbols(token);
    assert.match(symbols.qrImage, /^data:image\/png;base64,/);
    assert.match(symbols.barcodeImage, /^data:image\/png;base64,/);
    const qrBuffer = Buffer.from(symbols.qrImage.split(',')[1], 'base64');
    assert.equal(await decodeMappingTokenFromImageBuffer(qrBuffer), token);
  });

  test('AnswerScript enforces one materialization per mapping token', () => {
    const index = AnswerScript.schema.indexes().find(([keys]) => keys.mappingTokenId === 1);
    assert.ok(index);
    assert.equal(index[1].unique, true);
    assert.deepEqual(index[1].partialFilterExpression, { mappingTokenId: { $type: 'objectId' } });
  });
});
