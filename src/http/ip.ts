/**
 * IP address helpers: which peers are trusted proxies, the real client
 * address behind them, and whether an address is publicly routable (for
 * fetching client metadata documents without reaching internal networks).
 */

import { BlockList, isIP } from 'node:net';

/** Loopback and private ranges: the default trusted proxies (Caddy on a Docker network). */
export const DEFAULT_TRUSTED_PROXIES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
];

/** Strips IPv6 zone ids and unwraps IPv4-mapped IPv6 (`::ffff:1.2.3.4`). */
export function normalizeIp(address: string | undefined): string | undefined {
  if (!address) return undefined;
  let value = address.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped?.[1]) value = mapped[1];
  return isIP(value) ? value : undefined;
}

function family(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 4 ? 'ipv4' : 'ipv6';
}

export class CidrError extends Error {
  override readonly name = 'CidrError';
}

/** Builds a matcher from CIDRs (or bare addresses). */
export function cidrList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of cidrs) {
    const [rawAddress = '', rawPrefix] = entry.trim().split('/');
    const address = normalizeIp(rawAddress);
    if (!address) throw new CidrError(`Not an IP address or CIDR: "${entry}"`);
    const type = family(address);
    const max = type === 'ipv4' ? 32 : 128;
    const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new CidrError(`Bad prefix length in "${entry}"`);
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

/** Parses `TRUSTED_PROXIES` (comma or space separated CIDRs); unset means the defaults, empty means none. */
export function parseTrustedProxies(value: string | undefined): BlockList {
  if (value === undefined) return cidrList(DEFAULT_TRUSTED_PROXIES);
  return cidrList(value.split(/[\s,]+/).filter(Boolean));
}

function contains(list: BlockList, address: string): boolean {
  return list.check(address, family(address));
}

export interface ClientAddressInput {
  peer: string | undefined;
  cfConnectingIp: string | undefined;
  forwardedFor: string | undefined;
}

/**
 * The client's address. Forwarding headers count only when the direct peer is
 * a trusted proxy: then `CF-Connecting-IP` (set by Cloudflare), else the
 * right-most `X-Forwarded-For` entry that is not itself a trusted proxy.
 */
export function clientAddress(input: ClientAddressInput, trusted: BlockList): string {
  const peer = normalizeIp(input.peer) ?? 'unknown';
  if (peer === 'unknown' || !contains(trusted, peer)) return peer;
  const cf = normalizeIp(input.cfConnectingIp);
  if (cf) return cf;
  const hops = (input.forwardedFor ?? '')
    .split(',')
    .map((h) => normalizeIp(h))
    .filter((h): h is string => h !== undefined);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop !== undefined && !contains(trusted, hop)) return hop;
  }
  return hops[0] ?? peer;
}

/** Everything that is not globally routable unicast. */
const NON_PUBLIC = cidrList([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/3', // multicast, reserved and broadcast
  '2001::/32', // Teredo
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4, which can embed private IPv4
]);

/** Global unicast IPv6 lives in 2000::/3; everything else (loopback, ULA, link-local, mapped, NAT64…) is not public. */
const GLOBAL_IPV6 = cidrList(['2000::/3']);

/** True only for publicly routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const ip = normalizeIp(address);
  if (!ip) return false;
  if (family(ip) === 'ipv6' && !contains(GLOBAL_IPV6, ip)) return false;
  return !contains(NON_PUBLIC, ip);
}

/** The eight 16-bit groups of an IPv6 address, as numbers. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - left.length - right.length;
  return [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right].map(
    (g) => Number.parseInt(g, 16),
  );
}

/**
 * The key a per-address rate limit counts against: the address itself for
 * IPv4, and its /64 for IPv6, since one subscriber usually holds a whole /64
 * and could otherwise rotate through it to dodge the limit.
 */
export function rateLimitKey(address: string): string {
  const ip = normalizeIp(address);
  if (!ip || isIP(ip) === 4) return ip ?? address;
  return `${ipv6Groups(ip)
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}
