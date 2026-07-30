import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { verifyToken } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";

// One row per run (route + protocol + session), not one row per sign
// observed — matches the run-log format the team already reads day to day.
// "Offload Status" is left blank for the team to fill in by hand, same as
// their existing sheet; this app has no notion of physical device offload.
const CSV_COLUMNS = [
  "date", "team_id", "location_state", "location_city", "route", "environment", "protocol",
  "object_kit", "calibration_session_id", "capture_session_id", "signs_observed", "offload_status", "notes"
];

// Root app (no studyId) keeps its original unprefixed key scheme so existing data
// stays reachable. Studies created via the Study Builder get their own namespace.
function keyPrefix(studyId: string | null): string {
  return studyId && studyId !== "default" ? `${studyId}/` : "";
}

function isoWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const week = 1 + Math.ceil((firstThursday - target.valueOf()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A "run" is every entry sharing a team + capture (or calibration) session —
// the same grouping admin.html's team accordion already uses to fold
// individual sign observations back into the session they were captured in.
function groupIntoRuns(entries: any[]): any[][] {
  const map = new Map<string, any[]>();
  entries.forEach((e) => {
    const key = `${e.teamId}::${e.captureSessionId || e.calibrationSessionId || e.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  });
  return [...map.values()];
}

function summarizeSigns(run: any[]): string {
  const counts = new Map<string, number>();
  run.forEach((e) => counts.set(e.signType, (counts.get(e.signType) || 0) + 1));
  return [...counts.entries()].map(([signType, n]) => (n > 1 ? `${signType} x${n}` : signType)).join(", ");
}

function toCsv(entries: any[]): string {
  const runs = groupIntoRuns(entries)
    .slice()
    .sort((a, b) => String(a[0].timestamp).localeCompare(String(b[0].timestamp)));
  const rows = runs.map((run) => {
    const first = run[0];
    return [
      first.date, first.teamId, first.locationState, first.locationCity, first.route, first.environment,
      first.protocol, first.objectKit, first.calibrationSessionId, first.captureSessionId,
      summarizeSigns(run), "", first.sessionNotes
    ].map(csvEscape).join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

// The companion "how many of each sign type, per day" tally the team keeps
// alongside the run log — one table per team (teams often work different
// days/routes), rows for every taxonomy item the study defines (so an item
// nobody saw all week still shows as a zero, not a missing row), columns for
// each day that team actually logged something, plus a running total.
async function fetchStudySignTypes(studyId: string | null): Promise<string[] | null> {
  if (!studyId || studyId === "default") return null;
  const studiesStore = getStore({ name: "studies", consistency: "strong" });
  const study = (await studiesStore.get(studyId, { type: "json" })) as any | null;
  if (!study || !Array.isArray(study.signTypes)) return null;
  return study.signTypes.map((t: any) => t.name);
}

function toTallyCsv(entries: any[], canonicalSignTypes: string[] | null): string {
  const byTeam = new Map<string, any[]>();
  entries.forEach((e) => {
    if (!byTeam.has(e.teamId)) byTeam.set(e.teamId, []);
    byTeam.get(e.teamId)!.push(e);
  });

  const teamBlocks = [...byTeam.keys()].sort().map((teamId) => {
    const teamEntries = byTeam.get(teamId)!;
    const dates = [...new Set(teamEntries.map((e) => e.date))].sort();

    const signTypes = canonicalSignTypes && canonicalSignTypes.length
      ? [...canonicalSignTypes]
      : [];
    const counts = new Map<string, Map<string, number>>();
    teamEntries.forEach((e) => {
      if (!counts.has(e.signType)) counts.set(e.signType, new Map());
      if (!signTypes.includes(e.signType)) signTypes.push(e.signType);
      const perDate = counts.get(e.signType)!;
      perDate.set(e.date, (perDate.get(e.date) || 0) + 1);
    });
    signTypes.sort((a, b) => a.localeCompare(b));

    const header = ["Signs", ...dates, "Total"].map(csvEscape).join(",");
    const rows = signTypes.map((s) => {
      const perDate = counts.get(s) || new Map<string, number>();
      const dayCounts = dates.map((d) => perDate.get(d) || 0);
      const total = dayCounts.reduce((sum, n) => sum + n, 0);
      return [s, ...dayCounts, total].map(csvEscape).join(",");
    });

    return [`Team: ${teamId}`, header, ...rows].join("\n");
  });

  return teamBlocks.join("\n\n");
}

// Resolves the requesting lab admin/superadmin from the bearer token, if present.
// A valid token here means "acting with admin oversight" — it's what grants
// cross-team edit access and is the *only* thing that grants delete access.
// Field teams never hold one of these; they authenticate purely by naming
// their team, which is why deletion (a destructive, hard-to-undo action) is
// gated on this instead of on teamId matching.
async function resolveAdmin(req: Request): Promise<{ id: string; role: string } | null> {
  const token = req.headers.get("x-user-token");
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.id) return null;

  const store = usersStore();
  const users = (await store.get("users", { type: "json" }) as any[] | null) || [];
  const user = users.find((u) => u.id === payload.id);
  return user ? { id: user.id, role: user.role } : null;
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "taxonomy-entries", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const studyId = url.searchParams.get("study");
    const prefix = keyPrefix(studyId);
    const week = url.searchParams.get("week") || isoWeek(new Date().toISOString().slice(0, 10));
    const { blobs } = await store.list({ prefix: `${prefix}${week}/` });
    const values = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    const entries = values.filter(Boolean);

    if (url.searchParams.get("format") === "csv") {
      if (url.searchParams.get("view") === "tally") {
        const canonicalSignTypes = await fetchStudySignTypes(studyId);
        return new Response(toTallyCsv(entries, canonicalSignTypes), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": `attachment; filename="taxonomy_tally_week_${week}.csv"`
          }
        });
      }
      return new Response(toCsv(entries), {
        headers: {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="taxonomy_runs_week_${week}.csv"`
        }
      });
    }
    return Response.json({ week, entries });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const items = Array.isArray(body.entries) ? body.entries : [];
    const teamId = body.teamId;

    // Require team ID to submit entries
    if (!teamId) {
      return Response.json({ error: "teamId is required" }, { status: 400 });
    }

    // All entries must be from the same team
    if (items.some((item) => item.teamId !== teamId)) {
      return Response.json({ error: "all entries must be from the same team" }, { status: 400 });
    }

    for (const item of items) {
      const prefix = keyPrefix(item.studyId || null);
      const week = isoWeek(item.date);
      await store.setJSON(`${prefix}${week}/${item.id}`, item);
    }
    return Response.json({ ok: true, count: items.length });
  }

  if (req.method === "PATCH") {
    const body = await req.json();
    const admin = await resolveAdmin(req);
    const teamId = body.teamId;

    // Either an authenticated lab admin/superadmin, or the owning team, may edit.
    if (!admin && !teamId) {
      return Response.json({ error: "teamId is required" }, { status: 400 });
    }

    const prefix = keyPrefix(body.studyId || null);
    const week = body.week || isoWeek(new Date().toISOString().slice(0, 10));
    const key = `${prefix}${week}/${body.id}`;
    const existing = await store.get(key, { type: "json" });
    if (!existing) return new Response("Not found", { status: 404 });

    if (!admin && existing.teamId !== teamId) {
      return Response.json({ error: "you can only edit entries from your team" }, { status: 403 });
    }

    const allowedFields = ["date", "route", "signType", "calibrationSessionId", "captureSessionId", "sessionNotes", "note"];
    const updates = body.updates || {};
    const merged = { ...existing };
    for (const field of allowedFields) {
      if (field in updates) merged[field] = updates[field];
    }
    merged.editedAt = new Date().toISOString();

    await store.setJSON(key, merged);
    return Response.json({ ok: true, entry: merged });
  }

  if (req.method === "DELETE") {
    // Deletion is destructive and hard to undo, so it's restricted to
    // authenticated lab admins/superadmins only — field teams can edit their
    // own runs (see PATCH above) but can never delete one, by design.
    const admin = await resolveAdmin(req);
    if (!admin) {
      return Response.json({ error: "only lab admins can delete entries" }, { status: 403 });
    }

    const body = await req.json();
    const prefix = keyPrefix(body.studyId || null);
    const week = body.week || isoWeek(new Date().toISOString().slice(0, 10));
    const key = `${prefix}${week}/${body.id}`;

    await store.delete(key);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/entries"
};
