## Summary
Implemented a robust TypeScript/Express subscription billing fixture and automated validation framework covering REST API contracts, complete lifecycle state transitions, database persistence, webhook security & idempotency, and mocked payment-provider interactions.

## Test Strategy
- **Levels covered**: API contract testing (Supertest), domain state machine unit testing, persistence & audit integrity, mocked payment provider integration, and webhook security/ordering.
- **In scope**: Create/read/cancel endpoints, request validation, payment outcomes (success, decline, timeout), HMAC-SHA256 signature verification, duplicate webhook deduplication, out-of-order/stale webhooks, audit trail and invoice persistence.
- **Out of scope**: UI, live production payment gateway, persistent SQL database, automated retry scheduler, load testing, plan proration.
- **What is real vs stubbed/mocked, and why**: Express routes, service logic, state machine, cryptographic HMAC verification, and in-memory repository are real executable code; payment provider is a test double (`FakePaymentProvider`) because no live gateway should be called during tests; database is in-memory for fast, hermetic, deterministic test runs.

## OOP & Design Pattern Choices
- **State Machine**: `src/domain/state-machine.ts` centralizes all legal transitions and strictly throws `InvalidTransitionError` on illegal transitions; provides inspection methods `getAllowedTransitions` and `isTerminal`.
- **Builder Pattern**: `SubscriptionRequestBuilder` and `WebhookBuilder` provide fluent construction for both happy path and edge-case/negative test payloads (`withoutCustomerId`, `withoutPaymentMethod`, `withWhitespaceCustomerId`, `withInvalidPlan`, `withoutField`, `buildRaw`).
- **Factory Pattern**: `SubscriptionFixtureFactory` pre-seeds complex subscription states (`trialing`, `active`, `past_due`, `canceled`) with corresponding invoices and audit trails.
- **Provider Seam**: `PaymentProvider` interface injected into `SubscriptionService`; `FakePaymentProvider` records call count, arguments, and supports outcome queueing (`setOutcomes`).
- **Repository Pattern**: `InMemoryRepository` encapsulates persistence for subscriptions, invoices, webhook events, and audit logs.
- **Test Fixture Harness**: `createTestFixture` sets up fresh, isolated dependencies and provides a typed `postWebhook` helper.

## API Validation Approach
Requests and responses are exercised through Express + Supertest. Creation, retrieval, cancellation, missing fields, whitespace-only customer IDs, unknown plans, malformed webhook JSON, invalid signatures, non-existent subscription IDs, and repeated cancellations (409 Conflict) are tested systematically.

## Database Validation Approach
Validates `subscriptions`, `invoices`, `webhookEvents`, and `auditEvents` in `InMemoryRepository`. Tests assert that API responses match stored state, invoice statuses align with payment outcomes, duplicate/stale events produce no duplicate records or state regressions, and audit logs record exact transitions (`from`, `to`, `reason`, `createdAt`).

## Mock Payment Provider & Webhook Validation
The fake provider verifies `customerId`, `paymentMethodId`, `amount` (in cents), `currency` (`USD`), and `idempotencyKey`. Success, decline, and timeout outcomes are validated. Duplicate `event_id` delivery returns `{ accepted: true, duplicate: true }` as a no-op; stale failures arriving after success, duplicate success webhooks, and webhooks arriving after cancellation are safely ignored.

## State-Machine / Lifecycle Coverage
- **Valid transitions covered end-to-end**:
  1. `trialing -> active` (trial payment success webhook)
  2. `trialing -> past_due` (trial payment failure webhook)
  3. `trialing -> canceled` (cancellation during trial)
  4. `active -> past_due` (recurring renewal failure webhook)
  5. `active -> canceled` (cancellation of active subscription)
  6. `past_due -> active` (retry payment success webhook)
  7. `past_due -> canceled` (retries exhausted / cancel while past_due)
- **Invalid transitions prevented**:
  1. `canceled -> active` (ignored via webhook; state machine throws `InvalidTransitionError`)
  2. `canceled -> past_due` (ignored via webhook; state machine throws `InvalidTransitionError`)
  3. `canceled -> canceled` (API returns `409 Conflict`)
  4. `active -> trialing` (illegal regression throws `InvalidTransitionError`)
  5. `past_due -> trialing` (illegal regression throws `InvalidTransitionError`)
  6. `canceled -> trialing` (terminal state throws `InvalidTransitionError`)

## Test Architecture
Tests are grouped into 4 distinct suites under `tests/`:
- `tests/api/subscriptions.test.ts` (13 tests)
- `tests/lifecycle/lifecycle.test.ts` (20 tests)
- `tests/integration/provider-and-persistence.test.ts` (7 tests)
- `tests/webhooks/webhooks.test.ts` (25 tests)
Total: **65 tests passing**.

## Validation
- `npm run lint` — Passes (ESLint flat config)
- `npm run build` — Passes (`tsc --noEmit`)
- `npm test` — Passes (65 tests across 4 suites)
- `npm run validate` — Passes (lint + build + test)

## Known Limitations / Next Steps
- In-memory persistence is fast and hermetic for tests, but does not exercise SQL schema constraints or ACID transaction isolation. Production should integrate PostgreSQL with database-level uniqueness constraints on `event_id` and row-level locking.
- Automated background retry scheduling and notification emails are mocked/exercised via webhooks rather than a live cron engine.

## Responsible AI Usage
AI assistance was utilized to identify Express 5 route param typings and Supertest helper signatures, expand edge case coverage across builders and state machine transitions, and refine documentation. All code, type checks, and test executions were validated through `npm run validate` directly in the environment.

## Author Checklist
- [x] Linting passes (`npm run lint`)
- [x] Type check passes (`npm run build`)
- [x] Test suite passes (`npm test`)
- [x] Schema/setup validation passes (in-memory fixture initialized per test)
- [x] Every listed lifecycle transition is exercised by at least one test
- [x] At least two invalid transitions are proven impossible
- [x] Webhook idempotency (duplicate `event_id`) is tested
- [x] README was tested from a clean setup
