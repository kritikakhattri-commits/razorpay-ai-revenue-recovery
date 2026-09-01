<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:revenue-recovery-engineering-rules -->

# AI Revenue Recovery — Engineering Rules

These rules apply to all code in this repository. They exist to keep financial logic safe, auditable, and maintainable.

## Language

- Use TypeScript throughout. No plain `.js` files in `src/` or `app/`. Enable `strict: true` (already set in `tsconfig.json`).

## Architecture

- Keep business logic separate from UI. Route handlers and Server Actions are allowed to call service functions, but UI components must not contain business logic directly.
- Organise the domain in layers that mirror the architecture:
  ```
  app/            — Next.js routes and UI only
  src/
    domain/       — pure business logic, no framework dependencies
    services/     — orchestration, calls domain + integrations
    integrations/ — external system adapters (one file per external system)
    lib/          — shared utilities with no domain knowledge
  ```

## Types

- Prefer strongly typed structured objects over loosely typed primitives (e.g. `PaymentId` branded type instead of `string`).
- Define shared domain types in `src/domain/types.ts`. Never import UI types into domain files.
- Avoid `any`. Use `unknown` at trust boundaries and narrow with type guards.

## AI Safety

- AI must never directly execute financial actions (refunds, retries, charges, webhooks).
- All AI recommendations must be represented as a typed `RecoveryRecommendation` object and must pass through a deterministic `PolicyEngine` before any action is taken.
- The `PolicyEngine` is the only code allowed to produce an `ApprovedAction`. Everything else produces a `Recommendation`.
- AI model calls belong in `src/services/ai/` and must be wrapped so they can be replaced or disabled without touching callers.

## External Integrations

- Every external system (Razorpay API, email provider, SMS gateway, etc.) must be accessed through an interface defined in `src/integrations/`.
- No integration code may appear in domain or service files directly.
- Use environment variables for credentials; validate their presence at server startup, not at call time.

## Auditability

- Every recovery decision (recommended, approved, rejected, executed) must produce an `AuditEntry` and be written to an audit store before any action is taken.
- Audit entries are append-only. Never mutate or delete them.
- Include at minimum: `timestamp`, `paymentId`, `action`, `source` (`ai` | `policy` | `manual`), `outcome`, and `actorId`.

## Security

- Never expose API keys, secrets, or server-only environment variables to client-side code.
- All `process.env.*` access for secrets must be in Server Components, Route Handlers, or `src/integrations/`. Never import these into `'use client'` files.
- Validate all inputs that cross trust boundaries (webhook payloads, API request bodies) with explicit type guards or a validation library.

## Testing

- Add unit tests for all business-critical logic in `src/domain/` and `src/services/`.
- Tests live alongside the code they test: `src/domain/policyEngine.test.ts` next to `src/domain/policyEngine.ts`.
- Do not mock the database or audit store in integration tests — use a real in-process implementation.

<!-- END:revenue-recovery-engineering-rules -->
