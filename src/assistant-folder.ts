export function withoutAssistantFolder(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = data.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return data;
  }
  const { folderPath: _, ...rest } = metadata as Record<string, unknown>;
  const result = { ...data };
  if (Object.keys(rest).length > 0) result.metadata = rest;
  else delete result.metadata;
  return result;
}

export function withAssistantFolder(
  data: Record<string, unknown>,
  resourceId: string,
): Record<string, unknown> {
  const normalized = resourceId.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const metadata = data.metadata;
  if (
    metadata != null &&
    (typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new Error("Assistant metadata must be an object");
  }
  return {
    ...data,
    metadata: {
      ...(metadata as Record<string, unknown> | undefined),
      folderPath: slash < 0 ? null : normalized.slice(0, slash),
    },
  };
}
