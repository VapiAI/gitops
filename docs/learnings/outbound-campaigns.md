# Outbound Campaigns

How Vapi's Outbound Call Campaigns feature actually works — CSV upload, dynamic variables, scheduling, and the gotchas you only learn by reading the source.

For agent design (opening lines, voicemail detection, IVR navigation), see [outbound-agents.md](outbound-agents.md). This file is about the **campaign orchestration layer** that fans out per-customer calls from a CSV.

Public reference: <https://docs.vapi.ai/outbound-campaigns/overview>

---

## What a Campaign Actually Does

A campaign is a thin wrapper around the per-call API:

1. You `POST /campaign` with an assistant (or workflow / squad), a phone number, and a list of customers (uploaded as CSV in the dashboard).
2. The service fans out one `callBatch` per customer group.
3. Each customer becomes a row in the `call` table tagged with `campaign_id`.
4. Calls are either dialed immediately or written as `status: 'scheduled'` rows when org concurrency is exhausted.
5. A polling worker triggers scheduled rows when their `schedulePlan.earliestAt` window opens.
6. As each call ends, a counter increments. When `callsCounterEnded === callsCounterScheduled`, the campaign flips to `ended`.

There is **no separate `CampaignCustomer` table** — customers are stored as JSON on the campaign itself (either `campaign.customers` or nested under `campaign.dialPlan[].customers`).

---

## CSV Format

### Required vs Optional Columns

| Column | Required | Notes |
|--------|----------|-------|
| `number` | Yes | Lowercase. E.164 format (`+14151234567`). No spaces or special characters. Max 15 digits. |
| `name`   | No  | Max 100 chars. Also auto-injected as a template variable. |
| anything else | No | Becomes a key in `assistantOverrides.variableValues` for that call (see below). |

The dashboard schema is explicitly permissive — extra columns pass validation via `.noUnknown(false)`. Rows with no usable `number` are silently skipped by the CSV parser.

### Parsing Behavior

The dashboard uses Papa Parse with `header: true` and a transform that tries `JSON.parse` on every cell. This means:

- Cells that look like JSON (`"[1,2,3]"`, `"{""k"":1}"`) become real objects/arrays.
- Plain strings stay strings.
- Empty cells become `null` (and are dropped before they reach `variableValues`).

**Recommendation:** Save CSVs as UTF-8, no blank rows, no duplicated headers, and double-check that column names match the variables you reference in your assistant prompt.

---

## Dynamic Variables — The Mechanism

**Any extra CSV column becomes a key in `assistantOverrides.variableValues` for that customer's call.** No schema, no mapping step — the column header is the variable name verbatim.

After the dashboard pulls `number` and `name` off each row, every remaining column is spread into `overrideValues` and assigned to `customer.assistantOverrides.variableValues`. At call time the backend renders text fields with **LiquidJS first**, falling back to **Mustache** if Liquid throws.

### Example

```csv
number,name,accountBalance,appointmentDate
+14155550123,Alex,250.00,2026-05-02
+14155550124,Sam,0.00,2026-05-03
```

System prompt:

```
Hi {{ name }}, your balance is ${{ accountBalance }}.
Your appointment is on {{ appointmentDate | date: "%b %d" }}.
```

Each call gets its own substitution because each customer has its own `variableValues`.

### Column Naming Rules

- **No spaces.** Use `customer_issue` or `customerIssue`, never `customer issue`.
- **Must start with a letter.** Liquid won't reference `{{ 1stName }}`.
- **Header = variable name verbatim.** No camelCase / snake_case normalization happens. Pick one convention and stick with it.

### Built-in Default Variables

Defaults like `customer`, `phoneNumber`, and time helpers (`now`) are merged in by `variableValuesGet` before user overrides. So `{{ customer.number }}` works even though `number` is stripped from `additionalColumns`. See <https://docs.vapi.ai/assistants/dynamic-variables#default-variables>.

### Per-Customer Overrides Win

If you also pass top-level `assistantOverrides` on the campaign DTO, the per-customer ones from the CSV **replace** them (not merge). This is set by `callBatch`:

```ts
const customerAssistantOverrides = customer.assistantOverrides
  ? customer.assistantOverrides
  : assistantOverrides;
```

If you need a base overrides object that every call inherits, you must merge it into each row's `variableValues` yourself before sending the campaign.

---

## Concurrency and Scheduling

### Org Concurrency Is the Hard Cap

If your org concurrency limit is 10, only 10 campaign calls dial at once. The rest are written as `status: 'scheduled'` `call` rows with a retry window (default ~2-minute granularity, ~24-hour ceiling), and a polling worker triggers them as slots free up.

This is enforced **on the Vapi side**. Your telephony provider (Twilio, etc.) may have separate rate limits that fail calls before they reach the assistant.

**To raise the dial rate, raise the org concurrency limit.** No campaign-level setting overrides it.

### Campaign-Level `schedulePlan`

`campaign.schedulePlan` controls **when dial attempts may begin** and the retry window for the campaign as a whole. It's distinct from the per-call `schedulePlan` written by `callBatch` when concurrency is exhausted.

---

## Campaign Completion Semantics

A campaign auto-flips to `status: 'ended'` (with `endedReason: 'campaign.ended.success'`) when:

```
callsCounterEnded === callsCounterScheduled
```

This is **not** "all CSV rows finished." If some rows fail to schedule (invalid numbers that slipped past CSV validation, fraud-block rejections on Vapi numbers, transient errors during fan-out), the counters can diverge from your mental "all uploaded" model. The campaign will still flip to `ended` once the scheduled count is reached — even if that's fewer calls than rows in the CSV.

**Recommendation:** After campaign creation, verify `callsCounterScheduled` matches the row count you uploaded. If it doesn't, scan call rows with that `campaign_id` for `status: 'failed'` or `endedReason` values from the creation path.

---

## Gotchas Summary

1. **Header = variable name, verbatim, no normalization.** Spaces or leading digits will silently break references in your prompt.
2. **`number` is stripped** before extra columns get spread into `variableValues`. Use `{{ customer.number }}` from the default `customer` object instead of `{{ number }}`.
3. **`name` is duplicated** into `variableValues` (so `{{ name }}` works) but also remains on the `customer` object.
4. **Arrays in JSON-parsed cells get dropped.** The variable-merge layer accepts primitives and plain objects, not arrays. If you need array data, serialize as a JSON string the prompt can parse, or flatten into separate columns.
5. **Liquid first, Mustache fallback.** Plain `{{ name }}` works in both; filters (`| date:`, `| upcase`) only work via Liquid. Test prompt rendering before launching a large campaign.
6. **Per-customer overrides replace, not merge.** Top-level `assistantOverrides` on the campaign DTO are ignored for any row that has its own `assistantOverrides`.
7. **Campaign auto-completes on counter equality**, not on "all uploaded rows finished." Validate `callsCounterScheduled` post-create.
8. **Concurrency caps are platform-side.** Increasing the campaign size doesn't increase throughput — only raising the org concurrency limit does.

---

## Cross-References

- Agent design (opening, IVR, voicemail) → [outbound-agents.md](outbound-agents.md)
- Voicemail vs human classification → [voicemail-detection.md](voicemail-detection.md)
- Error-handling hooks for failed campaign calls → [fallbacks.md](fallbacks.md)
- Call-time-limit behavior → [call-duration.md](call-duration.md)
