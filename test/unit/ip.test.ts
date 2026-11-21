import { describe, expect, it } from 'vitest';

import {
  CidrError,
  clientAddress,
  isPublicAddress,
  normalizeIp,
  parseTrustedProxies,
} from '../../src/http/ip.js';

const trusted = parseTrustedProxies(undefined);

describe('client address', () => {
  it('ignores forwarding headers from untrusted peers', () => {
    expect(
      clientAddress(
        { peer: '203.0.113.9', cfConnectingIp: '1.1.1.1', forwardedFor: '8.8.8.8' },
        trusted,
      ),
    ).toBe('203.0.113.9');
  });

  it('uses CF-Connecting-IP from a trusted proxy', () => {
    expect(
      clientAddress(
        { peer: '172.18.0.2', cfConnectingIp: '198.51.100.7', forwardedFor: '1.2.3.4' },
        trusted,
      ),
    ).toBe('198.51.100.7');
  });

  it('falls back to the right-most untrusted X-Forwarded-For hop', () => {
    expect(
      clientAddress(
        {
          peer: '::ffff:127.0.0.1',
          cfConnectingIp: undefined,
          forwardedFor: '6.6.6.6, 198.51.100.7, 10.0.0.3',
        },
        trusted,
      ),
    ).toBe('198.51.100.7');
  });

  it('falls back to the peer when nothing usable is forwarded', () => {
    expect(
      clientAddress(
        { peer: '10.0.0.2', cfConnectingIp: 'not-an-ip', forwardedFor: undefined },
        trusted,
      ),
    ).toBe('10.0.0.2');
  });

  it('can trust nothing', () => {
    expect(
      clientAddress(
        { peer: '10.0.0.2', cfConnectingIp: '1.1.1.1', forwardedFor: undefined },
        parseTrustedProxies(''),
      ),
    ).toBe('10.0.0.2');
  });

  it('rejects malformed TRUSTED_PROXIES', () => {
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(CidrError);
    expect(() => parseTrustedProxies('example.com')).toThrow(CidrError);
  });
});

describe('public addresses', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    '2002:a00:1::1',
    'not-an-ip',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('normalises brackets, zones and IPv4-mapped forms', () => {
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
});
