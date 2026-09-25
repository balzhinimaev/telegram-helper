import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreEvidenceWhitespace } from '../evidence-repair.js';

const source = (id, text) => ({ id, text });

test('restores exact newlines, tabs and nonbreaking spaces without mutating evidence', () => {
  const evidence = { id: '1', quote: 'Да, я хочу встретиться.' };
  const original = 'До встречи. Да,\n\tя\u00a0хочу  встретиться. Пока.';
  const repaired = restoreEvidenceWhitespace(evidence, [source('1', original)]);
  assert.equal(repaired.quote, 'Да,\n\tя\u00a0хочу  встретиться.');
  assert.equal(repaired.id, evidence.id);
  assert(original.includes(repaired.quote));
  assert.equal(evidence.quote, 'Да, я хочу встретиться.');
});

test('an exact quote is not touched even when inherited context does not include it', () => {
  const evidence = { id: '1', quote: 'точные слова' };
  assert.strictEqual(restoreEvidenceWhitespace(evidence, [source('1', 'точные слова')], []), evidence);
});

test('reductions repair only inside a single inherited same-ID exact span', () => {
  const evidence = { id: '1', quote: 'Я не хочу' };
  const segments = [source('1', 'Ответ: Я\nне хочу. Но подумаю.')];
  assert.equal(restoreEvidenceWhitespace(evidence, segments, [{ id: '1', quote: 'Я\nне хочу.' }]).quote, 'Я\nне хочу');
  for (const prior of [[], [{ id: '2', quote: 'Я\nне хочу.' }], [{ id: '1', quote: 'Я' }, { id: '1', quote: 'не хочу' }], [{ id: '1', quote: 'Я не хочу.' }]]) {
    assert.strictEqual(restoreEvidenceWhitespace(evidence, segments, prior), evidence);
  }
});

test('does not change IDs, words, negation, punctuation, case or Unicode spelling', () => {
  for (const [quote, segments] of [
    ['Хочу встречи', [source('2', 'Хочу\nвстречи')]],
    ['Я хочу встречи', [source('1', 'Я\nне хочу встречи')]],
    ['я хочу встречи', [source('1', 'Я\nхочу встречи')]],
    ['Я хочу встречи...', [source('1', 'Я\nхочу встречи.')]],
    ['Я хочу ещё', [source('1', 'Я\nхочу еще')]],
    ['Я хочу', [source('1', 'Я\u200bхочу')]],
  ]) {
    const evidence = { id: '1', quote };
    assert.strictEqual(restoreEvidenceWhitespace(evidence, segments), evidence);
  }
});

test('does not join different messages, source segments or disjoint passages', () => {
  const evidence = { id: '1', quote: 'хочу встречи' };
  for (const segments of [
    [source('1', 'хочу'), source('2', 'встречи')],
    [source('1', 'хочу'), source('1', ' встречи')],
    [source('1', 'хочу\nувидеться, а потом встречи')],
  ]) assert.strictEqual(restoreEvidenceWhitespace(evidence, segments), evidence);
});

test('rejects repeated normalized occurrences even if one fits inherited context', () => {
  const evidence = { id: '1', quote: 'Хочу встречи' };
  const segments = [source('1', 'Хочу\nвстречи. Хочу  встречи.')];
  assert.strictEqual(restoreEvidenceWhitespace(evidence, segments), evidence);
  assert.strictEqual(restoreEvidenceWhitespace(evidence, segments, [{ id: '1', quote: 'Хочу\nвстречи' }]), evidence);
  assert.strictEqual(restoreEvidenceWhitespace(evidence, [source('1', 'Хочу\nвстречи'), source('1', 'Хочу\nвстречи')]), evidence);
});

test('preserves Unicode code points and keeps repaired quote within 180-character limit', () => {
  const evidence = { id: '1', quote: '🙂 Я хочу' };
  assert.equal(restoreEvidenceWhitespace(evidence, [source('1', '🙂\nЯ хочу')]).quote, '🙂\nЯ хочу');
  const short = { id: '1', quote: 'Я хочу' };
  assert.strictEqual(restoreEvidenceWhitespace(short, [source('1', 'Я' + ' '.repeat(180) + 'хочу')]), short);
  const long = { id: '1', quote: 'Я ' + '🙂'.repeat(179) };
  assert.strictEqual(restoreEvidenceWhitespace(long, [source('1', 'Я\n' + '🙂'.repeat(179))]), long);
});

test('malformed inputs are unchanged for strict validator to reject, not silently dropped', () => {
  for (const evidence of [null, {}, { id: 1, quote: 'x' }, { id: '1', quote: '' }, { id: '1', quote: ' \n ' }]) {
    assert.strictEqual(restoreEvidenceWhitespace(evidence, [source('1', 'x')]), evidence);
  }
  const evidence = { id: '1', quote: 'a b' };
  assert.strictEqual(restoreEvidenceWhitespace(evidence, null), evidence);
  assert.strictEqual(restoreEvidenceWhitespace(evidence, [source('1', 'a\nb')], {}), evidence);
});
