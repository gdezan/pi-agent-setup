export interface CacheAlertIdentity {
  provider: string;
  model: string;
  promptTokens: number;
  reasons: string[];
}

function alertKey(identity: CacheAlertIdentity): string {
  const bucket = Math.floor(identity.promptTokens / 1_000) * 1_000;
  const reasons = identity.reasons
    .filter((reason) => reason !== "cache-read-near-zero")
    .sort()
    .join(",");
  return `${identity.provider}/${identity.model}|${bucket}|${reasons}`;
}

/** Deduplicate only meaningful-miss alerts; reset is intentionally explicit. */
export class CacheAlertDeduplicator {
  private readonly keys = new Set<string>();

  shouldAlert(identity: CacheAlertIdentity): boolean {
    const key = alertKey(identity);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  reset(): void {
    this.keys.clear();
  }
}

export function cacheAlertKey(identity: CacheAlertIdentity): string {
  return alertKey(identity);
}
