import axios from 'axios';
import config from '../config/env.js';
import {
  getSupportedCodingLanguages,
  normalizeCodingLanguage,
} from '../utils/codingQuestions.js';

const PENDING_STATUS_IDS = new Set([1, 2]);
const LANGUAGE_CACHE_TTL_MS = 15 * 60 * 1000;
const LANGUAGE_ID_MAP = {
  python: 71,
  java: 62,
  cpp: 54,
  javascript: 63,
};

let cachedLanguages = null;
let cachedAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const judge0Client = axios.create({
  baseURL: config.judge0BaseUrl,
  timeout: Math.max(Number(config.judge0PollingIntervalMs || 1000) * 5, 10000),
});

const getJudge0Headers = () => {
  const headers = {
    'Content-Type': 'application/json',
  };

  let judge0Host = '';
  let isRapidApi = false;
  try {
    const parsedUrl = new URL(config.judge0BaseUrl);
    judge0Host = parsedUrl.host;
    isRapidApi = judge0Host.endsWith('rapidapi.com');
  } catch {
    // Ignore invalid base URL parsing.
  }

  if (isRapidApi) {
    if (config.judge0ApiKey) {
      headers['X-RapidAPI-Key'] = config.judge0ApiKey;
    }
    if (judge0Host) {
      headers['X-RapidAPI-Host'] = judge0Host;
    }
    return headers;
  }

  if (config.judge0ApiKey) {
    headers['X-Auth-Token'] = config.judge0ApiKey;
  }
  if (config.judge0ApiUser) {
    headers['X-Auth-User'] = config.judge0ApiUser;
  }
  return headers;
};

const matchesLanguage = (language, name) => {
  const normalizedLanguage = normalizeCodingLanguage(language);
  const normalizedName = normalizeString(name).toLowerCase();
  if (!normalizedLanguage || !normalizedName) return false;

  if (normalizedLanguage === 'python') {
    return normalizedName.includes('python');
  }
  if (normalizedLanguage === 'java') {
    return normalizedName === 'java' || normalizedName.startsWith('java ');
  }
  if (normalizedLanguage === 'cpp') {
    return normalizedName.includes('c++');
  }
  if (normalizedLanguage === 'javascript') {
    return normalizedName.includes('javascript') || normalizedName.includes('node.js');
  }
  return false;
};

export const fetchJudge0Languages = async ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && cachedLanguages && cachedAt + LANGUAGE_CACHE_TTL_MS > now) {
    return cachedLanguages;
  }

  const response = await judge0Client.get('/languages', {
    headers: getJudge0Headers(),
  });

  cachedLanguages = Array.isArray(response.data) ? response.data : [];
  cachedAt = now;
  return cachedLanguages;
};

const resolveJudge0LanguageIdFromApi = async (language, { force = false } = {}) => {
  const normalizedLanguage = normalizeCodingLanguage(language);
  if (!normalizedLanguage) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const languages = await fetchJudge0Languages({ force });
  const exact = languages.find((item) => matchesLanguage(normalizedLanguage, item?.name));
  if (exact?.id) {
    return exact.id;
  }
  return null;
};

export const resolveJudge0LanguageId = async (language) => {
  const normalizedLanguage = normalizeCodingLanguage(language);
  if (!normalizedLanguage) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const staticLanguageId = LANGUAGE_ID_MAP[normalizedLanguage];
  if (staticLanguageId) {
    return staticLanguageId;
  }

  const apiResolvedId = await resolveJudge0LanguageIdFromApi(language);
  if (apiResolvedId) {
    return apiResolvedId;
  }

  throw new Error(
    `Judge0 language mapping not found for "${normalizedLanguage}". Supported: ${getSupportedCodingLanguages().join(', ')}`
  );
};

const normalizeExecutionResponse = (payload = {}) => {
  const stdout = normalizeString(payload.stdout);
  const stderr = normalizeString(payload.stderr);
  const compileOutput = normalizeString(payload.compile_output);
  const message = normalizeString(payload.message);
  const status = payload?.status?.description || payload?.status?.name || 'Unknown';
  const error = stderr || compileOutput || message || '';

  return {
    token: payload.token || '',
    status,
    statusId: Number(payload?.status?.id) || 0,
    output: stdout,
    error,
    stderr,
    compileOutput,
    message,
    time: Number(payload.time) || 0,
    memory: Number(payload.memory) || 0,
  };
};

