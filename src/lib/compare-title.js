export function normalizeTitleForCompare(value) {
  if (value == null) return null;
  let text = String(value).normalize("NFKC").toLowerCase();
  text = text.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

export function charNgrams(text, size) {
  if (!text) return [];
  if (text.length < size) return [text];
  const grams = [];
  for (let index = 0; index <= text.length - size; index += 1) {
    grams.push(text.slice(index, index + size));
  }
  return grams;
}

function gramCounts(grams) {
  const counts = new Map();
  for (const gram of grams) {
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

export function diceCoefficient(leftGrams, rightGrams) {
  if (leftGrams.length === 0 && rightGrams.length === 0) return 1;
  if (leftGrams.length === 0 || rightGrams.length === 0) return 0;

  const left = gramCounts(leftGrams);
  const right = gramCounts(rightGrams);
  let overlap = 0;
  for (const [gram, leftCount] of left) {
    const rightCount = right.get(gram);
    if (rightCount) overlap += Math.min(leftCount, rightCount);
  }
  return (2 * overlap) / (leftGrams.length + rightGrams.length);
}

export function roundScore(value) {
  return Math.round(value * 10000) / 10000;
}

export function titleSimilarity(leftTitle, rightTitle, options = {}) {
  const nGramSize = options.nGramSize ?? 3;
  const minLength = options.minLength ?? 12;
  const left = normalizeTitleForCompare(leftTitle);
  const right = normalizeTitleForCompare(rightTitle);
  if (!left || !right) {
    return { comparable: false, score: null, exact: false };
  }
  const exact = left === right;
  if (left.length < minLength || right.length < minLength) {
    return { comparable: false, score: exact ? 1 : null, exact };
  }
  const score = roundScore(
    diceCoefficient(charNgrams(left, nGramSize), charNgrams(right, nGramSize))
  );
  return { comparable: true, score, exact };
}
