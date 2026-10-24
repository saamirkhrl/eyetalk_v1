import { type CategoryId, findWord } from '../core/config.ts';

const SYSTEM = [
  'You are the voice of a person who cannot speak. They communicate by looking at concept',
  'words on an eye-gaze board, and you say the sentence they mean.',
  'Rules:',
  '- Write as the person, in first person, talking to a caregiver or someone close to them.',
  "- Every sentence must be 2 to 10 words and use all the selected words' meaning.",
  '- Never explain or define the words. Say what the person means.',
  '- Plain text only: no markdown, no quotes, no explanations, no advice.',
].join('\n');

/**
 * extra instructions for the two kinds of word that change the sentence's
 * shape rather than its content. deliberately not a per-word category tag:
 * given "water (need)", the 0.6b model writes "water is a need." - it defines
 * the tags instead of speaking for the person.
 */
export function promptHints(concepts: string[]): string[] {
  const words = concepts.map((c) => findWord(c)).filter((w) => w !== undefined);
  const has = (cat: CategoryId) => words.filter((w) => w.category === cat);
  const hints: string[] = [];
  const questions = has('questions');
  if (questions.length) {
    hints.push(`Every sentence is a question the person asks, using "${questions[0]!.label.toLowerCase()}".`);
  }
  const replies = has('replies');
  if (replies.length) {
    hints.push(`Every sentence starts with "${replies[0]!.label}".`);
  }
  return hints;
}

const EXAMPLE_WORDS = 'bathroom';
const EXAMPLE_LINES = [
  'I need to use the bathroom.',
  'Can you take me to the bathroom, please?',
  'I have to go now, please help me.',
];

const BLOCKED = new Set(EXAMPLE_LINES.map(normalise));