export const runJudge0Submission = async ({
  language,
  languageId,
  code,
  input = '',
  expectedOutput = undefined,
  timeLimit = undefined,
  memoryLimit = undefined,
  memoryLimitKb = undefined,
  executionProfile = null,
  useConfigLimits = true,
} = {}) => {
  const sourceCode = normalizeString(code);
  if (!sourceCode) {
    throw new Error('Code is required.');
  }

  const resolvedLanguageId =
    Number.isFinite(Number(languageId)) && Number(languageId) > 0
      ? Number(languageId)
      : await resolveJudge0LanguageId(language);
  const normalizedInput = normalizeString(input);
  const normalizedMemoryLimit = Number(memoryLimit);
  const profileCpuTimeLimit = Number(executionProfile?.cpuTimeLimitSeconds);
  const profileWallTimeLimit = Number(executionProfile?.wallTimeLimitSeconds);
  const profileMemoryLimitKb = Number(executionProfile?.memoryLimitKb);
  const profileEnableNetwork =
    typeof executionProfile?.enableNetwork === 'boolean'
      ? executionProfile.enableNetwork
      : undefined;
  const hasExplicitMemoryLimit =
    (Number.isFinite(Number(memoryLimitKb)) && Number(memoryLimitKb) > 0) ||
    (Number.isFinite(normalizedMemoryLimit) && normalizedMemoryLimit > 0);
  const explicitMemoryLimitKb =
    Number.isFinite(Number(memoryLimitKb)) && Number(memoryLimitKb) > 0
      ? Math.floor(Number(memoryLimitKb))
      : Number.isFinite(normalizedMemoryLimit) && normalizedMemoryLimit > 0
        ? normalizedMemoryLimit > 1024
          ? Math.floor(normalizedMemoryLimit)
          : Math.floor(normalizedMemoryLimit * 1024)
        : null;
  const fallbackMemoryLimitKb = Number(config.judge0MemoryLimitKb) || 131072;
  const resolvedMemoryLimitKb = Number.isFinite(explicitMemoryLimitKb) && explicitMemoryLimitKb > 0
    ? (
      Number.isFinite(profileMemoryLimitKb) && profileMemoryLimitKb > 0
        ? Math.max(explicitMemoryLimitKb, Math.floor(profileMemoryLimitKb))
        : explicitMemoryLimitKb
    )
    : Number.isFinite(profileMemoryLimitKb) && profileMemoryLimitKb > 0
      ? Math.floor(profileMemoryLimitKb)
      : fallbackMemoryLimitKb;
  const explicitCpuTimeLimit =
    Number.isFinite(Number(timeLimit)) && Number(timeLimit) > 0
      ? Number(timeLimit)
      : null;
  const fallbackCpuTimeLimit = useConfigLimits ? Number(config.judge0CpuTimeLimit) || 2 : undefined;
  const resolvedCpuTimeLimit = Number.isFinite(explicitCpuTimeLimit) && explicitCpuTimeLimit > 0
    ? (
      Number.isFinite(profileCpuTimeLimit) && profileCpuTimeLimit > 0
        ? Math.max(explicitCpuTimeLimit, profileCpuTimeLimit)
        : explicitCpuTimeLimit
    )
    : Number.isFinite(profileCpuTimeLimit) && profileCpuTimeLimit > 0
      ? profileCpuTimeLimit
      : fallbackCpuTimeLimit;
  const fallbackWallTimeLimit = useConfigLimits ? Number(config.judge0WallTimeLimit) || 5 : undefined;
  const resolvedWallTimeLimit = Number.isFinite(profileWallTimeLimit) && profileWallTimeLimit > 0
    ? (
      Number.isFinite(fallbackWallTimeLimit) && fallbackWallTimeLimit > 0
        ? Math.max(profileWallTimeLimit, fallbackWallTimeLimit)
        : profileWallTimeLimit
    )
    : fallbackWallTimeLimit;
  const resolvedEnableNetwork =
    typeof profileEnableNetwork === 'boolean'
      ? profileEnableNetwork
      : useConfigLimits
        ? Boolean(config.judge0EnableNetwork)
        : undefined;

  const buildSubmissionPayload = ({
    languageIdOverride = resolvedLanguageId,
    minimal = false,
  } = {}) => {
    const payload = {
      language_id: languageIdOverride,
      source_code: sourceCode,
      stdin: normalizedInput,
    };

    if (!minimal) {
      if (Number.isFinite(resolvedCpuTimeLimit) && resolvedCpuTimeLimit > 0) {
        payload.cpu_time_limit = resolvedCpuTimeLimit;
      }
      if (Number.isFinite(resolvedWallTimeLimit) && resolvedWallTimeLimit > 0) {
        payload.wall_time_limit = resolvedWallTimeLimit;
      }
      if (hasExplicitMemoryLimit || useConfigLimits || Number.isFinite(profileMemoryLimitKb)) {
        payload.memory_limit = resolvedMemoryLimitKb;
      }
      if (typeof resolvedEnableNetwork === 'boolean') {
        payload.enable_network = resolvedEnableNetwork;
      }
      if (expectedOutput !== undefined) {
        payload.expected_output = normalizeString(expectedOutput);
      }
    }

    return payload;
  };

  const createSubmission = async (payload) =>
    judge0Client.post('/submissions?base64_encoded=false&wait=false', payload, {
      headers: getJudge0Headers(),
    });

  let createResponse;
  try {
    createResponse = await createSubmission(buildSubmissionPayload());
  } catch (error) {
    const status = error?.response?.status;
    if (status === 422) {
      let fallbackLanguageId = resolvedLanguageId;
      if (language) {
        try {
          const apiLanguageId = await resolveJudge0LanguageIdFromApi(language, { force: true });
          if (apiLanguageId && apiLanguageId !== fallbackLanguageId) {
            fallbackLanguageId = apiLanguageId;
          }
        } catch {
          // Ignore language re-resolution failures and continue with the current ID.
        }
      }

      try {
        createResponse = await createSubmission(
          buildSubmissionPayload({ languageIdOverride: fallbackLanguageId, minimal: true })
        );
      } catch {
        throw error;
      }
    } else {
      throw error;
    }
  }

  const token = normalizeString(createResponse?.data?.token);
  if (!token) {
    throw new Error('Judge0 did not return a submission token.');
  }

  const maxPolls = Math.max(Number(config.judge0MaxPolls) || 20, 1);
  const pollDelay = Math.max(Number(config.judge0PollingIntervalMs) || 1000, 250);

  for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
    if (pollIndex > 0) {
      await sleep(pollDelay);
    }

    const resultResponse = await judge0Client.get(`/submissions/${token}?base64_encoded=false&fields=*`, {
      headers: getJudge0Headers(),
    });
    const normalizedResult = normalizeExecutionResponse(resultResponse.data);
    if (!PENDING_STATUS_IDS.has(normalizedResult.statusId)) {
      return normalizedResult;
    }
  }

  throw new Error('Code execution timed out while waiting for Judge0.');
};
