function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function withoutAssistantFolder(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = data.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return data;
  }
  const gitops = (metadata as Record<string, unknown>).gitops;
  if (!isPlainObject(gitops)) return data;
  const { folderPath: _, ...rest } = gitops;
  const remainingMetadata = { ...(metadata as Record<string, unknown>) };
  if (Object.keys(rest).length > 0) remainingMetadata.gitops = rest;
  else delete remainingMetadata.gitops;
  const result = { ...data };
  if (Object.keys(remainingMetadata).length > 0)
    result.metadata = remainingMetadata;
  else delete result.metadata;
  return result;
}

export function withAssistantFolder(
  data: Record<string, unknown>,
  resourceId: string,
): Record<string, unknown> {
  const normalized = resourceId.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  const metadata = data.metadata;
  if (
    metadata != null &&
    (typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new Error("Assistant metadata must be an object");
  }
  const gitops = (metadata as Record<string, unknown> | null | undefined)
    ?.gitops;
  if (metadata && Object.hasOwn(metadata, "gitops") && !isPlainObject(gitops)) {
    throw new Error("Assistant metadata.gitops must be a plain object");
  }
  if (slash >= 0 && normalized.indexOf("/", slash + 1) >= 0) {
    console.warn(
      `  ⚠️  ${resourceId}: dashboard folders are one level deep; grouped under "${normalized.slice(0, slash)}".`,
    );
  }
  return {
    ...data,
    metadata: {
      ...(metadata as Record<string, unknown> | undefined),
      gitops: {
        ...(gitops as Record<string, unknown> | undefined),
        folderPath: slash < 0 ? null : normalized.slice(0, slash),
      },
    },
  };
}
