import { Jimp } from 'jimp';
import { getPrivateObjectBuffer, putPrivateObject } from '../storage/imageStorage.js';
import { normalizeRegion } from './answerAnnotationService.js';

export const createSegmentCrop = async ({ script, page, segmentKey, region }) => {
  const normalized = normalizeRegion(region);
  const sourceKey = page?.workingImage?.key || page?.image?.key;
  if (!normalized || !sourceKey) return null;
  const source = await getPrivateObjectBuffer({ key: sourceKey });
  if (!source?.length) return null;
  const image = await Jimp.read(source);
  const paddingX = normalized.width * 0.04;
  const paddingY = normalized.height * 0.08;
  const x = Math.max(0, normalized.x - paddingX);
  const y = Math.max(0, normalized.y - paddingY);
  const width = Math.min(1 - x, normalized.width + paddingX * 2);
  const height = Math.min(1 - y, normalized.height + paddingY * 2);
  const crop = image.clone().crop({
    x: Math.floor(x * image.bitmap.width),
    y: Math.floor(y * image.bitmap.height),
    w: Math.max(1, Math.floor(width * image.bitmap.width)),
    h: Math.max(1, Math.floor(height * image.bitmap.height)),
  });
  const buffer = await crop.getBuffer('image/jpeg', { quality: 88 });
  const stored = await putPrivateObject({
    tenantId: script.tenantId,
    category: 'answer-script-crops',
    subpath: [String(script.examId), String(script._id)],
    fileStem: segmentKey,
    extension: 'jpg',
    buffer,
    contentType: 'image/jpeg',
  });
  return { key: stored.key, sizeBytes: buffer.length };
};

