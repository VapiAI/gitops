import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

type AnyRecord = Record<string, unknown>;

interface StoredEvent {
  receivedAt: string;
  type: string;
  payload: unknown;
}

const DEFAULT_PORT = 8787;
const MAX_STORED_EVENTS = 200;
const events: StoredEvent[] = [];

function getPort(): number {
  const raw = process.env.MOCK_VAPI_WEBHOOK_PORT;
  if (!raw) return DEFAULT_PORT;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PORT;
  return parsed;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function storeEvent(type: string, payload: unknown): void {
  events.unshift({
    receivedAt: new Date().toISOString(),
    type,
    payload,
  });

  if (events.length > MAX_STORED_EVENTS) {
    events.length = MAX_STORED_EVENTS;
  }
}

function summarizeMessage(type: string, message: AnyRecord): void {
  if (type === "speech-update") {
    const role = getString(message.role) ?? "unknown-role";
    const status = getString(message.status) ?? "unknown-status";
    const turn = typeof message.turn === "number" ? message.turn : "n/a";
    console.log(`[speech-update] role=${role} status=${status} turn=${turn}`);
    return;
  }

  if (type === "status-update") {
    const status = getString(message.status) ?? "unknown-status";
    console.log(`[status-update] status=${status}`);
    return;
  }

  if (type === "end-of-call-report") {
    const endedReason = getString(message.endedReason) ?? "unknown";
    const hasArtifact = isRecord(message.artifact);
    console.log(
      `[end-of-call-report] endedReason=${endedReason} artifact=${hasArtifact ? "yes" : "no"}`,
    );
    return;
  }

  if (type === "transcript") {
    const role = getString(message.role) ?? "unknown-role";
    const transcriptType = getString(message.transcriptType) ?? "unknown";
    const transcript = getString(message.transcript) ?? "";
    console.log(
      `[transcript] role=${role} type=${transcriptType} chars=${transcript.length}`,
    );
    return;
  }

  console.log(`[${type}] received`);
}

function buildToolResults(message: AnyRecord): AnyRecord[] {
  const rawList = message.toolCallList;
  if (!Array.isArray(rawList)) return [];

  const results: AnyRecord[] = [];
  for (const item of rawList) {
    if (!isRecord(item)) continue;
    const id = getString(item.id);
    const name = getString(item.name);
    if (!id || !name) continue;

    results.push({
      name,
      toolCallId: id,
      result: JSON.stringify({ ok: true, mocked: true }),
    });
  }
  return results;
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const parsed = await readJsonBody(req);
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "Expected JSON object body." });
      return;
    }

    const messageValue = parsed.message;
    if (!isRecord(messageValue)) {
      sendJson(res, 400, { error: "Expected body.message object." });
      return;
    }

    const type = getString(messageValue.type) ?? "unknown";
    storeEvent(type, parsed);
    summarizeMessage(type, messageValue);

    if (type === "tool-calls") {
      const results = buildToolResults(messageValue);
      sendJson(res, 200, { results });
      return;
    }

    sendJson(res, 200, { ok: true, receivedType: type });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, { ok: true, eventCount: events.length });
    return;
  }

  if (method === "GET" && url === "/events") {
    sendJson(res, 200, { events });
    return;
  }

  if (method === "POST" && (url === "/" || url === "/webhook")) {
    void handleWebhook(req, res);
    return;
  }

  sendJson(res, 404, {
    error: "Not found.",
    routes: ["GET /health", "GET /events", "POST /webhook", "POST /"],
  });
}

const port = getPort();
const server = createServer(handleRequest);

server.listen(port, () => {
  console.log("Mock Vapi webhook server running.");
  console.log(`Listening on http://localhost:${port}`);
  console.log("Supported routes: GET /health, GET /events, POST /webhook");
  console.log("Set MOCK_VAPI_WEBHOOK_PORT to override the default port.");
});
