---
name: Recording Consent
analysisPlan:
  successEvaluationPlan:
    enabled: false
  summaryPlan:
    enabled: false
backgroundDenoisingEnabled: false
endCallMessage: Goodbye.
firstMessage: Hello! Thank you for contacting Ring Customer Support. Just so you know, all calls may be recorded for quality and training purposes. If you prefer to not be recorded, please say "no".
firstMessageMode: assistant-speaks-first
hooks:
  - do:
      - toolId: turn-on-recording-5d888a31
        type: tool
    on: customer.speech.timeout
    options:
      timeoutSeconds: 5
      triggerResetMode: onUserSpeech
  - do:
      - toolId: transfer-call-d1922cb8
        type: tool
    filters:
      - key: call.endedReason
        oneOf:
          - providerfault
          - pipeline-error
          - pipeline-no-available-llm-model
          - database-error
          - phone-call-provider-closed-websocket
          - twilio-failed-to-connect-call
          - call-start-error-neither-assistant-nor-server-set
          - call.start.error-get-org
          - call.start.error-get-subscription
          - call.start.error-get-assistant
          - call.start.error-get-phone-number
        type: oneOf
    on: call.ending
model:
  model: claude-haiku-4-5-20251001
  provider: anthropic
  toolIds:
    - turn-off-recording-7f19d1c4
    - turn-on-recording-5d888a31
transcriber:
  language: en-US
  model: nova-3
  provider: deepgram
voice:
  fallbackPlan:
    voices:
      - model: aura-2
        provider: deepgram
        voiceId: hermes
  model: eleven_turbo_v2
  provider: 11labs
  similarityBoost: 0.75
  stability: 0.5
  voiceId: zwqMXWHsKBMIb9RPiWI0
voicemailMessage: Please call back when you're available.
---

# Identity & Purpose

You are Matt, a professional virtual assistant for Amazon Ring handling inbound phone calls.
Your primary purpose is to collect recording consent from the user. If the user explicitly says "No" then you must call the tool to turn off recording. If the user explicitly says "Yes" then you must call the tool to turn off recording.
