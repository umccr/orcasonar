import type { Turn } from './prompt';

/** A passage from the knowledge base, with the metadata the docs export attached to its page. */
export interface Passage {
  /** The page's `doc_id`: `<site slug>:<path>`. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly site: string;
  readonly text: string;
  readonly score: number;
}

export interface RetrieveOptions {
  /** Limit to these docs sites (slugs); every site when absent. */
  readonly sites?: readonly string[];
  readonly topK: number;
}

export interface Retriever {
  retrieve(query: string, options: RetrieveOptions): Promise<Passage[]>;
}

/** Passages for the answer: this many from the reranked, hybrid search. */
export const ANSWER_PASSAGES = 8;

/** The longest question the API takes, and so the longest query retrieval is sent. */
export const MAX_QUESTION_CHARACTERS = 2000;

/**
 * What to search the documentation for. A follow-up such as "and in prod?" names little to search for on its own, so
 * the question before it comes first, shortened to keep the query within a question's length. Only retrieval uses
 * this: the model and the guardrail get the conversation and the question as the reader asked it.
 */
export const retrievalQuery = (question: string, history: readonly Turn[]): string => {
  const previous = history.at(-1)?.question;
  const room = MAX_QUESTION_CHARACTERS - question.length - 1;
  return previous && room > 0 ? `${previous.slice(0, room)}\n${question}` : question;
};

/** Citations and search results quote this much of a passage. */
export const SNIPPET_CHARACTERS = 280;

/**
 * A passage's Markdown as plain text, for quoting on one line: a link's text without its target, and no heading, quote,
 * bold, strikethrough, code or table marks. Single `*` and `_` stay: they are as often part of a name as emphasis.
 */
export const plainText = (markdown: string): string =>
  markdown
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/\*\*|~~|`+/g, '')
    .replace(/\|/g, ' ');

export const snippet = (text: string): string => {
  const flat = plainText(text).replace(/\s+/g, ' ').trim();
  return flat.length <= SNIPPET_CHARACTERS ? flat : `${flat.slice(0, SNIPPET_CHARACTERS - 1)}…`;
};

/** A passage as clients see it, in citations and search results: no full text. */
export const toSource = (passage: Passage) => ({
  id: passage.id,
  title: passage.title,
  url: passage.url,
  site: passage.site,
  snippet: snippet(passage.text),
  score: Math.round(passage.score * 1000) / 1000,
});

/** A passage the answer cites: its source, with the number the answer cites it by, as in `[2]`. */
export const toCitation = (passage: Passage, ref: number) => ({ ...toSource(passage), ref });
