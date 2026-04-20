# Call Duration Management & Graceful Shutdown

How to enforce call time limits while ending calls gracefully instead of abruptly cutting off.

---

## Core Mechanisms

Vapi provides three layers for managing call duration:


| Mechanism               | What it does                                                | Type                 |
| ----------------------- | ----------------------------------------------------------- | -------------------- |
| `maxDurationSeconds`    | Hard wall-clock cutoff — call ends immediately when reached | Assistant setting    |
| `call.timeElapsed` hook | Fires once at a specific second mark from call start        | Hook (deterministic) |
| `endCall` tool          | LLM decides to end the call                                 | Tool (probabilistic) |


**Key distinction:** Hooks are deterministic (guaranteed to fire). Tools are probabilistic (the LLM chooses when to invoke them). For call discipline, use hooks as the enforcement layer and tools as the courtesy layer.

---

## `maxDurationSeconds` — The Hard Cutoff

Every assistant has `maxDurationSeconds` (default: **600 seconds / 10 minutes**). When the timer fires, the call ends immediately with reason `exceeded-max-duration`. There is no spoken goodbye — the call just drops.

```yaml
maxDurationSeconds: 600  # 10 minutes (this is the default)
```

- **Range:** 10–43,200 seconds (10s to 12h)
- **Timer starts from:** first audio chunk processed (not call creation)
- **Override:** can be set per-call via `assistantOverrides.maxDurationSeconds` or the deprecated `call.maxDurationSeconds`
- **Squad behavior:** `LiveCall.maxDurationSeconds` uses `Math.max()` across all squad assistants

---

## `call.timeElapsed` Hook — Scheduled Actions at Specific Times

This hook fires **once** at a specified number of seconds from call start. It's the primary tool for graceful pre-cutoff behavior.

```yaml
hooks:
  - on: call.timeElapsed
    options:
      seconds: 480  # 8 minutes
    do:
      - type: say
        exact: "We're approaching our time limit. Let's start wrapping up."
```

**Key facts:**

- **One-shot per hook entry:** each hook fires exactly once. For multiple time checkpoints, add separate hooks.
- **Range:** `seconds` accepts 1–3600 (1 second to 1 hour).
- **Timer starts from:** `callStart()` (when the pipeline begins processing).
- **Available actions:** `say` (speak a message), `tool` (invoke a tool like `endCall`), `message.add` (inject a system message into the LLM context).
- **Not re-armed on assistant swap:** if the assistant changes mid-call (transfer), time-elapsed hooks on the new assistant are **not** re-scheduled. Only hooks on the original assistant fire.

---

## Recipe: Call Discipline (~10 min cap)

Structured closeout with wrap-up warning, final notice, and hard cutoff:

```yaml
maxDurationSeconds: 600  # Hard cutoff at 10 min

hooks:
  # 8 min — begin wrap-up
  - on: call.timeElapsed
    options:
      seconds: 480
    do:
      - type: say
        exact: "We're approaching our time limit. Let's start wrapping up."

  # 9 min — final notice
  - on: call.timeElapsed
    options:
      seconds: 540
    do:
      - type: say
        exact: "We have about one minute left. Let me know if there's anything else urgent."

  # 9 min 50 sec — graceful close (say goodbye, then end)
  - on: call.timeElapsed
    options:
      seconds: 590
    do:
      - type: say
        exact: "Thank you for your time. I need to end the call now. Goodbye."
      - type: tool
        tool:
          type: endCall
```

**Why 590 and not 600:** The `endCall` tool in the hook's `do` action fires a graceful end (with the spoken goodbye). If the hook and `maxDurationSeconds` race at exactly 600, the hard cutoff wins and the goodbye never plays. Give yourself a 10-second buffer.

---

## Recipe: Inject a System Message to Change LLM Behavior

