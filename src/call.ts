import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import * as readline from "readline";
import type { Environment, StateFile } from "./types.ts";
import { VALID_ENVIRONMENTS } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

type ResourceType = "assistant" | "squad";

interface CallConfig {
  env: Environment;
  target: string;
  resourceType: ResourceType;
  token: string;
  baseUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error("❌ Usage: bun run call:<env> -a <assistant-name>");
  console.error("         bun run call:<env> -s <squad-name>");
  console.error("");
  console.error("   Options:");
  console.error("     -a <name>    Call an assistant by name");
  console.error("     -s <name>    Call a squad by name");
  console.error("");
  console.error("   Examples:");
  console.error("     bun run call:dev -a my-assistant");
  console.error("     bun run call:dev -a company-1/inbound-support");
  console.error("     bun run call:prod -s my-squad");
}

function parseArgs(): CallConfig {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    printUsage();
    process.exit(1);
  }

  const env = args[0] as Environment;
  
  if (!VALID_ENVIRONMENTS.includes(env)) {
    console.error(`❌ Invalid environment: ${env}`);
    console.error(`   Must be one of: ${VALID_ENVIRONMENTS.join(", ")}`);
    process.exit(1);
  }

  // Parse flags
  let resourceType: ResourceType | null = null;
  let target: string | null = null;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-a" || arg === "--assistant") {
      if (resourceType) {
        console.error("❌ Cannot specify both -a and -s");
        process.exit(1);
      }
      resourceType = "assistant";
      target = args[++i];
    } else if (arg === "-s" || arg === "--squad") {
      if (resourceType) {
        console.error("❌ Cannot specify both -a and -s");
        process.exit(1);
      }
      resourceType = "squad";
      target = args[++i];
    }
  }

  if (!resourceType || !target) {
    console.error("❌ Must specify either -a <assistant> or -s <squad>");
    printUsage();
    process.exit(1);
  }

  // Load environment variables
  const { token, baseUrl } = loadEnvFile(env);

  return { env, target, resourceType, token, baseUrl };
}

