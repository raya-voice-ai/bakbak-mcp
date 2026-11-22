/** One page of the developer documentation bundled with the server. */
export interface KnowledgePage {
  /** Stable id used by read_docs and in bakbak://docs/<id>, e.g. `start-here`. */
  id: string;
  /** `guide`: written for this pack; `reference`: SDK, plugin and API references; `example`: runnable code. */
  kind: 'guide' | 'reference' | 'example';
  title: string;
  /** One sentence: what the page covers. */
  description: string;
  /** Where the page lives publicly. */
  url: string;
  markdown: string;
}
