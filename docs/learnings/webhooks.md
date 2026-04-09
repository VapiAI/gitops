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