export interface PromptInput {
  concepts: string[];
  /** most recent spoken sentences, oldest first. */
  history: string[];
  count: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildMessages({ concepts, history, count }: PromptInput): ChatMessage[] {
  const example =
    `Example.\nSelected words: ${EXAMPLE_WORDS}\n` +
    EXAMPLE_LINES.map((l, i) => `${i + 1}. ${l}`).join('\n');

  const lines = [example, '', 'Now write the sentences for these words.'];
  // only the most recent turn is included: a 0.6b model given three lines of
  // history starts answering the history instead of the current selection.
  const last = history.at(-1);
  if (last) lines.push(`Earlier they said: "${last}"`);
  lines.push(`Selected words: ${concepts.join(', ')}`);
  lines.push(...promptHints(concepts));
  lines.push(`Output exactly ${count} numbered lines and nothing else.`);

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/** pull clean sentences out of whatever the model produced. */
export function parseCandidates(raw: string, count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (let line of raw.split('\n')) {
    line = line
      .trim()
      // "1." / "1)" / "-" / "*" list markers
      .replace(/^\s*\d+\s*[.)\]:-]\s*/, '')
      .replace(/^[-*•]\s*/, '')
      // markdown emphasis the model sometimes wraps sentences in
      .replace(/\*\*/g, '')
      .replace(/^["'“‘]+|["'”’]+$/g, '')
      .trim();

    if (line.length < 3 || line.length > 140) continue;
    if (/^(sure|here (are|is)|option|sentence|output|note|example)\b/i.test(line)) continue;
    // a "sentence" with no space is a decode artefact, not language.
    if (!/\s/.test(line)) continue;
    if (isDegenerate(line)) continue;

    const key = normalise(line);
    if (!key || BLOCKED.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(capitalise(line));
    if (out.length >= count) break;
  }
  return out;
}

/** cheap detector for a broken decode. */
export function isDegenerate(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  // no english word is 24 characters. run-together decodes always are.
  if (words.some((w) => w.length > 24)) return true;
  if (words.length >= 4) {
    const counts = new Map<string, number>();
    for (const w of words) {
      const k = w.toLowerCase().replace(/[^a-z]/g, '');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = Math.max(...counts.values());
    if (top / words.length > 0.4) return true;
  }
  // mostly non-letters means we are looking at punctuation or token ids.
  const letters = (text.match(/[a-zA-Z]/g) ?? []).length;
  return letters / text.length < 0.55;
}

function capitalise(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * template data for every word on the board. `alone` is used verbatim when the
 * word is the whole selection. `part` is the fragment the combiner below slots
 * into a sentence when it is one of several: a noun phrase for needs and
 * people, what follows "i am" for feelings, a bare verb for actions, and the
 * interjection itself for quick replies. question words instead carry `ask`, a
 * frame per kind of word they can ask about.
 */
interface WordTemplate {
  alone: [string, string, string];
  part?: string;
  ask?: { thing: string; person: string; action: string; feeling?: string };
}

const TEMPLATES: Record<string, WordTemplate> = {
  // needs
  water: { alone: ['Can I have some water, please?', 'I would like some water.', 'I am thirsty.'], part: 'water' },
  food: { alone: ['I am hungry.', 'Can I have something to eat?', 'I would like some food, please.'], part: 'food' },
  bathroom: {
    alone: ['I need to use the bathroom.', 'Can you take me to the bathroom?', 'I need the bathroom, please.'],
    part: 'the bathroom',
  },
  medicine: { alone: ['I need my medicine.', 'Is it time for my medicine?', 'Can I have my medicine, please?'], part: 'my medicine' },
  help: { alone: ['I need help, please.', 'Can someone help me?', 'I need help right now.'], part: 'help' },
  more: { alone: ['I would like some more, please.', 'Can I have more?', 'A little more, please.'], part: 'more' },
  blanket: { alone: ['Can I have a blanket, please?', 'I need my blanket.', 'Please cover me with a blanket.'], part: 'my blanket' },
  phone: { alone: ['Can I have my phone, please?', 'I need my phone.', 'Please bring me my phone.'], part: 'my phone' },
  // feelings
  hurt: { alone: ['I am in pain.', 'Something hurts.', 'I am hurting, please help.'], part: 'in pain' },
  tired: { alone: ['I am tired.', 'I need to rest now.', 'I am very tired today.'], part: 'tired' },
  happy: { alone: ['I am happy.', 'I feel good today.', 'This makes me happy.'], part: 'happy' },
  sad: { alone: ['I feel sad.', 'I am sad today.', 'I need some comfort.'], part: 'sad' },
  scared: { alone: ['I am scared.', 'I feel afraid, please stay with me.', 'Something is scaring me.'], part: 'scared' },
  cold: { alone: ['I am cold.', 'Can you make it warmer?', 'I feel cold, please help.'], part: 'cold' },
  hot: { alone: ['I am too hot.', 'Can you make it cooler?', 'I feel hot, please help.'], part: 'hot' },
  sick: { alone: ['I feel sick.', 'I do not feel well.', 'I think I am sick.'], part: 'sick' },
  // people
  mom: { alone: ['I want my mom.', 'Can you call my mom?', 'Where is my mom?'], part: 'my mom' },
  dad: { alone: ['I want my dad.', 'Can you call my dad?', 'Where is my dad?'], part: 'my dad' },
  brother: { alone: ['I want to see my brother.', 'Can you call my brother?', 'Where is my brother?'], part: 'my brother' },
  sister: { alone: ['I want to see my sister.', 'Can you call my sister?', 'Where is my sister?'], part: 'my sister' },
  friend: { alone: ['I want to see my friend.', 'Can you call my friend?', 'Is my friend coming?'], part: 'my friend' },
  nurse: { alone: ['I need the nurse.', 'Please call the nurse.', 'Can the nurse come here?'], part: 'the nurse' },
  doctor: { alone: ['I need to see the doctor.', 'Please call the doctor.', 'When is the doctor coming?'], part: 'the doctor' },
  caregiver: { alone: ['I need my caregiver.', 'Please get my caregiver.', 'Where is my caregiver?'], part: 'my caregiver' },
  // actions
  stop: { alone: ['Please stop.', 'Stop, I need a moment.', 'Stop now.'], part: 'stop' },
  wait: { alone: ['Please wait.', 'Wait a moment, please.', 'Wait, I am not done.'], part: 'wait' },
  go: { alone: ['I want to go.', 'Can we go now?', 'Let us go, please.'], part: 'go' },
  eat: { alone: ['I want to eat.', 'Can I eat now?', 'I am ready to eat.'], part: 'eat' },
  drink: { alone: ['I want a drink.', 'Can I have something to drink?', 'I am ready to drink.'], part: 'drink' },
  sleep: { alone: ['I want to sleep.', 'I am ready for bed.', 'Please let me sleep.'], part: 'sleep' },
  move: { alone: ['Please help me move.', 'Can you change my position?', 'I am uncomfortable, please move me.'], part: 'move' },
  read: { alone: ['I want to read.', 'Can I have something to read?', 'Please read to me.'], part: 'read' },
  // questions
  what: {
    alone: ['What is happening?', 'What did you say?', 'What is that?'],
    ask: { thing: 'What about {x}?', person: 'What did {x} say?', action: 'What happens if I {x}?', feeling: 'What can help? I am {x}.' },
  },
  where: {
    alone: ['Where are we?', 'Where are you going?', 'Where is everyone?'],
    ask: { thing: 'Where is {x}?', person: 'Where is {x}?', action: 'Where can I {x}?' },
  },
  when: {
    alone: ['When are we leaving?', 'When will you be back?', 'When is it happening?'],
    ask: { thing: 'When can I have {x}?', person: 'When is {x} coming?', action: 'When can I {x}?' },
  },
  who: {
    alone: ['Who is there?', 'Who is coming today?', 'Who are you?'],
    ask: { thing: 'Who can get me {x}?', person: 'Who is calling {x}?', action: 'Who will help me {x}?' },
  },
  why: {
    alone: ['Why?', 'Why is this happening?', 'Why are we doing this?'],
    ask: { thing: "Why can't I have {x}?", person: 'Why is {x} not here?', action: "Why can't I {x}?", feeling: 'Why am I {x}?' },
  },
  how: {
    alone: ['How are you?', 'How did it go?', 'How does this work?'],
    ask: { thing: 'How do I get {x}?', person: 'How is {x}?', action: 'How do I {x}?' },
  },
  'how-long': {
    alone: ['How long will this take?', 'How long do I have to wait?', 'How long until we go?'],
    ask: { thing: 'How long until I get {x}?', person: 'How long until {x} comes?', action: 'How long do I have to {x}?', feeling: 'How long will I be {x}?' },
  },
  'are-you': {
    alone: ['Are you all right?', 'Are you coming back?', 'Are you listening?'],
    ask: { thing: 'Are you bringing {x}?', person: 'Are you {x}?', action: 'Are you going to help me {x}?', feeling: 'Are you {x}?' },
  },
  // quick replies
  yes: { alone: ['Yes, please.', 'Yes, that is right.', 'Yes.'], part: 'Yes' },
  no: { alone: ['No, thank you.', 'No, not that.', 'No.'], part: 'No' },
  maybe: { alone: ['Maybe.', 'Maybe later.', 'I am not sure yet, maybe.'], part: 'Maybe' },
  please: { alone: ['Please.', 'Yes, please.', 'Please help me.'], part: 'Please' },
  'thank-you': { alone: ['Thank you.', 'Thank you so much.', 'Thank you for your help.'], part: 'Thank you' },
  okay: { alone: ['Okay.', 'Okay, that is fine.', 'Okay, go ahead.'], part: 'Okay' },
  'not-now': { alone: ['Not now, please.', 'Not right now.', 'Maybe later, not now.'], part: 'Not now' },
  'not-sure': { alone: ['I am not sure.', 'I do not know.', 'Let me think about it.'], part: 'Not sure' },
};

function and(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * one sentence that uses every picked word, built from each word's role rather
 * than its position: "where" + "mom" asks "where is my mom?", "yes" + "water"
 * says "yes, i need water." a question word takes the first need, person or
 * action (or failing those, feeling) as what it asks about; any other words get
 * a plain clause each; a quick reply leads the whole thing.
 */
function combine(words: Array<{ id: string; category: CategoryId }>): string {
  const of = (cat: CategoryId) => words.filter((w) => w.category === cat).map((w) => w.id);
  const needs = of('needs');
  const people = of('people');
  const actions = of('actions');
  const feelings = of('feelings');
  const questions = of('questions');
  const replies = of('replies');
  const part = (id: string) => TEMPLATES[id]!.part!;

  const asked: string[] = [];
  for (const q of questions) {
    const t = TEMPLATES[q]!;
    const frame = (f: string, x: string) => f.replace('{x}', x);
    if (people.length) asked.push(frame(t.ask!.person, part(people.shift()!)));
    else if (needs.length) asked.push(frame(t.ask!.thing, part(needs.shift()!)));
    else if (actions.length) asked.push(frame(t.ask!.action, part(actions.shift()!)));
    else if (feelings.length && t.ask!.feeling) asked.push(frame(t.ask!.feeling, part(feelings.shift()!)));
    else asked.push(t.alone[0]);
  }

  // remaining words get one clause per category, in the order the user first
  // picked from each, so "water" then "cold" says the water part first.
  const clause: Partial<Record<CategoryId, string>> = {
    questions: asked.join(' ') || undefined,
    feelings: feelings.length ? `I am ${and(feelings.map(part))}.` : undefined,
    needs: needs.length ? `I need ${and(needs.map(part))}.` : undefined,
    people: people.length ? `I want ${and(people.map(part))}.` : undefined,
    actions: actions.length ? `I want to ${and(actions.map(part))}.` : undefined,
  };
  const order = [...new Set(words.map((w) => w.category))];
  const clauses = order.map((c) => clause[c]).filter((c): c is string => !!c);

  const lead = replies.map(part);
  if (!clauses.length) return `${lead.join(', ')}.`;
  let text = clauses.join(' ');
  if (lead.length) {
    const first = text.startsWith('I ') ? text : text.charAt(0).toLowerCase() + text.slice(1);
    text = `${lead.join(', ')}, ${first}`;
  }
  return text;
}

/** deterministic sentences built from templates. */
export function fallbackSentences(concepts: string[], count = 3): string[] {
  if (!concepts.length) return [];

  const words = concepts.map((c) => findWord(c));
  const out: string[] = [];

  if (words.every((w) => w && TEMPLATES[w.id])) {
    const known = words as Array<NonNullable<(typeof words)[number]>>;
    if (known.length === 1) {
      // a single word with a canned phrasing: use it verbatim, it reads better
      // than anything a template can assemble.
      out.push(...TEMPLATES[known[0]!.id]!.alone);
    } else {
      // several words: one sentence that weaves them together, then each
      // word's own phrasing in pick order - always grammatical, if longer.
      out.push(combine(known));
      for (const i of [0, 1, 2] as const) {
        out.push(known.map((w) => TEMPLATES[w.id]!.alone[i]).join(' '));
      }
    }
  }

  const seen = new Set<string>();
  const unique = (list: string[]) =>
    list.filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  // the same filter the model's output goes through: a join like "please stop.
  // yes, please." repeats itself enough to read as broken, so it is dropped.
  const result = unique(out.filter((s) => !isDegenerate(s)));
  if (result.length < count) {
    const joined = concepts.join(' ');
    result.push(
      ...unique([
        `I need ${joined}.`,
        `Can I have ${joined}, please?`,
        `${joined.charAt(0).toUpperCase()}${joined.slice(1)}, please.`,
      ]),
    );
  }
  return result.slice(0, count);
}
