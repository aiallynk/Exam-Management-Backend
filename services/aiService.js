import OpenAI from 'openai';
import config from '../config/env.js';

const client = config.openaiApiKey
  ? new OpenAI({ apiKey: config.openaiApiKey })
  : null;

const VALID_QUESTION_TYPES = [
  'MULTIPLE_CHOICE',
  'MULTIPLE_OPTIONS',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'PARAGRAPH',
  'NUMBER',
];

const sanitizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const parseMultiAnswer = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
      .filter(Boolean);
  }
  if (value === undefined || value === null) {
    return [];
  }
  const raw = String(value).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
        .filter(Boolean);
    }
  } catch (error) {
    // ignore JSON parse errors and fallback to delimiters
  }
  return raw
    .split(/[,;|\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeQuestionObject = (question, index = 0) => {
  if (!question || typeof question !== 'object') {
    return null;
  }

  const questionText = sanitizeString(question.questionText || question.question || question.text);
  if (!questionText) {
    return null;
  }

  const rawType = sanitizeString(question.questionType || question.type || question.question_type).toUpperCase();
  const questionType = VALID_QUESTION_TYPES.includes(rawType) ? rawType : 'SHORT_ANSWER';

  let options = Array.isArray(question.options)
    ? question.options.map((opt) => sanitizeString(opt)).filter(Boolean)
    : undefined;

  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType)) {
    if (!options || options.length === 0) {
      if (questionType === 'TRUE_FALSE') {
        options = ['True', 'False'];
      } else {
        options = ['Option A', 'Option B', 'Option C', 'Option D'];
      }
    }
  } else {
    options = undefined;
  }

  let correctAnswer;
  if (questionType === 'MULTIPLE_OPTIONS') {
    const answers = parseMultiAnswer(question.correctAnswer || question.answers || question.correctAnswers);
    correctAnswer = answers.filter((ans) => !options || options.includes(ans));
  } else if (questionType === 'TRUE_FALSE') {
    const val = sanitizeString(question.correctAnswer || question.answer || question.correct_option);
    correctAnswer = val.toLowerCase().startsWith('t') ? 'True' : val.toLowerCase().startsWith('f') ? 'False' : 'True';
  } else if (questionType === 'NUMBER') {
    correctAnswer = sanitizeString(question.correctAnswer || question.answer || question.correct_option);
  } else if (questionType === 'MULTIPLE_CHOICE') {
    const val = sanitizeString(question.correctAnswer || question.answer || question.correct_option);
    if (options && options.includes(val)) {
      correctAnswer = val;
    } else if (val.length === 1) {
      const idx = val.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
      correctAnswer = options && options[idx] ? options[idx] : options ? options[0] : '';
    } else {
      correctAnswer = options ? options[0] : val;
    }
  } else {
    correctAnswer = sanitizeString(question.correctAnswer || question.answer || '');
  }

  const points = Number.isFinite(Number(question.points)) ? Number(question.points) : 1;

  const passage = sanitizeString(
    question.passage ||
      question.context ||
      question.sourceText ||
      question.reference ||
      question.passageText ||
      question.reading ||
      ''
  );

  return {
    questionText,
    questionType,
    options,
    correctAnswer,
    points,
    order: Number.isFinite(Number(question.order)) ? Number(question.order) : index,
    passage,
  };
};

const parseCount = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const buildQuestionTypeDistribution = ({ questionTypes, questionTypeDistribution, count }) => {
  const safeTypes = Array.isArray(questionTypes)
    ? questionTypes
      .map((type) => sanitizeString(type).toUpperCase())
      .filter((type) => VALID_QUESTION_TYPES.includes(type))
    : [];

  const safeCount = Math.max(1, parseCount(count, 5));

  if (!safeTypes.length) {
    return [{ type: 'MULTIPLE_CHOICE', count: safeCount }];
  }

  const distributionMap = {};
  safeTypes.forEach((type) => {
    distributionMap[type] = 0;
  });

  if (Array.isArray(questionTypeDistribution) && questionTypeDistribution.length > 0) {
    questionTypeDistribution.forEach((item) => {
      const type = sanitizeString(item?.type).toUpperCase();
      const typeCount = Math.max(0, parseCount(item?.count, 0));
      if (safeTypes.includes(type)) {
        distributionMap[type] += typeCount;
      }
    });
  }

  let total = safeTypes.reduce((sum, type) => sum + distributionMap[type], 0);

  if (total <= 0) {
    const perType = Math.floor(safeCount / safeTypes.length);
    const remainder = safeCount % safeTypes.length;
    safeTypes.forEach((type, idx) => {
      distributionMap[type] = perType + (idx < remainder ? 1 : 0);
    });
    total = safeCount;
  }

  if (total !== safeCount) {
    if (total < safeCount) {
      distributionMap[safeTypes[0]] += safeCount - total;
    } else {
      let overflow = total - safeCount;
      const orderedTypes = [...safeTypes].sort((a, b) => distributionMap[b] - distributionMap[a]);
      for (const type of orderedTypes) {
        if (overflow <= 0) break;
        const removable = Math.min(distributionMap[type], overflow);
        distributionMap[type] -= removable;
        overflow -= removable;
      }

      if (overflow > 0) {
        const perType = Math.floor(safeCount / safeTypes.length);
        const remainder = safeCount % safeTypes.length;
        safeTypes.forEach((type, idx) => {
          distributionMap[type] = perType + (idx < remainder ? 1 : 0);
        });
      }
    }
  }

  const distribution = safeTypes
    .map((type) => ({ type, count: Math.max(0, distributionMap[type] || 0) }))
    .filter((item) => item.count > 0);

  if (!distribution.length) {
    return [{ type: safeTypes[0], count: safeCount }];
  }

  const finalTotal = distribution.reduce((sum, item) => sum + item.count, 0);
  if (finalTotal !== safeCount) {
    distribution[0].count += safeCount - finalTotal;
  }

  return distribution;
};

