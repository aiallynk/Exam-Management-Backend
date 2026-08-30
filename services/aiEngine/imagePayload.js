const parseDataUri = (dataUri) => {
  const match = String(dataUri || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
};

export const imageUrlToGeminiInlinePart = (imageUrl) => {
  const inline = parseDataUri(imageUrl);
  if (!inline) return null;
  return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
};
