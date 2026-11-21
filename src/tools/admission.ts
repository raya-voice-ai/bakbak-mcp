/**
 * Hosted mode's limits on text_to_speech, checked before any credits are
 * spent: a cap on one call's estimated output, a cap on calls running at once
 * per key, and a server-wide budget of estimated bytes being produced.
 */

import type { ToolErrorDetails } from './errors.js';

export interface AdmissionOptions {
  /** Most audio one call may produce (estimated), in bytes. */
  maxOutputBytes: number;
  /** Most text_to_speech calls running at once for one key. */
  perKeyConcurrency: number;
  /** Most estimated bytes being produced at once, across all calls. */
  inflightBytes: number;
}

export interface Ticket {
  /** Frees the call's share; call exactly once, when the call ends. */
  release(): void;
}

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;

export class Admission {
  private readonly running = new Map<string, number>();
  private inflight = 0;

  constructor(private readonly options: AdmissionOptions) {}

  /** Admits a call for `owner` expected to produce `estimatedBytes`, or explains why not. */
  admit(owner: string, estimatedBytes: number): Ticket | { refused: ToolErrorDetails } {
    if (estimatedBytes > this.options.maxOutputBytes) {
      return {
        refused: {
          message: `This request could produce up to ${mb(estimatedBytes)} of audio, more than this server makes in one call (${mb(this.options.maxOutputBytes)}).`,
          next_step:
            'Use mp3, pcm_s16le or a lower sample_rate, or split the text across several calls.',
          retryable: false,
        },
      };
    }
    const running = this.running.get(owner) ?? 0;
    if (running >= this.options.perKeyConcurrency) {
      return {
        refused: {
          message: `${running} text_to_speech calls are already running for this API key (the limit is ${this.options.perKeyConcurrency}).`,
          next_step: 'Wait for one of them to finish, then try again.',
          retryable: true,
        },
      };
    }
    if (this.inflight + estimatedBytes > this.options.inflightBytes) {
      return {
        refused: {
          message: 'The server is busy with other long syntheses.',
          next_step: 'Try again in a minute, or use shorter text.',
          retryable: true,
        },
      };
    }
    this.running.set(owner, running + 1);
    this.inflight += estimatedBytes;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inflight -= estimatedBytes;
        const left = (this.running.get(owner) ?? 1) - 1;
        if (left > 0) this.running.set(owner, left);
        else this.running.delete(owner);
      },
    };
  }
}
