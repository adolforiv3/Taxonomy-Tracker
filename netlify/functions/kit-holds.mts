import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Object kits are physical equipment — two teams can't carry the same kit
// number into the field at once. A run stays "open" (unconfirmed) from the
// moment a team picks a kit until they finish capture and submit, so the
// hold has to exist for that whole window, not just at submit time. Holds
// are scoped per-study and keyed by kit number; each carries the
// team+session that placed it so only that team (or an expiry) can free it.
interface Hold {
  kitNumber: number;
  teamId: string;
  sessionId: string;
  heldAt: string;
  expiresAt: string;
}

// Generous enough to cover a full field day even if a tab is left open
// mid-capture; short enough that an abandoned hold doesn't block a kit
// indefinitely if a team never comes back to release it.
const HOLD_TTL_MS = 8 * 60 * 60 * 1000;

function holdsKey(studyId: string | null): string {
  return studyId || "default";
}

function isExpired(hold: Hold, now: number): boolean {
  return new Date(hold.expiresAt).getTime() <= now;
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "kit-holds", consistency: "strong" });
  const url = new URL(req.url);
  const now = Date.now();

  if (req.method === "GET") {
    const studyId = url.searchParams.get("study");
    const key = holdsKey(studyId);
    const holds = (await store.get(key, { type: "json" }) as Hold[] | null) || [];
    const active = holds.filter((h) => !isExpired(h, now));
    return Response.json({
      holds: active.map((h) => ({ kitNumber: h.kitNumber, teamId: h.teamId, sessionId: h.sessionId }))
    });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const studyId = body.studyId || null;
    const kitNumber = Number(body.kitNumber);
    const teamId = body.teamId;
    const sessionId = body.sessionId;
    if (!kitNumber || !teamId || !sessionId) {
      return Response.json({ error: "kitNumber, teamId, and sessionId are required" }, { status: 400 });
    }

    const key = holdsKey(studyId);
    const holds = (await store.get(key, { type: "json" }) as Hold[] | null) || [];
    const active = holds.filter((h) => !isExpired(h, now));

    const existing = active.find((h) => h.kitNumber === kitNumber);
    if (existing && !(existing.teamId === teamId && existing.sessionId === sessionId)) {
      return Response.json(
        { error: `Kit ${kitNumber} was just taken by ${existing.teamId}`, heldBy: existing.teamId },
        { status: 409 }
      );
    }

    const next = active.filter((h) => h.kitNumber !== kitNumber);
    next.push({
      kitNumber,
      teamId,
      sessionId,
      heldAt: new Date(now).toISOString(),
      expiresAt: new Date(now + HOLD_TTL_MS).toISOString()
    });

    await store.setJSON(key, next);
    return Response.json({ ok: true });
  }

  if (req.method === "DELETE") {
    const body = await req.json();
    const studyId = body.studyId || null;
    const kitNumber = Number(body.kitNumber);
    const teamId = body.teamId;
    const sessionId = body.sessionId;

    const key = holdsKey(studyId);
    const holds = (await store.get(key, { type: "json" }) as Hold[] | null) || [];
    const next = holds.filter(
      (h) => !isExpired(h, now) && !(h.kitNumber === kitNumber && h.teamId === teamId && h.sessionId === sessionId)
    );

    await store.setJSON(key, next);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/kit-holds"
};
