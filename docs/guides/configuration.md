# Configuration

## Environment Variables

| Variable        | Required | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `VAPI_PRIVATE_API_KEY`  | ✅       | Vapi private API key from [Private API Keys](https://dashboard.vapi.ai/org/api-keys). The legacy name `VAPI_TOKEN` is still accepted. |
| `VAPI_BASE_URL` | ❌       | API base URL (defaults to `https://api.vapi.ai`) |

These are stored in `.env.<org>` files, one per configured organization.
