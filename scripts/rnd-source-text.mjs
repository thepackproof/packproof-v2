// Source identity for generated text is independent of checkout line endings
// and filesystem separators. Original captured evidence is never normalized.
export const sourceText = text => text.replace(/\r\n/g, '\n');
export const sourceName = name => name.replace(/\\/g, '/');
