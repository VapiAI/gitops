// Vapi resources are open-ended JSON config objects. This helper intentionally
// visits only documented resource-reference locations; a generic recursive
// `assistantId` rewrite could corrupt customer metadata or function schemas.
type VapiConfigObject = Record<string, unknown>;

function isConfigObject(value: unknown): value is VapiConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function visitDestinations(
  value: unknown,
  visit: (owner: VapiConfigObject, assistantId: string) => void,
): void {
  if (!Array.isArray(value)) return;

  for (const destination of value) {
    if (!isConfigObject(destination)) continue;
    if (typeof destination.assistantId !== "string") continue;
    visit(destination, destination.assistantId);
  }
}

/** Visit assistant references in supported Vapi resource shapes. */
export function visitAssistantIdReferences(
  data: VapiConfigObject,
  visit: (owner: VapiConfigObject, assistantId: string) => void,
): void {
  visitDestinations(data.destinations, visit);

  if (!Array.isArray(data.members)) return;
  for (const member of data.members) {
    if (!isConfigObject(member)) continue;

    if (typeof member.assistantId === "string") {
      visit(member, member.assistantId);
    }
    visitDestinations(member.assistantDestinations, visit);

    const overrides = member.assistantOverrides;
    if (!isConfigObject(overrides)) continue;
    const appendedTools = overrides["tools:append"];
    if (!Array.isArray(appendedTools)) continue;

    for (const tool of appendedTools) {
      if (!isConfigObject(tool) || tool.type !== "handoff") continue;
      visitDestinations(tool.destinations, visit);
    }
  }
}
