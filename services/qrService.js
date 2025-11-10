import QRCode from 'qrcode';
import crypto from 'crypto';
import config from '../config/env.js';

const APP_BASE_URL = config.appBaseUrl;

const sanitizeBaseUrl = (baseUrl) => {
  if (!baseUrl) return null;
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
};

export const generateQRCode = async (data) => {
  try {
    const qrDataURL = await QRCode.toDataURL(data, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 300,
      margin: 1,
    });
    return qrDataURL;
  } catch (error) {
    throw new Error(`QR code generation failed: ${error.message}`);
  }
};

export const generateUniqueQRString = () => {
  return crypto.randomBytes(32).toString('hex');
};

export const generateSessionQRCode = async (
  sessionId,
  examId,
  manualToken,
  baseUrl
) => {
  const resolvedBaseUrl = sanitizeBaseUrl(baseUrl) || sanitizeBaseUrl(APP_BASE_URL);
  const qrString = generateUniqueQRString();

  const qrPayload = {
    type: 'exam-session',
    sessionId,
    examId,
    manualToken,
    qrCode: qrString,
    url:
      sessionId && resolvedBaseUrl
        ? `${resolvedBaseUrl}/exam/take/${sessionId}`
        : undefined,
    timestamp: Date.now(),
  };

  const qrData = JSON.stringify(qrPayload);
  const qrImage = await generateQRCode(qrData);

  return {
    qrCode: qrString,
    qrImage,
    qrData,
  };
};

