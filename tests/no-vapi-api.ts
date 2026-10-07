// Loaded before every test file (package.json's test script), and inherited
// by every CLI a test spawns: tests must never reach the real Vapi API or use
// a developer's real key. A test that needs a key sets a fake one itself.
process.env.VAPI_BASE_URL = "http://127.0.0.1:9";
delete process.env.VAPI_PRIVATE_API_KEY;
delete process.env.VAPI_TOKEN;
