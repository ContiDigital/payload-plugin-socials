# ADR 0001: Keep model intelligence outside the publishing plugin

- Status: Accepted
- Date: 2026-07-20
- Owners: Maintainers

## Context

The plugin needs to serve human operators, deterministic automations, and AI agents without coupling publication reliability to a model vendor or agent framework. We considered asynchronous AI copy transforms, an “Optimize” action in the composer, and a bundled MCP server.

The plugin already exposes a complete authenticated HTTP action surface. A caller can generate copy, obtain approval, discover destinations, validate, publish, reconcile, and inspect history without the plugin owning inference.

## Decision

1. The plugin does not call an AI model or ship model credentials.
2. Synchronous `transformations`, `copyOverrides`, and stored templates remain deterministic copy seams for host applications and operators.
3. Agents and headless services use the existing HTTP endpoints. They own copy generation, approval policy, and stable `publicationKey` assignment.
4. The initial public package does not bundle an MCP server. An independent adapter may wrap the HTTP contract if a concrete integration needs MCP.

## Rationale

- Publication infrastructure and generative judgment have different security, reliability, latency, and cost boundaries.
- A deterministic plugin is testable without model credentials and remains portable across hosting and agent frameworks.
- The host can apply its own review, brand, data-governance, and human-approval policies before a public mutation.
- The existing HTTP API is sufficient for tools and agents; an additional protocol server would duplicate authorization and operational surface without improving the core contract.

## Consequences

- The public API documents authentication, discovery, validation, publication, idempotency, ambiguous-outcome reconciliation, and deletion for headless callers.
- The plugin never claims that an agent can blindly retry a timed-out provider write. Ambiguous outcomes are locked until verified.
- Agent-framework examples remain illustrative and outside the supported runtime surface.
- An MCP adapter can be evaluated later as a separate package without changing provider adapters or audit semantics.

## Alternatives rejected

- Async model-backed transformations: introduce provider-specific latency, secrets, failure modes, and cost into preview and publication.
- Composer-owned optimization: makes the plugin responsible for model UX and governance that differ by host.
- Bundled MCP server: expands protocol and deployment scope before a demonstrated requirement.
