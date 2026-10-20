import type { Passage } from './retrieval';

/** One earlier exchange in the conversation. */
export interface Turn {
  readonly question: string;
  readonly answer: string;
}

/** A message for the model, in the Converse API's shape. */
export type MessageContent =
  | { text: string }
  | { guardContent: { text: { text: string; qualifiers: ('grounding_source' | 'query')[] } } };

export interface Message {
  role: 'user' | 'assistant';
  content: MessageContent[];
}

/** Turns of history kept in the prompt: enough for follow-up questions, few enough to keep cost flat. */
export const HISTORY_TURNS = 6;

export const SYSTEM_PROMPT = [
  'You are OrcaSonar, the documentation assistant for UMCCR, the University of Melbourne Centre for Cancer Research.',
  'Answer only from the numbered sources in the latest message. If they do not contain the answer, say that the',
  'documentation does not cover it, and suggest what to search for instead. Never invent commands, names or links.',
  'Cite the sources you use with their numbers in square brackets, like [1] or [2][3], right after the sentence they',
  'support. Be brief and practical: lead with the answer, then the steps or details. Write Markdown for a narrow chat',
  'panel: short paragraphs, numbered steps or bullet lists, **bold** for the key facts, `code` for commands, paths and',
  'identifiers, and fenced code blocks for anything to copy. No headings, and a table only for a short comparison.',
].join(' ');

/** The sources block: numbered passages with their titles and links. */
export const formatSources = (passages: readonly Passage[]): string =>
  passages
    .map(
      (passage, index) => `[${index + 1}] ${passage.title} (${passage.url})\n${passage.text.trim()}`
    )
    .join('\n\n');

/**
 * The conversation for the model. The latest question and its sources go in guard content blocks, so the guardrail's
 * grounding check knows which text is the source and which the query.
 */
export const buildMessages = (
  question: string,
  passages: readonly Passage[],
  history: readonly Turn[]
): Message[] => [
  ...history.slice(-HISTORY_TURNS).flatMap((turn): Message[] => [
    { role: 'user', content: [{ text: turn.question }] },
    { role: 'assistant', content: [{ text: turn.answer }] },
  ]),
  {
    role: 'user',
    content: [
      { text: 'Sources:' },
      {
        guardContent: { text: { text: formatSources(passages), qualifiers: ['grounding_source'] } },
      },
      { text: 'Question:' },
      { guardContent: { text: { text: question, qualifiers: ['query'] } } },
    ],
  },
];

/** Characters the guardrail checks on the way in: the sources and the question. */
export const guardedInputCharacters = (question: string, passages: readonly Passage[]) =>
  question.length + formatSources(passages).length;

/**
 * The passages the answer cites, in the order it first cites them. When it cites none (a short answer, or the model
 * forgot), every passage it was given is listed instead, so the reader can still check.
 */
export const citedPassages = (answer: string, passages: readonly Passage[]): Passage[] => {
  const cited: Passage[] = [];
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const passage = passages[Number(match[1]) - 1];
    if (passage && !cited.includes(passage)) {
      cited.push(passage);
    }
  }
  return cited.length > 0 ? cited : [...passages];
};

/** Said instead of calling the model when retrieval finds nothing relevant. */
export const NOT_COVERED =
  "I couldn't find this in UMCCR's documentation. Try different words, or use Search to see the closest pages.";