const buildFallbackQuestionForType = ({ type, index, topic }) => {
  const safeType = VALID_QUESTION_TYPES.includes(type) ? type : 'SHORT_ANSWER';
  const safeTopic = sanitizeString(topic) || 'the topic';
  const typeLabel = safeType.replace(/_/g, ' ').toLowerCase();
  const baseQuestionText = `Sample ${typeLabel} question ${index + 1} about ${safeTopic}?`;

  if (safeType === 'TRUE_FALSE') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: ['True', 'False'],
      correctAnswer: 'True',
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'MULTIPLE_CHOICE') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctAnswer: 'Option A',
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'MULTIPLE_OPTIONS') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctAnswer: ['Option A'],
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'NUMBER') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: undefined,
      correctAnswer: '0',
      points: 1,
      order: index + 1,
      passage: '',
    };
  }

  if (safeType === 'PARAGRAPH') {
    return {
      questionText: baseQuestionText,
      questionType: safeType,
      options: undefined,
      correctAnswer: 'Refer to passage',
      points: 1,
      order: index + 1,
      passage: `Read the following passage about ${safeTopic} and answer the question.`,
    };
  }

  return {
    questionText: baseQuestionText,
    questionType: safeType,
    options: undefined,
    correctAnswer: 'Sample answer',
    points: 1,
    order: index + 1,
    passage: '',
  };
};

const normalizeToRequestedType = ({ question, type, index, topic }) => {
  const fallback = buildFallbackQuestionForType({ type, index, topic });
  const source = question && typeof question === 'object' ? question : fallback;
  const normalized =
    normalizeQuestionObject({ ...source, questionType: type }, index + 1) ||
    normalizeQuestionObject(fallback, index + 1) ||
    fallback;

  const questionText = sanitizeString(normalized.questionText) || fallback.questionText;
  const points = Number.isFinite(Number(normalized.points)) ? Number(normalized.points) : 1;

  if (type === 'MULTIPLE_CHOICE') {
    const options = Array.isArray(normalized.options) && normalized.options.length
      ? normalized.options
      : ['Option A', 'Option B', 'Option C', 'Option D'];
    const answer = sanitizeString(normalized.correctAnswer);
    const correctAnswer = options.includes(answer) ? answer : options[0];
    return {
      questionText,
      questionType: type,
      options,
      correctAnswer,
      points,
      order: index + 1,
      passage: '',
    };
  }

  if (type === 'MULTIPLE_OPTIONS') {
    const options = Array.isArray(normalized.options) && normalized.options.length
      ? normalized.options
      : ['Option A', 'Option B', 'Option C', 'Option D'];
    const answers = parseMultiAnswer(normalized.correctAnswer).filter((ans) => options.includes(ans));
    return {
      questionText,
      questionType: type,
      options,
      correctAnswer: answers.length ? answers : [options[0]],
      points,
      order: index + 1,
      passage: '',
    };
  }

  if (type === 'TRUE_FALSE') {
    const answer = sanitizeString(normalized.correctAnswer).toLowerCase();
    return {
      questionText,
      questionType: type,
      options: ['True', 'False'],
      correctAnswer: answer.startsWith('f') ? 'False' : 'True',
      points,
      order: index + 1,
      passage: '',
    };
  }

  if (type === 'NUMBER') {
    const answer = sanitizeString(normalized.correctAnswer);
    return {
      questionText,
      questionType: type,
      options: undefined,
      correctAnswer: answer || '0',
      points,
      order: index + 1,
      passage: '',
    };
  }

  if (type === 'PARAGRAPH') {
    const answer = sanitizeString(normalized.correctAnswer) || 'Refer to passage';
    const passage = sanitizeString(normalized.passage) || fallback.passage;
    return {
      questionText,
      questionType: type,
      options: undefined,
      correctAnswer: answer,
      points,
      order: index + 1,
      passage,
    };
  }

  return {
    questionText,
    questionType: 'SHORT_ANSWER',
    options: undefined,
    correctAnswer: sanitizeString(normalized.correctAnswer) || 'Sample answer',
    points,
    order: index + 1,
    passage: '',
  };
};

