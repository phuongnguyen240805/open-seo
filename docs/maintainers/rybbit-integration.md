# Rybbit audit integration

`src/server/integrations/rybbit.ts` exposes a session-authenticated facade at
`/api/integrations/v1/`. `src/server.ts` lazy-loads it inside the normal database
and DataForSEO request scope. It does not change existing app server functions,
database schemas, hosted authentication, billing or iframe policies.

The paired Rybbit frontend uses a same-origin BFF to forward the individual
OpenSEO session. Supported pilot deployment: `AUTH_MODE=password`. The handler
requires a real account mode, a custom client header, and same-origin JSON for
writes; it provides no browser CORS access. Never replace this with a global
administrator credential or allow `local_noauth` for the integration.

## Contract

All successful responses use `{ data: ... }`; errors use `{ error: CODE }` and
`Cache-Control: private, no-store`. Routes:

- `GET session`: current user ID, email and active organization ID.
- `GET projects`: current organization's active project IDs, names and domains.
- `GET projects/:projectId/audits`: audit history.
- `POST projects/:projectId/audits`: the existing audit start input, excluding
  `projectId` (derived exclusively from the authorized path). Returns 202 and
  `{ data: { auditId } }`.
- `GET projects/:projectId/audits/:auditId`: workflow status.
- `GET projects/:projectId/audits/:auditId/results`: audit summary, page DTOs and
  issue DTOs, excluding crawler credentials, raw Lighthouse data and config.

The resolver checks live OpenSEO membership. Every audit route looks up the
project with its organization, and every audit lookup passes that project ID.
Creation calls the existing AuditService with the authenticated billing context
and capacity tier; URL validation, quota enforcement and workflow startup remain
inside that service. No implicit project is created by listing projects.

The initial frontend only starts technical audits with rendering off and
Lighthouse set to `none`. The API shares the existing bounded audit schema.

## Development

Use port 3003 for OpenSEO if Rybbit's backend runs on 3001 and its frontend on 3002. Set OpenSEO's `BETTER_AUTH_URL` to its actual origin. See the paired
Rybbit checkout's `OPENSEO_INTEGRATION.md` for BFF configuration and the manual
release gate. Existing self-host infrastructure and a populated project are
required for a real audit; contract tests do not provision Cloudflare resources.

This phase is standalone: Kedi SSO, persisted tenant/site mapping, additional
SEO modules and iframe embedding remain outside this audit MVP.
