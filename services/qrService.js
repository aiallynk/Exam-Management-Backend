import QRCode from 'qrcode';
import crypto from 'crypto';
import config from '../config/env.js';

const APP_BASE_URL = config.appBaseUrl;

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

export const generateSessionQRCode = async (sessionId, examId, manualToken) => {
  const qrPayload = {
    type: 'exam-session',
    sessionId,
    examId,
    manualToken,
    url: sessionId ? `${APP_BASE_URL}/exam/take/${sessionId}` : undefined,
    timestamp: Date.now(),
  };
  const qrData = JSON.stringify(qrPayload);
  const qrString = generateUniqueQRString();
  const qrImage = await generateQRCode(qrData);
  
  return {
    qrCode: qrString,
    qrImage,
    qrData,
  };
};