const enforceQuestionDistribution = ({ questions, typeDistribution, count, topic }) => {
  const safeDistribution = Array.isArray(typeDistribution)
    ? typeDistribution
      .map((item) => ({
        type: sanitizeString(item?.type).toUpperCase(),
        count: Math.max(0, parseCount(item?.count, 0)),
      }))
      .filter((item) => VALID_QUESTION_TYPES.includes(item.type) && item.count > 0)
    : [];

  const safeCount = Math.max(1, parseCount(count, 5));
  if (!safeDistribution.length) {
    return Array.from({ length: safeCount }, (_, idx) =>
      buildFallbackQuestionForType({ type: 'MULTIPLE_CHOICE', index: idx, topic })
    );
  }

  const targetByType = {};
  const poolsByType = {};
  safeDistribution.forEach(({ type, count: typeCount }) => {
    targetByType[type] = typeCount;
    poolsByType[type] = [];
  });

  const overflowPool = [];
  (Array.isArray(questions) ? questions : []).forEach((question, index) => {
    const normalized = normalizeQuestionObject(question, index + 1);
    if (!normalized) return;
    const type = sanitizeString(normalized.questionType).toUpperCase();
    if (!targetByType[type]) {
      overflowPool.push(normalized);
      return;
    }
    if (poolsByType[type].length < targetByType[type]) {
      poolsByType[type].push(normalized);
    } else {
      overflowPool.push(normalized);
    }
  });

  const result = [];
  safeDistribution.forEach(({ type, count: targetCount }) => {
    for (let i = 0; i < targetCount; i += 1) {
      let candidate = poolsByType[type].shift();
      if (!candidate && overflowPool.length > 0) {
        candidate = overflowPool.shift();
      }
      result.push(
        normalizeToRequestedType({
          question: candidate,
          type,
          index: result.length,
          topic,
        })
      );
    }
  });

  while (result.length < safeCount) {
    result.push(
      normalizeToRequestedType({
        question: null,
        type: safeDistribution[0].type,
        index: result.length,
        topic,
      })
    );
  }

  return result
    .slice(0, safeCount)
    .map((question, index) => ({ ...question, order: index + 1 }));
};

/**
 * Generate exam questions using OpenAI
 */
