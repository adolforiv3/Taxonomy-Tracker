import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { verifyToken, isSuperadmin, isLabAdmin, type UserRole } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";
import { autoEmoji } from "./utils/emoji.mts";

// A study can run for weeks at a stretch while the team travels city to
// city, so location is scheduled per ISO week (e.g. "2026-W31") rather than
// being a single fixed value for the whole study — and unlike protocols or
// taxonomy, it's expected to pivot: a DRI can freely edit a week's location
// after the fact if the team's plans change.
interface LocationScheduleEntry {
  id: string;
  week: string; // ISO week, e.g. "2026-W31"
  state: string;
  city: string;
}

interface Study {
  id: string;
  name: string;
  createdBy: string; // user ID who created it
  labAdminIds: string[]; // lab admin IDs with access to this study
  dateStart: string;
  dateEnd: string;
  passcode: string;
  teamCount: number;
  protocols: string[];
  environments: string[];
  objectKitCount: number;
  signTypes: { name: string; emoji: string }[];
  locationSchedule: LocationScheduleEntry[];
  createdAt: string;
  updatedAt?: string;
}

interface User {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function sanitizeForList(study: Study) {
  const { passcode, ...rest } = study;
  return rest;
}

function sanitizeForFieldApp(study: Study) {
  const { passcode, ...rest } = study;
  return rest;
}

// Emoji is always derived from the name server-side — DRIs never pick one,
// so any client-supplied emoji is ignored and overwritten here.
function withAutoEmoji(signTypes: any[]): { name: string; emoji: string }[] {
  return signTypes.map((t) => ({ name: t.name, emoji: autoEmoji(t.name) }));
}

// Rejects a schedule that's missing required fields or double-books a week
// (two locations for the same week is almost certainly a mistake, not an
// intentional mid-week split — a genuine pivot is an edit, not a second
// entry). Returns null on any validation failure.
function normalizeLocationSchedule(input: any): LocationScheduleEntry[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const schedule: LocationScheduleEntry[] = [];
  for (const raw of input) {
    const entry = raw || {};
    if (!entry.week || !entry.state || !entry.city) return null;
    if (seen.has(entry.week)) return null;
    seen.add(entry.week);
    schedule.push({
      id: entry.id || Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4),
      week: entry.week,
      state: entry.state,
      city: entry.city
    });
  }
  return schedule;
}

async function resolveUser(req: Request): Promise<User | null> {
  const token = req.headers.get("x-user-token");
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.id) return null;

  const store = usersStore();
  const users = (await store.get("users", { type: "json" }) as User[] | null) || [];
  return users.find((u) => u.id === payload.id) || null;
}

function canViewStudy(user: User | null, study: Study): boolean {
  if (!user) return false;
  if (isSuperadmin(user)) return true;
  if (study.createdBy === user.id) return true;
  if (isLabAdmin(user) && study.labAdminIds.includes(user.id)) return true;
  return false;
}

