/*
 * vocabulary checks: every word on the board must be usable by both sentence
 * paths - tagged correctly in the language-model prompt, and turned into real
 * sentences by the template fallback the board shows whenever the model is
 * missing, slow, or wrong.
 */
import assert from 'node:assert';
import { CATEGORIES, VOCABULARY, conceptText, findWord } from '../src/core/config.ts';
import { buildMessages, fallbackSentences, isDegenerate, promptHints } from '../src/nlp/prompt.ts';

/** a template sentence must look like a finished sentence, not a fill-in. */
function assertSentence(s, context) {
  assert.ok(typeof s === 'string' && s.trim().length > 0, `empty sentence for ${context}`);
  assert.ok(!/[{}]|undefined/.test(s), `unfilled template for ${context}: "${s}"`);
  assert.ok(/^[A-Z]/.test(s), `sentence does not start with a capital for ${context}: "${s}"`);
  assert.ok(/[.!?]$/.test(s), `sentence does not end with punctuation for ${context}: "${s}"`);
  assert.ok(!isDegenerate(s), `sentence fails the degenerate-output check for ${context}: "${s}"`);
}

{
  // eight per ring keeps every ring at the 45 degree spacing layoutring solves for.
  for (const c of CATEGORIES) {
    assert.strictEqual(c.words.length, 8, `${c.id} has ${c.words.length} words, expected 8`);
  }
  const labels = VOCABULARY.map((w) => w.label.toLowerCase());
  const ids = VOCABULARY.map((w) => w.id);
  assert.strictEqual(new Set(labels).size, labels.length, 'word labels must be unique');
  assert.strictEqual(new Set(ids).size, ids.length, 'word ids must be unique');
  for (const w of VOCABULARY) {
    assert.strictEqual(findWord(conceptText(w.label))?.id, w.id, `findWord cannot find "${w.label}"`);
    assert.strictEqual(findWord(w.id)?.id, w.id, `findWord cannot find id "${w.id}"`);
  }
  console.log(`    ${CATEGORIES.length} categories, ${VOCABULARY.length} words`);
  console.log('ok  every ring has eight unique, findable words');
}

{
  // a word with no canned phrasing would fall through to "i need <word>." -
  // fine for "help", nonsense for "why". every word needs its own.
  for (const w of VOCABULARY) {
    const c = conceptText(w.label);
    const out = fallbackSentences([c], 3);
    assert.strictEqual(out.length, 3, `"${c}" produced ${out.length} sentences`);
    for (const s of out) assertSentence(s, `"${c}"`);
    assert.ok(!out.includes(`Can I have ${c}, please?`), `"${c}" fell through to the generic template`);
  }
  console.log('ok  template fallback has its own sentences for every single word');
}

{
  // every pair across two different categories, both orders.
  let pairs = 0;
  for (const a of VOCABULARY) {
    for (const b of VOCABULARY) {
      if (a.category === b.category) continue;
      const concepts = [conceptText(a.label), conceptText(b.label)];
      const out = fallbackSentences(concepts, 3);
      assert.strictEqual(out.length, 3, `${concepts.join(' + ')} produced ${out.length} sentences`);
      for (const s of out) assertSentence(s, concepts.join(' + '));
      pairs++;
    }
  }
  console.log(`    ${pairs} cross-category pairs checked`);
  for (const concepts of [['where', 'mom'], ['yes', 'water'], ['when', 'eat'], ['why', 'tired'], ['thank you', 'nurse']]) {
    console.log(`    ${concepts.join(' + ')} -> ${fallbackSentences(concepts, 1)[0]}`);
  }
  console.log('ok  template fallback combines words from any two categories');
}

{
  // question words and quick replies change the sentence's shape, so the
  // model is told how; every other word goes through as just the word.
  for (const w of VOCABULARY) {
    const c = conceptText(w.label);
    const hints = promptHints([c]);
    const expected = w.category === 'questions' || w.category === 'replies' ? 1 : 0;
    assert.strictEqual(hints.length, expected, `"${c}" got ${hints.length} prompt hints`);
    const user = buildMessages({ concepts: [c], history: [], count: 3 }).find((m) => m.role === 'user').content;
    assert.ok(user.includes(`Selected words: ${c}\n`), `"${c}" missing from the prompt`);
  }
  const user = buildMessages({ concepts: ['where', 'mom', 'yes'], history: [], count: 3 }).find((m) => m.role === 'user').content;
  assert.ok(user.includes('Every sentence is a question the person asks, using "where".'), user);
  assert.ok(user.includes('Every sentence starts with "Yes".'), user);
  console.log('ok  prompt includes every word, with shape hints for questions and quick replies');
}

console.log('\nall vocabulary checks passed');