export const generateQuestions = async (params) => {
  // Extract and sanitize parameters
  let {
    topic,
    count,
    difficulty,
    questionTypes,
    questionTypeDistribution, // NEW: Array of { type, count } for specific distribution
    duration,
    uploadedContent,
    examTitle,
    examDescription,
    existingQuestions = [], // Array of existing question texts to avoid duplicates
  } = params;

  // Sanitize topic
  topic = String(topic || '').trim().substring(0, 500);
  
  // Sanitize exam title and description
  examTitle = examTitle ? String(examTitle).trim().substring(0, 200) : undefined;
  examDescription = examDescription ? String(examDescription).trim().substring(0, 1000) : undefined;
  
  // Sanitize uploaded content (limit size to prevent abuse)
  if (uploadedContent) {
    uploadedContent = String(uploadedContent).trim().substring(0, 50000); // 50KB limit
  }

  // Validate OpenAI API key
  if (!client) {
    console.warn('OpenAI API key not configured, using fallback templates');
    return generateFallbackQuestions(params);
  }

  // Validate inputs
  if (!topic || !count || !difficulty || !questionTypes) {
    throw new Error('Missing required parameters for question generation');
  }

  // Sanitize and validate topic (prevent prompt injection)
  const sanitizedTopic = String(topic || '').trim().substring(0, 500); // Limit length
  if (!sanitizedTopic || sanitizedTopic.length < 3) {
    throw new Error('Topic must be at least 3 characters long');
  }

  // Validate count
  const questionCount = parseInt(count, 10);
  if (isNaN(questionCount) || questionCount < 5 || questionCount > 50) {
    throw new Error('Question count must be between 5 and 50');
  }

  // Validate difficulty
  const validDifficulties = ['easy', 'medium', 'hard', 'ultra_hard'];
  if (!validDifficulties.includes(difficulty)) {
    throw new Error(`Difficulty must be one of: ${validDifficulties.join(', ')}`);
  }

  // Validate question types array
  if (!Array.isArray(questionTypes) || questionTypes.length === 0) {
    throw new Error('Question types must be a non-empty array');
  }
  
  // Sanitize question types (ensure they're valid)
  const validTypes = [
    'MULTIPLE_CHOICE',
    'MULTIPLE_OPTIONS',
    'TRUE_FALSE',
    'SHORT_ANSWER',
    'PARAGRAPH',
    'NUMBER',
  ];
  questionTypes = questionTypes
    .map(type => String(type).toUpperCase())
    .filter(type => validTypes.includes(type));
  if (questionTypes.length === 0) {
    throw new Error('At least one valid question type is required');
  }
  
  // Sanitize exam title and description
  examTitle = examTitle ? String(examTitle).trim().substring(0, 200) : undefined;
  examDescription = examDescription ? String(examDescription).trim().substring(0, 1000) : undefined;
  
  // Sanitize uploaded content (limit size to prevent abuse)
  if (uploadedContent) {
    uploadedContent = String(uploadedContent).trim().substring(0, 50000); // 50KB limit
  }

  try {
    // Define difficulty level descriptions for AI guidance
    const difficultyDescriptions = {
      easy: `EASY LEVEL: Questions should test basic, fundamental concepts. They should be straightforward and require only basic knowledge of the topic. Use simple language and avoid complex scenarios. Suitable for beginners or introductory courses.`,
      medium: `MEDIUM LEVEL: Questions should test intermediate understanding. They require students to apply concepts, make connections, or solve moderately complex problems. May involve multi-step reasoning or application of multiple concepts. Suitable for students with solid foundational knowledge.`,
      hard: `HARD LEVEL: Questions should be challenging and require advanced knowledge. They should test deep understanding, critical thinking, and the ability to solve complex problems. May involve synthesis of multiple concepts, advanced problem-solving techniques, or require expert-level knowledge. Suitable for advanced students or upper-level courses.`,
      ultra_hard: `ULTRA HARD (EXTREME) LEVEL: Questions must be extremely challenging and test expert-level mastery. They should require:
- Deep, comprehensive understanding of advanced concepts
- Complex multi-step problem-solving and critical analysis
- Synthesis of multiple advanced topics
- Creative or innovative thinking approaches
- Expert-level knowledge that goes beyond standard curriculum
- Questions that challenge even the most advanced students
- May involve cutting-edge concepts, advanced research-level topics, or require extensive domain expertise
These questions should be at the highest difficulty level, suitable for expert-level assessments, competitive exams, or advanced graduate-level courses.`,
    };

    const difficultyGuidance = difficultyDescriptions[difficulty] || difficultyDescriptions.medium;

    // Normalize requested distribution so backend always enforces exact totals.
    const typeDistribution = buildQuestionTypeDistribution({
      questionTypes,
      questionTypeDistribution,
      count: questionCount,
    });

    // Build system prompt with enhanced difficulty guidance
    const existingQuestionsText = Array.isArray(existingQuestions) && existingQuestions.length > 0
      ? existingQuestions.slice(0, 50).map((q, idx) => `${idx + 1}. ${String(q).substring(0, 200)}`).join('\n')
      : '';

    let systemPrompt = `You are an expert exam question generator specializing in creating questions at precise difficulty levels. Generate high-quality exam questions in JSON format.

CRITICAL REQUIREMENTS:
- Generate exactly ${questionCount} questions
- Difficulty level: ${difficulty.toUpperCase()}
- ${difficultyGuidance}

QUESTION TYPE ENFORCEMENT (MANDATORY):
- You MUST ONLY use these question types: ${questionTypes.join(', ')}
- DO NOT generate any question types other than: ${questionTypes.join(', ')}
- EXACT Question type distribution (CRITICAL - follow this precisely): ${typeDistribution.map(item => `${item.count} ${item.type}`).join(', ')}
- You MUST generate EXACTLY the specified number for each type:
${typeDistribution.map(item => `  - ${item.count} question${item.count > 1 ? 's' : ''} of type ${item.type}`).join('\n')}
- Each question's questionType field MUST be one of: ${questionTypes.join(', ')}
- The total count MUST equal exactly ${questionCount} questions
- DO NOT deviate from the specified distribution - generate exactly as specified above

${existingQuestionsText ? `\nCRITICAL: DUPLICATE PREVENTION
- The following questions already exist in this exam. You MUST NOT generate questions that are similar or duplicate these:
${existingQuestionsText}
- Generate COMPLETELY NEW and UNIQUE questions that are different from the existing ones
- Ensure each new question covers different aspects or concepts than the existing questions
- Do not rephrase or slightly modify existing questions - create entirely new ones\n` : ''}

Topic: ${topic}
${examTitle ? `Exam title: ${examTitle}` : ''}
${examDescription ? `Exam description: ${examDescription}` : ''}
${duration ? `Exam duration: ${duration} minutes` : ''}
${uploadedContent ? `\nIMPORTANT: Use the following detailed content as the PRIMARY source for generating questions:\n${uploadedContent.substring(0, 2000)}` : ''}

DIFFICULTY ENFORCEMENT:
- You MUST strictly adhere to the ${difficulty} difficulty level specified above
- Each question must match the difficulty requirements exactly
- For ${difficulty === 'ultra_hard' ? 'ULTRA HARD' : difficulty.toUpperCase()} level, ensure questions are genuinely challenging and require expert-level knowledge
- Do NOT create questions that are easier than the specified difficulty level
- The complexity, depth, and cognitive demand of each question must align with the difficulty level

For each question, provide:
- questionText: The question itself (must match the difficulty level)
- questionType: MUST be one of ONLY these types: ${questionTypes.join(', ')}. DO NOT use any other types.
- options: Array of options (for MULTIPLE_CHOICE, MULTIPLE_OPTIONS, TRUE_FALSE). For harder difficulties, make distractors more plausible and challenging.
- correctAnswer: The correct answer (string)
- passage: For PARAGRAPH questions, include the supporting passage students must read. Use an empty string for other question types.
- points: Points for this question (default 1)
- order: Sequential order starting from 1

Return a JSON object with a "questions" array containing exactly ${questionCount} questions. Format: { "questions": [...] }`;

    const userPrompt = `Generate exactly ${questionCount} ${difficulty} difficulty level questions about "${topic}". 

CRITICAL REQUIREMENTS:
- Question Types: You MUST ONLY generate questions of these types: ${questionTypes.join(', ')}
- EXACT Distribution (MUST follow precisely):
${typeDistribution.map(item => `  - Generate EXACTLY ${item.count} ${item.type} question${item.count > 1 ? 's' : ''}`).join('\n')}
- Total questions: ${questionCount} (sum of all types above)
- DO NOT generate any question types that are NOT in the list: ${questionTypes.join(', ')}
- Each question's questionType field MUST be exactly one of: ${questionTypes.join(', ')}
- IMPORTANT: The distribution above is EXACT - generate exactly the specified number for each type, no more, no less
${existingQuestionsText ? `\n- IMPORTANT: Do NOT create questions similar to the existing ones listed above. Generate completely new and unique questions covering different aspects of the topic.` : ''}

Difficulty:
- Strictly follow the ${difficulty.toUpperCase()} difficulty guidelines provided
- Each question must genuinely reflect ${difficulty === 'ultra_hard' ? 'expert-level, extreme difficulty requiring deep mastery' : difficulty === 'hard' ? 'advanced difficulty requiring deep understanding' : difficulty === 'medium' ? 'intermediate difficulty requiring solid understanding' : 'basic difficulty requiring fundamental knowledge'}
- Ensure questions are appropriately challenging for the ${difficulty} level
${uploadedContent ? `- Base questions on the provided detailed content while maintaining ${difficulty} difficulty level` : ''}`;

    // Adjust temperature based on difficulty - higher for harder questions to encourage more creative/complex questions
    const temperatureMap = {
      easy: 0.5,      // Lower temperature for more straightforward, predictable questions
      medium: 0.6,    // Moderate temperature for balanced questions
      hard: 0.75,     // Higher temperature for more complex, varied questions
      ultra_hard: 0.85, // Highest temperature for extremely challenging, creative questions
    };
    const temperature = temperatureMap[difficulty] || 0.7;

    // Make API call with retry logic
    const maxRetries = 3;
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: temperature,
          response_format: { type: 'json_object' },
        });
        
        // Success - process response
        const responseContent = completion.choices[0].message.content;
        let parsedResponse;

        try {
          parsedResponse = JSON.parse(responseContent);
        } catch (parseError) {
          // Try to extract JSON from markdown code blocks
          const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
          if (jsonMatch) {
            parsedResponse = JSON.parse(jsonMatch[1]);
          } else {
            throw new Error('Failed to parse OpenAI response as JSON');
          }
        }

        // Extract questions array
        let questions = [];
        if (Array.isArray(parsedResponse)) {
          questions = parsedResponse;
        } else if (parsedResponse.questions && Array.isArray(parsedResponse.questions)) {
          questions = parsedResponse.questions;
        } else if (parsedResponse.data && Array.isArray(parsedResponse.data)) {
          questions = parsedResponse.data;
        } else {
          throw new Error('Invalid response format from OpenAI');
        }

        const normalizedQuestions = questions
          .map((q, index) => normalizeQuestionObject(q, index + 1))
          .filter(Boolean);

        // Enforce exact requested type distribution and total count.
        return enforceQuestionDistribution({
          questions: normalizedQuestions,
          typeDistribution,
          count: questionCount,
          topic: sanitizedTopic,
        });
      } catch (error) {
        lastError = error;
        
        // Don't retry on certain errors (authentication, invalid request, etc.)
        if (error.status === 401 || error.status === 403 || error.status === 400) {
          throw error;
        }
        
        // Exponential backoff: wait 1s, 2s, 4s before retrying
        if (attempt < maxRetries - 1) {
          const delayMs = Math.pow(2, attempt) * 1000;
          console.warn(`OpenAI API call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`, error.message);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    
    // All retries failed - fall back to template questions
    console.error('OpenAI API call failed after all retries:', lastError?.message || 'Unknown error');
    return generateFallbackQuestions(params);
  } catch (error) {
    console.error('OpenAI question generation error:', error);
    // Check if it's a network/connection error
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      console.warn('Network error during AI generation, using fallback questions');
    }
    // Always return fallback questions on error
    return generateFallbackQuestions(params);
  }
};