Instead of speaking a fixed message, you can inject a system message that changes how the LLM responds for the rest of the call. This is more natural — the assistant "knows" it should wrap up without speaking a canned line.

```yaml
hooks:
  - on: call.timeElapsed
    options:
      seconds: 480
    do:
      - type: message.add
        message:
          role: system
          content: >
            The call has been going on for 8 minutes. Begin wrapping up
            the conversation. Summarize any action items and ask if there
            is anything else before ending the call.
```

You can combine this with a spoken warning:

```yaml
hooks:
  - on: call.timeElapsed
    options:
      seconds: 480
    do:
      - type: say
        exact: "Just a heads up — we have about two minutes left."
      - type: message.add
        message:
          role: system
          content: >
            Begin wrapping up. Summarize action items. Move toward
            closing the call within the next 2 minutes.
```

---

## Hooks vs Tools vs System Prompt — When to Use Which


| Approach                                       | Reliability                         | Use when                                                             |
| ---------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `call.timeElapsed` hook with `say`             | Guaranteed                          | You need a deterministic spoken warning at a fixed time              |
| `call.timeElapsed` hook with `message.add`     | Guaranteed delivery, LLM interprets | You want the LLM to organically wrap up the conversation             |
| `call.timeElapsed` hook with `endCall` tool    | Guaranteed                          | You need a hard graceful end (with goodbye) at a fixed time          |
| `maxDurationSeconds`                           | Guaranteed                          | Last-resort hard cutoff — no goodbye, call just drops                |
| `endCall` tool (LLM-invoked)                   | Probabilistic                       | You want the LLM to decide when to end based on conversation context |
| System prompt instruction ("end after 10 min") | Unreliable                          | Don't rely on this alone — the LLM may not track time accurately     |


**Best practice:** Layer them. Use hooks for deterministic enforcement and the endCall tool + system prompt for conversational flexibility.

---

## Related Timeout Mechanisms

These are **not** the same as call duration limits, but they interact:


| Mechanism                        | What it does                                       | Default             |
| -------------------------------- | -------------------------------------------------- | ------------------- |
| `silenceTimeoutSeconds`          | Ends call after sustained silence                  | 30s                 |
| `customer.speech.timeout` hook   | Fires action when customer is silent for N seconds | 7.5s, up to 3 times |
| `messagePlan.idleTimeoutSeconds` | Speaks an idle message when conversation stalls    | 10s                 |
| `customerJoinTimeoutSeconds`     | Ends call if customer never sends audio            | 15s                 |


**`silenceTimeoutSeconds` vs `customer.speech.timeout`:** The timeout **ends the call**. The hook **performs an action** (say, tool, message.add). They are independent — configure them separately. See [assistants.md](assistants.md) for the hook events list.

---

## Gotchas

### `maxDurationSeconds` is abrupt

There is no configurable message spoken before the hard cutoff. If you need a goodbye, use a `call.timeElapsed` hook at `maxDurationSeconds - 10` with an `endCall` tool action.

### Time-elapsed hooks don't survive assistant transfers

If the call transfers to a new assistant (warm or blind), the original `HookStream` is torn down. Time-elapsed hooks on the new assistant's configuration are **not re-armed**. This means: if your 8-minute wrap-up hook is on Assistant A and the call transfers to Assistant B at minute 5, the wrap-up hook never fires.

**Workaround:** Put time-elapsed hooks in `membersOverrides.hooks` on the squad, so they apply to all assistants. Or set them on both assistants.

### Timer starts from first audio, not call creation

The `maxDurationSeconds` timer starts when the first audio chunk is processed. `call.timeElapsed` hooks start from `callStart()`. Both are measured from the pipeline starting, not from when the API call was made or the phone started ringing.

### Lambda workers reject long calls

If `maxDurationSeconds >= 15 minutes` (900s), the call is rejected when routed to a Lambda-based worker (reason: `lambda-longcalls-not-accepted`). Long calls require non-Lambda workers.