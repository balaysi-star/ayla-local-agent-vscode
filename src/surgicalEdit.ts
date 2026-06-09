export interface SurgicalEditResult {
  content: string;
  changed: boolean;
  lineCountChanged: number;
}

function countOccurrences(content: string, expected: string): number {
  if (!expected) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(expected, index);
    if (found < 0) {
      return count;
    }
    count += 1;
    index = found + expected.length;
  }
}

function lineDelta(before: string, after: string): number {
  return Math.abs(before.split(/\r?\n/).length - after.split(/\r?\n/).length);
}

export function applyPatchWithExpectedText(currentContent: string, expectedOldText: string, replacement: string): SurgicalEditResult {
  const matches = countOccurrences(currentContent, expectedOldText);
  if (matches !== 1) {
    throw new Error("AMBIGUOUS_PATCH_TARGET");
  }
  return {
    content: currentContent.replace(expectedOldText, replacement),
    changed: expectedOldText !== replacement,
    lineCountChanged: lineDelta(expectedOldText, replacement)
  };
}

export function editFileSpan(currentContent: string, startLine: number, endLine: number, replacement: string): SurgicalEditResult {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("INVALID_EDIT_SPAN");
  }
  const lines = currentContent.split(/\r?\n/);
  if (endLine > lines.length) {
    throw new Error("EDIT_SPAN_OUT_OF_RANGE");
  }
  const replacementLines = replacement.split(/\r?\n/);
  const removed = lines.slice(startLine - 1, endLine).join("\n");
  const next = [
    ...lines.slice(0, startLine - 1),
    ...replacementLines,
    ...lines.slice(endLine)
  ].join("\n");
  return {
    content: next,
    changed: removed !== replacement,
    lineCountChanged: Math.abs((endLine - startLine + 1) - replacementLines.length)
  };
}

export function readFileRangeContent(content: string, startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("INVALID_READ_RANGE");
  }
  const lines = content.split(/\r?\n/);
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join("\n");
}

export function isPatchTooBroad(result: SurgicalEditResult, maxLineDelta = 80): boolean {
  return result.lineCountChanged > maxLineDelta;
}

