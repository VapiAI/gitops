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
| `server.timeoutSeconds` | Webhook delivery timeout (status-update, end-of-call-report, etc.) | `DEFAULT_TIMEOUT_SECOND` |
| `tool.timeoutSeconds` (apiRequest) | Individual tool HTTP call timeout | `DEFAULT_TIMEOUT_SECOND` |

They don't inherit from each other.

---

## Unreachable Server Behavior

- **Missing `server.url`:** Returns empty object, no network call. No error.
- **Server returns error:** Error is logged and returned. For `tool-calls` message type, the backend **still attempts to parse** the error response body for tool results.
- **High failure rate:** A circuit breaker kicks in — "noisy" message types (frequent events like `speech-update`) are aborted when the error rate exceeds a threshold. Critical messages like `end-of-call-report` continue attempting.

---

## Credential Resolution

For server webhooks:
1. If `server.credentialId` is set → use that specific credential
2. Else → use the first `custom-credential` on the call
3. Else → use the first `webhook` credential on the call

For apiRequest tools:
1. If `tool.credentialId` is set → use that specific credential
2. Else → use the first `webhook` or `custom-credential` on the call

**Recommendation:** Always set `credentialId` explicitly when multiple credentials exist to avoid ambiguous fallback.

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
