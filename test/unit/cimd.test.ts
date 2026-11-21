import { describe, expect, it } from 'vitest';

import {
  ClientMetadataError,
  fetchDocument,
  isMetadataDocumentUrl,
  parseDocument,
} from '../../src/http/oauth/cimd.js';

describe('CIMD fetching', () => {
  it('accepts only https URLs on the default port with a path', () => {
    expect(isMetadataDocumentUrl('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe(true);
    expect(isMetadataDocumentUrl('https://claude.ai')).toBe(false);
    expect(isMetadataDocumentUrl('https://claude.ai:444/x')).toBe(false);
    expect(isMetadataDocumentUrl('http://claude.ai/x')).toBe(false);
    expect(isMetadataDocumentUrl('https://claude.ai/x#f')).toBe(false);
  });

  it('never connects to a non-public address', async () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest',
      'https://localhost/x',
    ]) {
      await expect(fetchDocument(new URL(url))).rejects.toThrow();
    }
    await expect(fetchDocument(new URL('https://10.0.0.1/x'))).rejects.toBeInstanceOf(
      ClientMetadataError,
    );
  });

  it('validates documents', () => {
    expect(() => parseDocument('https://a.example/c', 'not json')).toThrow(ClientMetadataError);
    expect(() =>
      parseDocument('https://a.example/c', JSON.stringify({ client_id: 'https://a.example/c' })),
    ).toThrow(/redirect_uris/);
    expect(
      parseDocument(
        'https://a.example/c',
        JSON.stringify({
          client_id: 'https://a.example/c',
          redirect_uris: ['https://a.example/cb'],
        }),
      ),
    ).toMatchObject({
      client_id: 'https://a.example/c',
    });
  });
});