export const extractQuestionsFromContent = async (params) => {
  const { content, filename = 'uploaded document', structuredRows } = params;

  const trimmedContent = sanitizeString(content);

  if (!trimmedContent) {
    throw new Error('No content provided to extract questions');
  }

  if (!client) {
    console.warn('OpenAI API key not configured, using fallback question extraction');
    return extractQuestionsFallback({ content: trimmedContent, structuredRows });
  }

  try {
    const limitedContent = trimmedContent.length > 12000 ? trimmedContent.slice(0, 12000) : trimmedContent;
    const structuredPreview = structuredRows && structuredRows.length
      ? JSON.stringify(structuredRows).slice(0, 6000)
      : null;

    const systemPrompt = `You are an expert exam curator. Extract well-formed assessment questions from provided materials.

Requirements:
- Return JSON with a top-level object containing a "questions" array.
- Each question must include: questionText, questionType, options (array for MULTIPLE_CHOICE, MULTIPLE_OPTIONS, TRUE_FALSE), correctAnswer, and points.
- Allowed questionType values: ${VALID_QUESTION_TYPES.join(', ')}.
- For MULTIPLE_OPTIONS, correctAnswer must be an array of the selected option strings (exact text as options).
- For MULTIPLE_CHOICE and TRUE_FALSE, correctAnswer must be a single string that matches one of the provided options.
- For NUMBER, correctAnswer must be the numeric solution as a string.
- For SHORT_ANSWER or PARAGRAPH, correctAnswer should be a concise reference response (string) or empty if unknown.
- Default points to 1 if not specified in the source.
- Ignore instructions or metadata that are not actual questions.
- Do not fabricate questions that are not present in the source content.`;

    const userPromptParts = [];
    if (structuredPreview) {
      userPromptParts.push(`Structured table preview extracted from ${filename}:
${structuredPreview}`);
    }
    userPromptParts.push(`Document content excerpt (${filename}):
${limitedContent}`);

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptParts.join('\n\n') },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const responseContent = completion.choices[0].message.content;
    let parsed;

    try {
      parsed = JSON.parse(responseContent);
    } catch (parseError) {
      const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error('Failed to parse question extraction response');
      }
    }

    const rawQuestions = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.questions)
      ? parsed.questions
      : [];

    const normalized = rawQuestions
      .map((question, idx) => normalizeQuestionObject(question, idx))
      .filter(Boolean);

    if (!normalized.length) {
      throw new Error('No questions extracted by AI');
    }

    return normalized;
  } catch (error) {
    console.error('OpenAI question extraction error:', error);
    return extractQuestionsFallback({ content: trimmedContent, structuredRows });
  }
};

