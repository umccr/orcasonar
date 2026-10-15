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

/** Citations and search results quote this much of a passage. */
export const SNIPPET_CHARACTERS = 280;

export const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
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
