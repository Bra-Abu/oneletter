const wordListPath = require('word-list');
const fs = require('fs');

let WORDS = new Set();

function loadWords() {
  const content = fs.readFileSync(wordListPath, 'utf8');
  const allWords = content.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
  WORDS = new Set(allWords.filter(w => w.length >= 3 && w.length <= 8 && /^[a-z]+$/.test(w)));
  console.log(`Loaded ${WORDS.size} words (3–8 letters)`);
}

function isValidWord(word) {
  return WORDS.has(word.toLowerCase());
}

function isOneLetterDiff(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diffs++;
    if (diffs > 1) return false;
  }
  return diffs === 1;
}

function getDiff(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a.length !== b.length) return [];
  const diff = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff.push(i);
  }
  return diff;
}

module.exports = { loadWords, isValidWord, isOneLetterDiff, getDiff };
