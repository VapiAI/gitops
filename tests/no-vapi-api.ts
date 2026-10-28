// Loaded before every test file (package.json's test script), and inherited
// by every CLI a test spawns: tests must never reach the real Vapi API or use
// a developer's real key. A test that needs a key sets a fake one itself.
process.env.VAPI_BASE_URL = "http://127.0.0.1:9";
delete process.env.VAPI_PRIVATE_API_KEY;
delete process.env.VAPI_TOKEN;
// Tests that stub fetch count requests; the org pin check's probes would add
// to them. tests/org-pin.test.ts turns it back on for itself.
process.env.VAPI_GITOPS_ORG_PIN = "off";
// Per-org keys (VAPI_PRIVATE_API_KEY_<ORG>) a developer exports in their shell.
for (const name of Object.keys(process.env))
  if (name.startsWith("VAPI_PRIVATE_API_KEY_")) delete process.env[name];
