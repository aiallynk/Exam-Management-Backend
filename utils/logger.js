import morgan from 'morgan';
import config from '../config/env.js';

export const requestLogger = morgan(
  config.nodeEnv === 'production' ? 'combined' : 'dev'
);

export const logError = (error, context = '') => {
  console.error(`[ERROR] ${context}:`, error);
};

export const logInfo = (message, context = '') => {
  console.log(`[INFO] ${context}: ${message}`);
};