function canManageStudy(user: User | null, study: Study): boolean {
  if (!user) return false;
  if (isSuperadmin(user)) return true;
  return study.createdBy === user.id;
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "studies", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const study = await store.get(id, { type: "json" }) as Study | null;
      if (!study) return new Response("Not found", { status: 404 });
      return Response.json({ study: sanitizeForFieldApp(study) });
    }

    const { blobs } = await store.list();
    const studies = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }))) as Study[];
    const sorted = studies.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const user = await resolveUser(req);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const filtered = sorted.filter((s) => canViewStudy(user, s));
    return Response.json({ studies: filtered.map(sanitizeForList) });
  }

  if (req.method === "POST") {
    const user = await resolveUser(req);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    // A DRI scopes studies, a superadmin can on their behalf — a Lab Admin's
    // job starts once a study (and their assignment to it) already exists.
    if (user.role !== "client_dri" && !isSuperadmin(user)) {
      return Response.json({ error: "only DRIs and superadmins can create studies" }, { status: 403 });
    }

    const body = await req.json();
    if (!body.name || !body.passcode) {
      return Response.json({ ok: false, error: "Name and passcode are required" }, { status: 400 });
    }

    const study: Study = {
      id: makeId(),
      name: body.name,
      createdBy: user.id,
      labAdminIds: body.labAdminIds || [],
      dateStart: body.dateStart || "",
      dateEnd: body.dateEnd || "",
      passcode: body.passcode,
      // A caller that omits the field entirely gets the old defaults; one that
      // explicitly sends 0 (the Study Builder's new default) gets exactly 0,
      // since `Number(0) || 6` would otherwise silently coerce it back to 6.
      teamCount: body.teamCount !== undefined ? Number(body.teamCount) || 0 : 6,
      protocols: Array.isArray(body.protocols) && body.protocols.length ? body.protocols : ["Walk", "Exploration", "Fast-Walk"],
      environments: Array.isArray(body.environments) ? body.environments : [],
      objectKitCount: body.objectKitCount !== undefined ? Number(body.objectKitCount) || 0 : 10,
      signTypes: Array.isArray(body.signTypes) ? withAutoEmoji(body.signTypes) : [],
      locationSchedule: normalizeLocationSchedule(body.locationSchedule) || [],
      createdAt: new Date().toISOString()
    };
    await store.setJSON(study.id, study);
    return Response.json({ ok: true, study: sanitizeForList(study) });
  }

  if (req.method === "PATCH") {
    const user = await resolveUser(req);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json();
    if (!body.id) return Response.json({ ok: false, error: "id is required" }, { status: 400 });

    const existing = await store.get(body.id, { type: "json" }) as Study | null;
    if (!existing) return new Response("Not found", { status: 404 });

    if (!canManageStudy(user, existing)) {
      return Response.json({ error: "you do not have permission to edit this study" }, { status: 403 });
    }

    const allowedFields = [
      "name", "dateStart", "dateEnd", "passcode", "teamCount",
      "protocols", "environments", "objectKitCount", "signTypes"
    ];
    const updates = body.updates || {};
    const merged = { ...existing };
    for (const field of allowedFields) {
      if (field in updates) (merged as any)[field] = updates[field];
    }
    // Assigning Lab Admins to a study is a superadmin-only action, separate
    // from the general "can this person edit the study" check above — a
    // DRI can edit their own study's details but can't grant study access
    // to other accounts.
    if ("labAdminIds" in updates) {
      if (!isSuperadmin(user)) {
        return Response.json({ error: "only superadmins can assign lab admins to a study" }, { status: 403 });
      }
      merged.labAdminIds = updates.labAdminIds;
    }
    // Location is scheduled per week and is expected to pivot, unlike
    // protocols/taxonomy — but still the DRI's (or a superadmin's) call,
    // same as the rest of the study, so it rides the general permission
    // check above rather than needing its own carve-out like labAdminIds.
    if ("locationSchedule" in updates) {
      const schedule = normalizeLocationSchedule(updates.locationSchedule);
      if (!schedule) {
        return Response.json({ error: "each location needs a week, state, and city, and a week can only appear once" }, { status: 400 });
      }
      merged.locationSchedule = schedule;
    }
    if (Array.isArray(merged.signTypes)) {
      merged.signTypes = withAutoEmoji(merged.signTypes);
    }
    merged.updatedAt = new Date().toISOString();

    await store.setJSON(body.id, merged);
    return Response.json({ ok: true, study: sanitizeForList(merged) });
  }

  if (req.method === "DELETE") {
    const user = await resolveUser(req);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json();
    if (!body.id) return Response.json({ ok: false, error: "id is required" }, { status: 400 });

    const existing = await store.get(body.id, { type: "json" }) as Study | null;
    if (!existing) return Response.json({ error: "not found" }, { status: 404 });

    if (!canManageStudy(user, existing)) {
      return Response.json({ error: "you do not have permission to delete this study" }, { status: 403 });
    }

    await store.delete(body.id);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/studies"
};
