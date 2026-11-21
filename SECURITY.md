# Security

## Reporting a vulnerability

Email **support@getraya.app** with "Security" in the subject. Please include what you found,
how to reproduce it, and its impact. Do not open a public issue for security problems.

We acknowledge reports within three working days, keep you informed while we fix the issue,
and credit you in the release notes if you wish.

## Supported versions

Security fixes go into the latest release. The hosted server at `mcp.bakbak.si` always runs a
supported version.

## How this server handles secrets

- API keys are never tool arguments, never logged, and never included in error messages.
- Local mode reads the key from `BAKBAK_API_KEY` and sends it only to the configured API base
  URL.
- Hosted mode stores no keys: the key exists only inside AES-256-GCM sealed tokens held by the
  client (access tokens one hour, refresh tokens 30 days), sealed with `MCP_TOKEN_SECRET`.
  Rotating that secret, or deleting the key in the Bakbak dashboard, revokes access.
- OAuth requires PKCE S256, exact redirect URI matching (any port on a loopback redirect, as
  RFC 8252 allows), `https` or loopback redirects only, and a CSRF-protected consent form.
- Client ID metadata documents are fetched only over `https` on port 443 from public
  addresses, without redirects, within 5 seconds and 64 KiB.
- Generated audio in hosted mode lives for one hour behind an unguessable 128-bit link.
