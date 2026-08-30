import ContextSource from '../models/ContextSource.js';
import ContextChunk from '../models/ContextChunk.js';
import LibraryResource from '../models/LibraryResource.js';
import { runEngineChatCompletion } from './aiEngine/aiEngineClient.js';
import { AI_OPERATIONS } from './aiEngine/aiOperations.js';
import { resolveTenantFeature } from './tenantFeatureService.js';
import { logError } from '../utils/logger.js';

const METADATA_PROMPT = `Analyze this academic content excerpt and return JSON with optional suggested metadata only:
title, resourceType, subject, chapter, unit, topic, language, academicLevel, keywords.
Use UNKNOWN for fields you cannot infer. Do not include tenant or permission fields.`;

export const enrichContentMetadata = async ({ tenantId, userId, sourceId, resourceId = null }) => {
  const indexing = await resolveTenantFeature(tenantId, 'AI_CONTENT_INDEXING');
  if (!indexing?.effectiveEnabled) return { enriched: false, reason: 'AI_CONTENT_INDEXING disabled' };

  const source = await ContextSource.findOne({ _id: sourceId, tenantId }).lean();
  if (!source || source.status !== 'READY') return { enriched: false, reason: 'Source not ready' };

  const chunk = await ContextChunk.findOne({ tenantId, sourceId }).select('text').lean();
  const textForModel = String(chunk?.text || '').slice(0, 6000);

  if (!textForModel.trim()) return { enriched: false, reason: 'No text for enrichment' };

  const completion = await runEngineChatCompletion({
    operation: AI_OPERATIONS.CONTENT_METADATA_ENRICHMENT,
    tenantId,
    userId,
    feature: 'content_metadata_enrichment',
    request: {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: METADATA_PROMPT },
        { role: 'user', content: textForModel },
      ],
    },
  });

  let detected = {};
  try {
    detected = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
  } catch {
    detected = {};
  }

  await ContextSource.updateOne(
    { _id: sourceId, tenantId },
    { $set: { detectedMetadata: detected, metadataEnrichedAt: new Date() } }
  );

  if (resourceId) {
    const resource = await LibraryResource.findOne({ _id: resourceId, tenantId });
    if (resource) {
      if (!resource.chapter && detected.chapter && detected.chapter !== 'UNKNOWN') resource.chapter = String(detected.chapter).slice(0, 200);
      if (!resource.unit && detected.unit && detected.unit !== 'UNKNOWN') resource.unit = String(detected.unit).slice(0, 200);
      if (!resource.topic && detected.topic && detected.topic !== 'UNKNOWN') resource.topic = String(detected.topic).slice(0, 200);
      resource.metadata = {
        ...(resource.metadata || {}),
        detected: detected,
      };
      await resource.save();
    }
  }

  return { enriched: true, detected };
};
