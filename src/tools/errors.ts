/**
 * Tool errors. Every failure reaches the model as an `isError` tool result
 * (never a protocol error), with the API's own message, `error_code` and
 * `request_id`, and one concrete next step.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';

import type { BackendErrorInfo } from '../backend/types.js';

export const DASHBOARD_URL = 'https://bakbak.getraya.app';

export type ServerMode = 'local' | 'hosted';

export interface ToolErrorDetails {
  message: string;
  next_step: string;
  status?: number | undefined;
  error_code?: string | undefined;
  request_id?: string | undefined;
  retryable?: boolean | undefined;
}

/** An `isError` result: a one-line summary, then the details as JSON. */
export function toolError(details: ToolErrorDetails): CallToolResult {
  const error = Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined));
  return {
    isError: true,
    content: [
      { type: 'text', text: `Error: ${details.message} Next step: ${details.next_step}` },
      { type: 'text', text: JSON.stringify({ error }, null, 2) },
    ],
  };
}

export function missingKeyError(mode: ServerMode): CallToolResult {
  return toolError({
    message: 'No Bakbak API key is configured.',
    next_step:
      mode === 'local'
        ? `Create a key at ${DASHBOARD_URL}, set it as BAKBAK_API_KEY in this MCP server's environment (or the extension settings), and restart the server.`
        : `Reconnect with your Bakbak API key from ${DASHBOARD_URL}.`,
  });
}

export function rateLimitedError(retryAfterSeconds: number): CallToolResult {
  return toolError({
    message: 'Too many tool calls for this API key on this server.',
    next_step: `Wait ${Math.ceil(retryAfterSeconds)} s, then try again.`,
    retryable: true,
  });
}

function nextStepFor(info: BackendErrorInfo, mode: ServerMode, baseURL: string): string {
  if (info.type === 'StreamInterruptedError') {
    return 'The audio stream broke part-way, so nothing was saved. Try again; if it keeps failing, use shorter text.';
  }
  if (info.type === 'ServerShuttingDown') {
    return 'The MCP server is restarting. Nothing was saved; try again in a moment.';
  }
  if (info.type === 'WebSocketClosedError') {
    return 'The connection to Bakbak closed before the audio was finished, so nothing was saved. Try again.';
  }
  if (!info.connection && info.status === undefined && info.type === 'BakbakError') {
    return mode === 'local'
      ? 'Check BAKBAK_API_KEY (no spaces or line breaks) and BAKBAK_BASE_URL in the server environment.'
      : `Check the API key from ${DASHBOARD_URL} and connect again.`;
  }
  if (info.connection) {
    return info.type === 'APITimeoutError'
      ? 'The service took too long to answer. Try again in a moment, or with shorter text.'
      : `Could not reach the Bakbak API at ${baseURL}. Check the network connection${mode === 'local' ? ' and BAKBAK_BASE_URL' : ''}, then try again.`;
  }
  switch (info.status) {
    case 400:
    case 422:
      return "Fix the parameters named in the message. Use list_voices for a valid voice_id, and pass that voice's model and a language it supports.";
    case 401:
      return mode === 'local'
        ? `The API key in BAKBAK_API_KEY was rejected. Create a new key at ${DASHBOARD_URL} and update the server's environment.`
        : `Your Bakbak API key was rejected (it may have been revoked). Disconnect and reconnect with a current key from ${DASHBOARD_URL}.`;
    case 402:
      return `The account is out of credits. Add credits at ${DASHBOARD_URL}, then try again.`;
    case 403:
      return `This key is not allowed to do that. Check the key's permissions at ${DASHBOARD_URL}.`;
    case 404:
      return 'The voice (or resource) was not found. Call list_voices and use one of the ids it returns.';
    case 413:
      return 'The request is too large. Shorten the text.';
    case 429:
      return 'Too many requests at once for this account. Wait a few seconds and try again, one request at a time.';
    default:
      return info.retryable
        ? 'The service is busy or briefly unavailable. Wait a few seconds and try again.'
        : 'This request cannot succeed as sent. Check the parameters and the message above.';
  }
}

/** The tool result for an error thrown by the Bakbak client. */
export function apiError(
  info: BackendErrorInfo,
  mode: ServerMode,
  baseURL: string,
): CallToolResult {
  const audioNote =
    info.type === 'StreamInterruptedError' && info.audioBytes !== undefined
      ? ` (${info.audioBytes} bytes of audio arrived before the failure)`
      : '';
  return toolError({
    message: `${info.message}${audioNote}`,
    next_step: nextStepFor(info, mode, baseURL),
    status: info.status,
    error_code: info.errorCode,
    request_id: info.requestId,
    retryable: info.retryable,
  });
}
