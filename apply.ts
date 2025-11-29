import { VAPI_ENV, VAPI_BASE_URL } from "./src/config.ts";
import { loadState, saveState } from "./src/state.ts";
import { loadResources } from "./src/resources.ts";
import {
  applyTool,
  applyStructuredOutput,
  applyAssistant,
  updateToolAssistantRefs,
  updateStructuredOutputAssistantRefs,
} from "./src/apply.ts";
import { deleteOrphanedResources } from "./src/delete.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Main Apply Engine
// ─────────────────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🚀 Vapi GitOps Apply - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Load current state
  const state = loadState();

  // Load all resources
  console.log("\n📂 Loading resources...\n");
  const tools = await loadResources<Record<string, unknown>>("tools");
  const structuredOutputs = await loadResources<Record<string, unknown>>("structuredOutputs");
  const assistants = await loadResources<Record<string, unknown>>("assistants");

  // Delete orphaned resources first (checks for orphan references, then deletes)
  console.log("\n🗑️  Checking for deleted resources...\n");
  await deleteOrphanedResources({ tools, structuredOutputs, assistants }, state);

  // Apply in dependency order: tools → structured outputs → assistants
  console.log("\n🔧 Applying tools...\n");
  for (const tool of tools) {
    try {
      const uuid = await applyTool(tool, state);
      state.tools[tool.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply tool ${tool.resourceId}:`, error);
      throw error;
    }
  }

  console.log("\n📊 Applying structured outputs...\n");
  for (const output of structuredOutputs) {
    try {
      const uuid = await applyStructuredOutput(output, state);
      state.structuredOutputs[output.resourceId] = uuid;
    } catch (error) {
      console.error(
        `  ❌ Failed to apply structured output ${output.resourceId}:`,
        error
      );
      throw error;
    }
  }

  console.log("\n🤖 Applying assistants...\n");
  for (const assistant of assistants) {
    try {
      const uuid = await applyAssistant(assistant, state);
      state.assistants[assistant.resourceId] = uuid;
    } catch (error) {
      console.error(
        `  ❌ Failed to apply assistant ${assistant.resourceId}:`,
        error
      );
      throw error;
    }
  }

  // Second pass: Link resources to assistants (now that assistants exist)
  console.log("\n🔗 Linking tools to assistant destinations...\n");
  await updateToolAssistantRefs(tools, state);

  console.log("\n🔗 Linking structured outputs to assistants...\n");
  await updateStructuredOutputAssistantRefs(structuredOutputs, state);

  // Save updated state
  await saveState(state);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Apply complete!");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Summary
  console.log("📋 Summary:");
  console.log(`   Tools: ${Object.keys(state.tools).length}`);
  console.log(`   Structured Outputs: ${Object.keys(state.structuredOutputs).length}`);
  console.log(`   Assistants: ${Object.keys(state.assistants).length}`);
}

// Run the apply engine
apply().catch((error) => {
  console.error("\n❌ Apply failed:", error);
  process.exit(1);
});
