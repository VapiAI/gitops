# Simulation & Testing Gotchas

Non-obvious behaviors and silent defaults for Vapi simulations, test suites, and evaluations.

---

## How Personalities Work

The simulation tester assistant is built from:
1. **Voice, model, and transcriber** from `personality.assistant`
2. **Persona prompt** from `personality.assistant.model.messages[0].content` (only the first message)
3. **Task instructions** from `scenario.instructions`
4. An **endCall tool** is always appended if not already present

Extra system messages beyond `messages[0]` are **not** included in the tester's prompt. The personality is primarily defined by that first system message.

---

## Evaluation Comparators

Simulation evaluations support these comparators:

| Comparator | Supported types |
|------------|-----------------|
| `=` | string, number, boolean |
| `!=` | string, number, boolean |
| `>` | number only |
| `<` | number only |
| `>=` | number only |
| `<=` | number only |

**Critical:** Evaluation schemas must use **primitive types only** (`string`, `number`, `integer`, `boolean`). Objects and arrays are rejected at validation and fail at extraction time.

**Note:** Test suite scorers (live tests) use a different system — an LLM judge with rubric grading, not comparator-based matching.

---

## Chat-Mode Evaluation Gotcha

Evaluations that require audio (`target: messages-with-audio`) are **skipped** in chat-mode simulations with `passed: false` and `isSkipped: true`.

**Critical:** If **all** required evaluations are audio-dependent and the simulation runs in chat mode, they're all skipped — and `evaluationPlanPassedCheck` returns **`true`** (0 required results = pass). This means your test suite can silently pass with no actual evaluation.

**Recommendation:** Include at least one text-based (`target: messages`) evaluation in every simulation that runs in chat mode.

---

## Missing References

- **At run creation (API):** Missing scenario or personality IDs throw `BadRequestException` immediately.
- **At execution (Temporal worker):** Missing references throw `ApplicationFailure` — behavior depends on Temporal retry config.
- **Inline runs:** Require snapshots in metadata or fail with "no inline config" error.
