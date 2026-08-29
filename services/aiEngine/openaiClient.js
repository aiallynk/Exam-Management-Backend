import OpenAI from 'openai';
import config from '../../config/env.js';

let client = null;

export const getOpenAIClient = () => {
  if (!config.openaiApiKey) return null;
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
};

export const resetOpenAIClientForTests = () => {
  client = null;
};
