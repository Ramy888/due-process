// Canonical JSON: object keys sorted at every depth, so the same value always hashes the same.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : typeof v === "bigint"
        ? v.toString()
        : v,
  );
}
