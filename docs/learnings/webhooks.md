# Server & Webhook Configuration Gotchas

Non-obvious behaviors and silent defaults for Vapi webhook delivery, server configuration, and credential resolution.

---

## Default Server Messages

If you omit `serverMessages` on an assistant, these events are sent by default:

```
conversation-update, end-of-call-report, function-call, hang,
speech-update, status-update, tool-calls, transfer-destination-request,
handoff-destination-request, user-interrupted, assistant.started
```

This is NOT "nothing" — it's 11 event types. Set `serverMessages` explicitly if you want fewer.

---

## Server Timeout vs Tool Timeout

These are **two independent settings**:

| Setting | Controls | Default |
|---------|----------|---------|
| `server.timeoutSeconds` | Webhook delivery timeout (status-update, end-of-call-report, etc.) | Platform default (see API reference) |
| `tool.timeoutSeconds` (apiRequest) | Individual tool HTTP call timeout | Platform default (see API reference) |

They don't inherit from each other.

---

## Unreachable Server Behavior

- **Missing `server.url`:** No network call is made. No error is raised.
- **Server returns error:** The error is logged and returned to the platform. For `tool-calls` events, Vapi still attempts to parse the error response body for tool results.
- **High failure rate:** Under sustained delivery failures, Vapi may reduce delivery of high-frequency events (like `speech-update`) while still attempting critical events (like `end-of-call-report`).

---

## Retry & Backoff for Server Delivery

A single failed POST to your `server.url` should not be the difference between getting an `end-of-call-report` and losing it. Configure an explicit `backoffPlan` on the `server` block so transient failures (502/503/504, network blips, brief handler restarts) get retried, while semantic errors that won't change on retry (4xx) short-circuit immediately.

```yaml
server:
  url: https://your-webhook-endpoint.example.com/vapi
  timeoutSeconds: 20
  backoffPlan:
    type: exponential
    maxRetries: 3
    baseDelaySeconds: 1
    excludedStatusCodes: [400, 401, 403, 404, 413, 422]
```

**Field meanings:**

| Field | Effect |
|---|---|
| `type: exponential` | Delay doubles each retry. With `baseDelaySeconds: 1` and `maxRetries: 3` the schedule is roughly 1s → 2s → 4s (~7s wall clock). |
| `maxRetries` | Upper bound on retry attempts (not counting the initial request). |
| `baseDelaySeconds` | First retry delay; subsequent retries double from this base when `type` is exponential. |
| `excludedStatusCodes` | Status codes that skip retry entirely. The request fails immediately on receipt. |

**Why exclude the 4xx family.** A 4xx response means your server understood the request and rejected it for a deterministic reason — bad auth (401/403), missing route (404), validation failure (400/422), payload too large (413). Retrying produces the same response, just later. `excludedStatusCodes` tells Vapi to give up on those codes and reserve the retry budget for genuinely transient failures (5xx, network errors, request timeouts).

**Recommendation: make `backoffPlan` part of the default whenever you define a `server.url`.** The cost is one config block; the benefit is that the `end-of-call-report` event — your post-call analytics ground truth — survives a brief webhook hiccup instead of being silently lost. Keep `server.timeoutSeconds` shorter than your slowest downstream dependency so a hanging handler doesn't compound across retries.

---

## Credential Resolution

If `credentialId` is set on the server or tool, that specific credential is used. If omitted, Vapi picks one from the call's available credentials automatically.

**Recommendation:** Always set `credentialId` explicitly when multiple credentials exist to avoid ambiguous selection.

---

## Webhook Payload Shape

All webhooks POST a JSON body with this structure:

```json
{
  "message": {
    "type": "<event-type>",
    "timestamp": 1234567890000,
    "call": { ... },
    "phoneNumber": { ... },
    "customer": { ... },
    "assistant": { ... },
    ...event-specific fields
  }
}
```

The `call`, `phoneNumber`, `customer`, and `assistant` fields are included on most message types (except issue-specific messages).