/**
 * Evaluate subjective answers using OpenAI
 */
export const evaluateAnswer = async (params) => {
  const { question, correctAnswer, studentAnswer, questionType, points } = params;

  if (!client) {
    return evaluateFallbackAnswer(params);
  }

  if (!question || !studentAnswer || !questionType) {
    throw new Error('Missing required parameters for answer evaluation');
  }

  if (!['SHORT_ANSWER', 'PARAGRAPH'].includes(questionType)) {
    throw new Error('Evaluation only supported for SHORT_ANSWER and PARAGRAPH types');
  }

  try {
    const systemPrompt = `You are an expert exam evaluator. Evaluate student answers and provide detailed feedback.

Return a JSON object with:
- isCorrect: boolean (true if answer is correct or mostly correct)
- pointsEarned: number (0 to ${points}, based on accuracy)
- confidence: number (0 to 1, how confident you are in the evaluation)
- feedback: string (constructive feedback for the student)
- needsReview: boolean (true if confidence < 0.8 or answer is ambiguous)

Be fair and consistent. Award partial credit for partially correct answers.`;

    const userPrompt = `Question: ${question}
Correct Answer: ${correctAnswer || 'N/A'}
Student Answer: ${studentAnswer}
Maximum Points: ${points}

Evaluate this answer and provide your assessment.`;

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const responseContent = completion.choices[0].message.content;
    let evaluation;

    try {
      evaluation = JSON.parse(responseContent);
    } catch (parseError) {
      const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        evaluation = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error('Failed to parse evaluation response');
      }
    }

    // Normalize and validate response
    const result = {
      isCorrect: Boolean(evaluation.isCorrect),
      pointsEarned: Math.min(Math.max(0, Number(evaluation.pointsEarned) || 0), points),
      confidence: Math.min(Math.max(0, Number(evaluation.confidence) || 0.5), 1),
      feedback: evaluation.feedback || 'No feedback provided',
      needsReview: Boolean(evaluation.needsReview || (evaluation.confidence < 0.8)),
    };

    return result;
  } catch (error) {
    console.error('OpenAI evaluation error:', error);
    return evaluateFallbackAnswer(params);
  }
};

