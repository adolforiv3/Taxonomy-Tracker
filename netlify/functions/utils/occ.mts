import type { Store } from "@netlify/blobs";

// Generic optimistic-concurrency read-modify-write helper for Netlify Blobs.
//
// Netlify Blobs has no built-in locking or transactions: store.get() and
// store.setJSON() are two independent network calls. Under real concurrent
// traffic, two function invocations can both read the same value, both
// compute an update from it, and both write — the second write silently
// overwrites the first with no error (Netlify's own docs: "if multiple
// write calls to the same key are issued, the last write wins"). Every
// mutation endpoint in this app (studies, assignments, users) originally
// did a plain read-then-write, which meant a DRI and a Lab Admin editing
// the same study, or two Lab Admins creating different assignments for the
// same study, could silently clobber each other — no error, the losing
// write just vanishes. assignments.mts is the sharpest case: every
// assignment for a study, regardless of team or date, shares one blob key.
//
// This wraps a read-modify-write in a compare-and-swap loop using the
// `onlyIfMatch` / `onlyIfNew` conditional-write options Netlify Blobs
// provides (backed by the entry's ETag). If a concurrent write beat us,
// the write comes back with `modified: false` and we retry with a fresh
// read — the mutate() callback re-runs against the latest data every time,
// so validation inside it (uniqueness checks, conflict checks, ...) always
// sees current state, not a stale snapshot.

export class ConcurrentWriteError extends Error {
  key: string;
  attempts: number;
  code = "CONCURRENT_WRITE";

  constructor(key: string, attempts: number) {
    super(`giving up on "${key}" after ${attempts} conflicting concurrent writes`);
    this.name = "ConcurrentWriteError";
    this.key = key;
    this.attempts = attempts;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param store - must be constructed with `consistency: "strong"` so our own
 *   read isn't looking at a stale edge cache.
 * @param key
 * @param mutate - receives the current value (or `null` if the key doesn't
 *   exist yet) and returns the new value to write. May be async. May throw
 *   to abort immediately without retrying — use this for validation/
 *   business-rule failures that re-reading won't fix (e.g. "duplicate
 *   email", "kit already assigned"); the caller catches that error itself,
 *   this helper only catches its own conflict-retry signal.
 * @returns the value that was actually persisted
 */
export async function updateJSON<T>(
  store: Store,
  key: string,
  mutate: (current: T | null) => T | Promise<T>,
  { maxAttempts = 8 }: { maxAttempts?: number } = {}
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = await store.getWithMetadata(key, { type: "json" });
    const current = (existing ? existing.data : null) as T | null;

    const next = await mutate(current);

    const writeOpts = existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true };
    const result = await store.setJSON(key, next as any, writeOpts as any);

    // Netlify's own docs promise setJSON() always resolves with
    // `{ modified, etag }`, but this has been observed in production to
    // sometimes resolve to `undefined` instead — naively destructuring
    // that crashes the write with a TypeError regardless of whether the
    // write actually succeeded. Only treat an *explicit* `modified: false`
    // as "someone else won the race, retry." Anything else — a proper
    // `{modified:true}`, or a response that doesn't match the documented
    // shape at all — is treated as a successful write. Worst case, on
    // whatever deploys/SDK versions don't return the documented shape,
    // this only gives up the conflict-retry guarantee for that specific
    // write (falling back to plain last-write-wins, the documented
    // baseline without conditional writes) — a far better failure mode
    // than every save in the app throwing.
    if (result && (result as any).modified === false) {
      await sleep(10 + Math.random() * 20 * attempt);
      continue;
    }
    return next;
  }
  throw new ConcurrentWriteError(key, maxAttempts);
}
