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

/**
 * Generate exam questions using OpenAI
 */
export const generateQuestions = async (params) => {
  const {
    topic,
    count,
    difficulty,
    questionTypes,
    duration,
    uploadedContent,
    examTitle,
    examDescription,
  } = params;

  // Validate OpenAI API key
  if (!client) {
    console.warn('OpenAI API key not configured, using fallback templates');
    return generateFallbackQuestions(params);
  }

  // Validate inputs
  if (!topic || !count || !difficulty || !questionTypes) {
    throw new Error('Missing required parameters for question generation');
  }

  if (count < 5 || count > 50) {
    throw new Error('Question count must be between 5 and 50');
  }

  const validTypes = [
    'MULTIPLE_CHOICE',
    'MULTIPLE_OPTIONS',
    'TRUE_FALSE',
    'SHORT_ANSWER',
    'PARAGRAPH',
    'NUMBER',
  ];

  const invalidTypes = questionTypes.filter((t) => !validTypes.includes(t));
  if (invalidTypes.length > 0) {
    throw new Error(`Invalid question types: ${invalidTypes.join(', ')}`);
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

    // Calculate distribution of question types
    const questionsPerType = Math.floor(count / questionTypes.length);
    const remainder = count % questionTypes.length;
    const typeDistribution = questionTypes.map((type, idx) => ({
      type,
      count: questionsPerType + (idx < remainder ? 1 : 0)
    })).filter(item => item.count > 0);

    // Build system prompt with enhanced difficulty guidance
    let systemPrompt = `You are an expert exam question generator specializing in creating questions at precise difficulty levels. Generate high-quality exam questions in JSON format.

CRITICAL REQUIREMENTS:
- Generate exactly ${count} questions
- Difficulty level: ${difficulty.toUpperCase()}
- ${difficultyGuidance}

QUESTION TYPE ENFORCEMENT (MANDATORY):
- You MUST ONLY use these question types: ${questionTypes.join(', ')}
- DO NOT generate any question types other than: ${questionTypes.join(', ')}
- Question type distribution: ${typeDistribution.map(item => `${item.count} ${item.type}`).join(', ')}
- Each question's questionType field MUST be one of: ${questionTypes.join(', ')}
- If multiple types are selected, distribute questions across all selected types
- If only one type is selected, ALL ${count} questions must be of that type

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

Return ONLY a valid JSON array, no markdown, no code blocks.`;

    const userPrompt = `Generate exactly ${count} ${difficulty} difficulty level questions about "${topic}". 

CRITICAL REQUIREMENTS:
- Question Types: You MUST ONLY generate questions of these types: ${questionTypes.join(', ')}
- Distribution: ${typeDistribution.map(item => `Generate ${item.count} ${item.type} question${item.count > 1 ? 's' : ''}`).join(', ')}
- DO NOT generate any question types that are NOT in the list: ${questionTypes.join(', ')}
- Each question's questionType field MUST be exactly one of: ${questionTypes.join(', ')}

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

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: temperature,
      response_format: { type: 'json_object' },
    });

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

    // Validate and normalize questions, ensuring they match selected question types
    const normalizedQuestions = questions.slice(0, count).map((q, index) => {
      let questionType = sanitizeString(q.questionType || q.type || '').toUpperCase();
      
      // Validate question type - must be one of the selected types
      if (!questionTypes.includes(questionType)) {
        // If AI generated wrong type, assign from selected types in round-robin fashion
        questionType = questionTypes[index % questionTypes.length];
        console.warn(`Question ${index + 1} had invalid type "${q.questionType}", corrected to "${questionType}"`);
      }
      
      return {
        questionText: q.questionText || q.question || '',
        questionType: questionType,
        options: q.options || (['MULTIPLE_CHOICE', 'MULTIPLE_OPTIONS', 'TRUE_FALSE'].includes(questionType) 
          ? (questionType === 'TRUE_FALSE' ? ['True', 'False'] : ['Option A', 'Option B', 'Option C', 'Option D'])
          : undefined),
        correctAnswer: q.correctAnswer || q.answer || '',
        points: q.points || 1,
        order: q.order || index + 1,
        passage:
          sanitizeString(
            q.passage ||
              q.context ||
              (questionType === 'PARAGRAPH' ? (q.reference || q.sourceText || '') : '')
          ) || '',
      };
    });

    // Final validation: Ensure all questions have valid types
    const validatedQuestions = normalizedQuestions.map((q, idx) => {
      if (!questionTypes.includes(q.questionType)) {
        q.questionType = questionTypes[idx % questionTypes.length];
      }
      return q;
    });

    return validatedQuestions;
  } catch (error) {
    console.error('OpenAI question generation error:', error);
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
  const { topic, count, difficulty, questionTypes } = params;
  const questions = [];

  for (let i = 0; i < Math.min(count, 10); i++) {
    const type = questionTypes[i % questionTypes.length];
    questions.push({
      questionText: `Sample ${type} question ${i + 1} about ${topic}?`,
      questionType: type,
      options: type.includes('MULTIPLE') || type === 'TRUE_FALSE'
        ? ['Option A', 'Option B', 'Option C', 'Option D']
        : undefined,
      correctAnswer: 'Sample correct answer',
      points: 1,
      order: i + 1,
      passage: type === 'PARAGRAPH' ? `Sample reading passage about ${topic} for comprehension.` : '',
    });
  }

  return questions;
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