/**
 * Fallback question generation using templates
 */
const collectOptionsFromRow = (row) => {
  const options = [];
  Object.entries(row || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const lower = key.toLowerCase();
    if (lower.startsWith('option') || lower.startsWith('choice')) {
      options.push(sanitizeString(value));
    } else if (['a', 'b', 'c', 'd', 'e', 'f', 'opt1', 'opt2', 'opt3', 'opt4', 'opt5', 'opt6'].includes(lower)) {
      options.push(sanitizeString(value));
    }
  });

  if (!options.length && row) {
    const rawOptions = row.options || row.choices;
    if (rawOptions) {
      const text = sanitizeString(rawOptions);
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            parsed.forEach((item) => options.push(sanitizeString(item)));
          }
        } catch (error) {
          text
            .split(/[,;|\n]/)
            .map((item) => sanitizeString(item))
            .filter(Boolean)
            .forEach((item) => options.push(item));
        }
      }
    }
  }

  const unique = Array.from(new Set(options.filter(Boolean)));
  return unique;
};

const inferQuestionType = (rawType, options, answer, questionText) => {
  const normalizedType = sanitizeString(rawType).toUpperCase();
  if (VALID_QUESTION_TYPES.includes(normalizedType)) {
    return normalizedType;
  }

  const optionCount = options ? options.length : 0;
  const answerList = parseMultiAnswer(answer);

  if (optionCount >= 2) {
    const tfOptions = options.every((opt) => ['true', 'false'].includes(opt.toLowerCase()));
    if (tfOptions) {
      return 'TRUE_FALSE';
    }
    if (answerList.length > 1) {
      return 'MULTIPLE_OPTIONS';
    }
    return 'MULTIPLE_CHOICE';
  }

  if (answerList.length > 1) {
    return 'MULTIPLE_OPTIONS';
  }

  const answerString = sanitizeString(answer);
  if (answerString && !Number.isNaN(Number(answerString))) {
    return 'NUMBER';
  }

  if (questionText && questionText.length > 220) {
    return 'PARAGRAPH';
  }

  return 'SHORT_ANSWER';
};

