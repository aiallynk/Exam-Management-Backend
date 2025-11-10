import mongoose from 'mongoose';
import SessionAssignment from '../models/SessionAssignment.js';
import QuestionPaper from '../models/QuestionPaper.js';

const normalizeIdValue = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === 'object' && value._id) {
    const inner = value._id;
    if (typeof inner === 'string') return inner;
    if (inner instanceof mongoose.Types.ObjectId) return inner.toString();
    return String(inner);
  }
  return String(value);
};

const ensureArrayOfIds = (ids) => {
  if (!ids) return [];
  if (!Array.isArray(ids)) return [normalizeIdValue(ids)].filter(Boolean);
  return ids.map(normalizeIdValue).filter(Boolean);
};

const getQuestionPaperPool = async (session) => {
  const candidateIds = ensureArrayOfIds(session.questionPaperIds);
  if (!candidateIds.length && session.questionPaperId) {
    candidateIds.push(normalizeIdValue(session.questionPaperId));
  }

  if (!candidateIds.length) {
    return { ids: [], papers: [] };
  }

  const papers = await QuestionPaper.find({ _id: { $in: candidateIds } }, 'setName').lean();
  const paperMap = new Map(papers.map((paper) => [paper._id.toString(), paper]));
  const ids = candidateIds.filter((id) => paperMap.has(id));

  return { ids, papers: ids.map((id) => paperMap.get(id)) };
};

const chooseRandom = (ids, lastAssigned) => {
  if (!ids.length) return null;
  const filtered = ids.filter((id) => id !== lastAssigned);
  const pool = filtered.length ? filtered : ids;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
};

const chooseSequential = async (sessionId, ids) => {
  if (!ids.length) return null;
  const lastAssignment = await SessionAssignment.findOne({ sessionId }).sort({ orderIndex: -1 });
  const nextIndex = ((lastAssignment?.orderIndex ?? -1) + 1) % ids.length;
  return { id: ids[nextIndex], orderIndex: (lastAssignment?.orderIndex ?? -1) + 1 };
};

export const assignQuestionPaperToStudent = async ({ session, userId, modeOverride }) => {
  const mode = modeOverride || session.distributionMode || 'single';
  const existing = await SessionAssignment.findOne({
    sessionId: session._id,
    userId,
  }).populate('questionPaperId', 'setName');

  if (existing) {
    return existing;
  }

  const { ids, papers } = await getQuestionPaperPool(session);

  if (!ids.length) {
    throw new Error('No question sets available for this session.');
  }

  let selectedId = ids[0];
  let orderIndex = 0;

  if (mode === 'random') {
    const lastPaper = await SessionAssignment.findOne({ sessionId: session._id })
      .sort({ orderIndex: -1 })
      .lean();
    const lastAssigned = lastPaper?.questionPaperId?.toString() || session.distributionState?.lastAssignedPaper?.toString();
    selectedId = chooseRandom(ids, lastAssigned);
    orderIndex = (lastPaper?.orderIndex ?? -1) + 1;
  } else if (mode === 'sequential') {
    const result = await chooseSequential(session._id, ids);
    selectedId = result.id;
    orderIndex = result.orderIndex;
  } else if (mode === 'roll') {
    const assignmentsCount = await SessionAssignment.countDocuments({ sessionId: session._id });
    const nextIndex = assignmentsCount % ids.length;
    selectedId = ids[nextIndex];
    orderIndex = assignmentsCount;
  } else {
    // single or manual fallback
    selectedId = ids[0];
    const last = await SessionAssignment.findOne({ sessionId: session._id })
      .sort({ orderIndex: -1 })
      .lean();
    orderIndex = (last?.orderIndex ?? -1) + 1;
  }

  const assignment = await SessionAssignment.create({
    sessionId: session._id,
    userId,
    questionPaperId: selectedId,
    orderIndex,
  });

  if (!session.distributionState) {
    session.distributionState = {};
  }
  session.distributionState.lastAssignedPaper = selectedId;
  session.distributionState.lastAssignedIndex = orderIndex % ids.length;
  await session.save();

  await assignment.populate('questionPaperId', 'setName');
  return assignment;
};