function loadEnvFile(env: string): { token: string; baseUrl: string } {
  const envFiles = [
    join(BASE_DIR, `.env.${env}`),
    join(BASE_DIR, `.env.${env}.local`),
    join(BASE_DIR, ".env.local"),
  ];

  const envVars: Record<string, string> = {};

  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (envVars[key] === undefined) {
          envVars[key] = value;
        }
      }
    }
  }

  const token = process.env.VAPI_TOKEN || envVars.VAPI_TOKEN;
  const baseUrl = process.env.VAPI_BASE_URL || envVars.VAPI_BASE_URL || "https://api.vapi.ai";

  if (!token) {
    console.error("❌ VAPI_TOKEN environment variable is required");
    console.error(`   Create a .env.${env} file with: VAPI_TOKEN=your-token`);
    process.exit(1);
  }

  return { token, baseUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission Check
// ─────────────────────────────────────────────────────────────────────────────

async function checkMicrophonePermission(): Promise<boolean> {
  const platform = process.platform;

  if (platform === "darwin") {
    // macOS - check and prompt for microphone permission
    console.log("🎤 Checking microphone permissions...");
    
    try {
      // Try to get microphone permission status using AppleScript
      const result = execSync(
        `osascript -e 'tell application "System Events" to return (name of processes whose name contains "sox" or name contains "rec")'`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      // If we get here without error, we have some level of access
    } catch {
      // Ignore errors from the check itself
    }

    // Actually test microphone access by trying to record briefly
    try {
      // Check if sox/rec is available
      execSync("which sox", { stdio: "pipe" });
      
      // Try a quick recording to trigger permission prompt
      console.log("   Testing microphone access (this may prompt for permission)...");
      execSync("rec -q -t raw -r 16000 -b 16 -c 1 -e signed-integer /dev/null trim 0 0.1 2>/dev/null || true", {
        timeout: 5000,
        stdio: "pipe",
      });
      
      console.log("✅ Microphone permission granted\n");
      return true;
    } catch {
      // sox not installed or permission denied
      console.log("⚠️  Could not verify microphone access.");
      console.log("   If prompted, please grant microphone permission in System Preferences.");
      console.log("   System Preferences > Security & Privacy > Privacy > Microphone\n");
      
      // Ask user to continue anyway
      const shouldContinue = await askUserConfirmation(
        "Continue without confirmed microphone access? (y/n): "
      );
      return shouldContinue;
    }
  } else if (platform === "linux") {
    // Linux - check if audio devices are accessible
    console.log("🎤 Checking audio devices...");
    
    try {
      // Check for ALSA devices
      execSync("arecord -l 2>/dev/null | grep -q card", { stdio: "pipe" });
      console.log("✅ Audio recording devices found\n");
      return true;
    } catch {
      console.log("⚠️  No audio recording devices found.");
      console.log("   Make sure your microphone is connected and ALSA is configured.\n");
      
      const shouldContinue = await askUserConfirmation(
        "Continue without confirmed microphone access? (y/n): "
      );
      return shouldContinue;
    }
  } else if (platform === "win32") {
    // Windows - just inform the user
    console.log("🎤 On Windows, you may be prompted to grant microphone access.\n");
    return true;
  }

  return true;
}

function askUserConfirmation(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// State Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadState(env: Environment): StateFile {
  const stateFilePath = join(BASE_DIR, `.vapi-state.${env}.json`);
  
  if (!existsSync(stateFilePath)) {
    console.error(`❌ State file not found: .vapi-state.${env}.json`);
    console.error("   Run 'npm run apply:" + env + "' first to create resources");
    process.exit(1);
  }

  try {
    const content = readFileSync(stateFilePath, "utf-8");
    return JSON.parse(content) as StateFile;
  } catch (error) {
    console.error(`❌ Failed to parse state file: ${error}`);
    process.exit(1);
  }
}

function resolveTarget(
  state: StateFile,
  target: string,
  resourceType: ResourceType
): string {
  if (resourceType === "squad") {
    const squads = (state as StateFile & { squads?: Record<string, string> }).squads || {};
    const uuid = squads[target];
    if (!uuid) {
      console.error(`❌ Squad not found: ${target}`);
      console.error("   Available squads:");
      const squadKeys = Object.keys(squads);
      if (squadKeys.length === 0) {
        console.error("     (no squads in state file)");
      } else {
        squadKeys.forEach((k) => console.error(`     - ${k}`));
      }
      process.exit(1);
    }
    return uuid;
  } else {
    const uuid = state.assistants[target];
    if (!uuid) {
      console.error(`❌ Assistant not found: ${target}`);
      console.error("   Available assistants:");
      const assistantKeys = Object.keys(state.assistants);
      if (assistantKeys.length === 0) {
        console.error("     (no assistants in state file)");
      } else {
        assistantKeys.forEach((k) => console.error(`     - ${k}`));
      }
      process.exit(1);
    }
    return uuid;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Creation
// ─────────────────────────────────────────────────────────────────────────────

interface CreateCallResponse {
  id: string;
  transport?: {
    websocketCallUrl?: string;
  };
}

async function createCall(
  config: CallConfig,
  targetId: string
): Promise<CreateCallResponse> {
  const url = `${config.baseUrl}/call`;
  
  const body: Record<string, unknown> = {
    transport: {
      provider: "vapi.websocket",
      audioFormat: {
        format: "pcm_s16le",
        container: "raw",
        sampleRate: 16000,
      },
    },
  };

  if (config.resourceType === "squad") {
    body.squadId = targetId;
  } else {
    body.assistantId = targetId;
  }

  console.log(`📞 Creating call...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Failed to create call: ${response.status}`);
    console.error(`   ${errorText}`);
    process.exit(1);
  }

  return response.json() as Promise<CreateCallResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Connection
// ─────────────────────────────────────────────────────────────────────────────

interface TranscriptMessage {
  type: "transcript";
  role: "user" | "assistant";
  transcriptType: "partial" | "final";
  transcript: string;
}

interface SpeechUpdateMessage {
  type: "speech-update";
  role: "user" | "assistant";
  status: "started" | "stopped";
}

interface CallEndedMessage {
  type: "call-ended";
  reason?: string;
}

type ControlMessage = TranscriptMessage | SpeechUpdateMessage | CallEndedMessage | { type: string };

async function connectWebSocket(websocketUrl: string, config: CallConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`🔌 Connecting to WebSocket...`);
    
    const ws = new WebSocket(websocketUrl, {
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    } as WebSocket extends { new(url: string, protocols?: string | string[], options?: unknown): WebSocket } ? unknown : never);

    let audioContext: ReturnType<typeof createAudioContext> | null = null;
    let micStream: ReturnType<typeof createMicrophoneStream> | null = null;
    let isConnected = false;
    let lastTranscript = "";

    // Graceful shutdown
    const cleanup = () => {
      console.log("\n👋 Ending call...");
      if (micStream) {
        micStream.stop();
      }
      if (audioContext) {
        audioContext.close();
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    ws.onopen = () => {
      console.log("✅ Connected!");
      console.log("🎤 Speak into your microphone...");
      console.log("   Press Ctrl+C to end the call\n");
      isConnected = true;

      // Start audio capture
      try {
        audioContext = createAudioContext();
        micStream = createMicrophoneStream((audioData: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(audioData);
          }
        });
      } catch (error) {
        console.error("⚠️  Could not start microphone:", error);
        console.log("   Continuing without microphone input...");
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof Buffer || event.data instanceof ArrayBuffer) {
        // Binary audio data from assistant
        if (audioContext) {
          audioContext.playAudio(event.data);
        }
      } else {
        // Control message (JSON)
        try {
          const message = JSON.parse(event.data as string) as ControlMessage;
          handleControlMessage(message, lastTranscript, (t) => { lastTranscript = t; });
        } catch {
          // Ignore parse errors
        }
      }
    };

    ws.onerror = (error) => {
      console.error("❌ WebSocket error:", error);
      if (!isConnected) {
        reject(error);
      }
    };

    ws.onclose = (event) => {
      console.log(`\n📴 Call ended (code: ${event.code})`);
      cleanup();
    };
  });
}

function handleControlMessage(
  message: ControlMessage,
  lastTranscript: string,
  setLastTranscript: (t: string) => void
): void {
  switch (message.type) {
    case "transcript": {
      const tm = message as TranscriptMessage;
      const prefix = tm.role === "user" ? "🎤 You" : "🤖 Assistant";
      
      if (tm.transcriptType === "final") {
        // Clear partial and show final
        process.stdout.write("\r" + " ".repeat(lastTranscript.length + 20) + "\r");
        console.log(`${prefix}: ${tm.transcript}`);
        setLastTranscript("");
      } else {
        // Show partial (overwrite previous partial)
        const line = `${prefix}: ${tm.transcript}`;
        process.stdout.write("\r" + " ".repeat(lastTranscript.length + 20) + "\r");
        process.stdout.write(line);
        setLastTranscript(line);
      }
      break;
    }
    case "speech-update": {
      const sm = message as SpeechUpdateMessage;
      if (sm.status === "started") {
        const who = sm.role === "user" ? "You" : "Assistant";
        console.log(`\n💬 ${who} started speaking...`);
      }
      break;
    }
    case "call-ended": {
      const cm = message as CallEndedMessage;
      console.log(`\n📞 Call ended: ${cm.reason || "unknown reason"}`);
      break;
    }
    default:
      // Ignore other message types
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio Utilities (Stubs - require native modules)
// ─────────────────────────────────────────────────────────────────────────────

function createAudioContext(): { playAudio: (data: Buffer | ArrayBuffer) => void; close: () => void } {
  // Lazy load speaker module
  let Speaker: typeof import("speaker") | null = null;
  let speakerInstance: InstanceType<typeof import("speaker")> | null = null;

  try {
    // Dynamic import for optional dependency
    Speaker = require("speaker");
    speakerInstance = new Speaker!({
      channels: 1,
      bitDepth: 16,
      sampleRate: 16000,
    });
  } catch {
    console.warn("⚠️  'speaker' module not installed. Audio playback disabled.");
    console.warn("   Install with: npm install speaker");
  }

  return {
    playAudio: (data: Buffer | ArrayBuffer) => {
      if (speakerInstance) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        speakerInstance.write(buffer);
      }
    },
    close: () => {
      if (speakerInstance) {
        speakerInstance.end();
      }
    },
  };
}

function createMicrophoneStream(
  onData: (data: Buffer) => void
): { stop: () => void } {
  let mic: ReturnType<typeof import("mic")> | null = null;
  let micInstance: ReturnType<ReturnType<typeof import("mic")>> | null = null;

  try {
    mic = require("mic");
    micInstance = mic!({
      rate: "16000",
      channels: "1",
      bitwidth: "16",
      encoding: "signed-integer",
      endian: "little",
      device: "default",
    });

    const micInputStream = micInstance!.getAudioStream();
    
    micInputStream.on("data", (data: Buffer) => {
      onData(data);
    });

    micInputStream.on("error", (error: Error) => {
      console.error("Microphone error:", error);
    });

    micInstance!.start();
  } catch (error) {
    console.warn("⚠️  'mic' module not installed or microphone unavailable.");
    console.warn("   Install with: npm install mic");
    console.warn("   Error:", error);
  }

  return {
    stop: () => {
      if (micInstance) {
        micInstance.stop();
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  console.log(`\n🚀 Starting WebSocket call`);
  console.log(`   Environment: ${config.env}`);
  console.log(`   ${config.resourceType}: ${config.target}\n`);

  // Check microphone permissions first
  const hasPermission = await checkMicrophonePermission();
  if (!hasPermission) {
    console.log("❌ Call cancelled due to microphone permission issues.");
    process.exit(1);
  }

  const state = loadState(config.env);
  const targetId = resolveTarget(state, config.target, config.resourceType);

  console.log(`   UUID: ${targetId}\n`);

  const call = await createCall(config, targetId);
  
  if (!call.transport?.websocketCallUrl) {
    console.error("❌ No WebSocket URL in response");
    console.error("   Response:", JSON.stringify(call, null, 2));
    process.exit(1);
  }

  console.log(`📞 Call ID: ${call.id}`);
  
  await connectWebSocket(call.transport.websocketCallUrl, config);
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