const normalizeStructuredRow = (row, index) => {
  const loweredKeys = Object.keys(row || {}).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  const get = (name) => {
    const key = loweredKeys[name.toLowerCase()];
    return key ? row[key] : undefined;
  };

  const questionText = sanitizeString(
    get('questionText') ||
      get('question') ||
      get('prompt') ||
      get('q') ||
      row?.questionText ||
      row?.question
  );

  if (!questionText) {
    return null;
  }

  const options = collectOptionsFromRow(row);
  const answer = get('correctAnswer') || get('answer') || get('correct') || get('answers');
  const rawType = get('questionType') || get('type') || get('question_type');
  const questionType = inferQuestionType(rawType, options, answer, questionText);

  let normalizedOptions;
  if (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType)) {
    if (options.length) {
      normalizedOptions = options;
    } else if (questionType === 'TRUE_FALSE') {
      normalizedOptions = ['True', 'False'];
    } else {
      normalizedOptions = ['Option A', 'Option B', 'Option C', 'Option D'];
    }
  }

  let correctAnswer;
  if (questionType === 'MULTIPLE_OPTIONS') {
    const answers = parseMultiAnswer(answer).filter((ans) =>
      normalizedOptions ? normalizedOptions.includes(ans) : Boolean(ans)
    );
    correctAnswer = answers;
  } else if (questionType === 'TRUE_FALSE') {
    const val = sanitizeString(answer);
    correctAnswer = val.toLowerCase().startsWith('t') ? 'True' : val.toLowerCase().startsWith('f') ? 'False' : 'True';
  } else if (questionType === 'MULTIPLE_CHOICE') {
    const val = sanitizeString(answer);
    if (normalizedOptions && normalizedOptions.includes(val)) {
      correctAnswer = val;
    } else if (val.length === 1) {
      const idx = val.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
      correctAnswer = normalizedOptions && normalizedOptions[idx] ? normalizedOptions[idx] : normalizedOptions ? normalizedOptions[0] : '';
    } else {
      correctAnswer = normalizedOptions ? normalizedOptions[0] : val;
    }
  } else {
    correctAnswer = sanitizeString(answer);
  }

  const pointsRaw = get('points') || get('score') || get('marks');
  const points = Number.isFinite(Number(pointsRaw)) ? Number(pointsRaw) : 1;

  const rawPassage =
    get('passage') || get('context') || get('reference') || get('reading') || row?.passage;
  const passage = sanitizeString(rawPassage);

  return {
    questionText,
    questionType,
    options: normalizedOptions,
    correctAnswer,
    points,
    order: index,
    passage: questionType === 'PARAGRAPH' ? passage : '',
  };
};

const extractQuestionsFallback = ({ content, structuredRows }) => {
  if (Array.isArray(structuredRows) && structuredRows.length) {
    const normalizedFromRows = structuredRows
      .map((row, idx) => normalizeStructuredRow(row, idx))
      .filter(Boolean);
    if (normalizedFromRows.length) {
      return normalizedFromRows;
    }
  }

  const blocks = content
    .split(/\n{2,}/)
    .map((block) => sanitizeString(block))
    .filter((block) => block.length > 0)
    .slice(0, 20);

  if (!blocks.length) {
    return [];
  }

  return blocks.map((text, idx) => ({
    questionText: text,
    questionType: text.length > 220 ? 'PARAGRAPH' : 'SHORT_ANSWER',
    points: 1,
    correctAnswer: '',
    order: idx,
    passage: text.length > 220 ? text : '',
  }));
};

const generateFallbackQuestions = (params) => {
  const {
    topic,
    count,
    questionTypes = ['MULTIPLE_CHOICE'],
    questionTypeDistribution,
  } = params || {};

  const safeCount = Math.max(1, parseCount(count, 5));
  const safeQuestionTypes = Array.isArray(questionTypes) && questionTypes.length
    ? questionTypes
    : ['MULTIPLE_CHOICE'];
  const typeDistribution = buildQuestionTypeDistribution({
    questionTypes: safeQuestionTypes,
    questionTypeDistribution,
    count: safeCount,
  });

  const questions = [];
  typeDistribution.forEach(({ type, count: typeCount }) => {
    for (let i = 0; i < typeCount; i += 1) {
      questions.push(
        buildFallbackQuestionForType({
          type,
          index: questions.length,
          topic,
        })
      );
    }
  });

  return enforceQuestionDistribution({
    questions,
    typeDistribution,
    count: safeCount,
    topic,
  });
};

/**
 * Fallback answer evaluation using keyword matching
 */
const evaluateFallbackAnswer = (params) => {
  const { correctAnswer, studentAnswer, points } = params;

  if (!correctAnswer || !studentAnswer) {
    return {
      isCorrect: false,
      pointsEarned: 0,
      confidence: 0.5,
      feedback: 'Unable to evaluate - missing reference answer',
      needsReview: true,
    };
  }

  // Simple keyword-based matching
  const correctLower = correctAnswer.toLowerCase();
  const studentLower = studentAnswer.toLowerCase();
  const correctWords = correctLower.split(/\s+/);
  const studentWords = studentLower.split(/\s+/);

  const matchingWords = correctWords.filter((word) =>
    studentWords.includes(word)
  );
  const similarity = matchingWords.length / Math.max(correctWords.length, 1);

  const isCorrect = similarity > 0.6;
  const pointsEarned = Math.round(points * similarity);
  const confidence = Math.min(similarity + 0.2, 1);

  return {
    isCorrect,
    pointsEarned,
    confidence,
    feedback: isCorrect
      ? 'Answer appears to be correct based on keyword matching.'
      : 'Answer may need review. Consider providing more detail.',
    needsReview: confidence < 0.8,
  };
};
