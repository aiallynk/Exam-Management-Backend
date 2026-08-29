import crypto from 'crypto';
import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import bwipjs from 'bwip-js';
import AnswerScriptMappingToken from '../../models/AnswerScriptMappingToken.js';
import { generateQRCode } from '../qrService.js';

const TOKEN_PATTERN = /xam1_[A-Za-z0-9_-]{43}/;

export const generateOpaqueMappingToken = () => `xam1_${crypto.randomBytes(32).toString('base64url')}`;
export const hashMappingToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

export const extractAnswerScriptMappingToken = (value) => {
  const match = String(value || '').match(TOKEN_PATTERN);
  return match?.[0] || null;
};

export const renderMappingSymbols = async (token) => {
  const normalized = extractAnswerScriptMappingToken(token);
  if (!normalized) throw new Error('A valid answer-script mapping token is required.');
  const [qrImage, barcodeBuffer] = await Promise.all([
    generateQRCode(normalized),
    bwipjs.toBuffer({
      bcid: 'code128',
      text: normalized,
      scale: 3,
      height: 12,
      includetext: true,
      textxalign: 'center',
      backgroundcolor: 'FFFFFF',
    }),
  ]);
  return {
    qrImage,
    barcodeImage: `data:image/png;base64,${barcodeBuffer.toString('base64')}`,
  };
};

export const createAnswerScriptMappingToken = async ({
  tenantId,
  examId,
  questionPaperId,
  sessionId = null,
  candidateId = null,
  enrollmentId = null,
  createdBy,
  expiresAt,
}) => {
  const token = generateOpaqueMappingToken();
  const record = await AnswerScriptMappingToken.create({
    tenantId,
    examId,
    questionPaperId,
    sessionId,
    candidateId,
    enrollmentId,
    tokenHash: hashMappingToken(token),
    expiresAt,
    createdBy,
  });
  return { record, token, ...(await renderMappingSymbols(token)) };
};

export const resolveAnswerScriptMappingToken = async ({ token, tenantId } = {}) => {
  const normalized = extractAnswerScriptMappingToken(token);
  if (!normalized) return null;
  return AnswerScriptMappingToken.findOne({
    tokenHash: hashMappingToken(normalized),
    tenantId,
    status: 'ACTIVE',
    expiresAt: { $gt: new Date() },
  }).lean();
};

// Scanned-page auto-detection for QR. Code 128 scanners can submit the same
// opaque value through the upload field; both symbologies resolve through
// the one token model and one validation path.
export const decodeMappingTokenFromImageBuffer = async (buffer) => {
  try {
    const image = await Jimp.read(buffer);
    const { data, width, height } = image.bitmap;
    const decoded = jsQR(new Uint8ClampedArray(data), width, height, { inversionAttempts: 'attemptBoth' });
    return extractAnswerScriptMappingToken(decoded?.data);
  } catch {
    return null;
  }
};
