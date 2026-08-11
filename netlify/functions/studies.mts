import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { verifyToken, isSuperadmin, isLabAdmin, type UserRole } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";
import { autoEmoji } from "./utils/emoji.mts";
import { updateJSON, ConcurrentWriteError } from "./utils/occ.mts";

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
  // Behavioral context tagged onto individual sign observations in the
  // field app (e.g. "reading a book", "using phone") — a separate,
  // per-study-configurable list from the taxonomy itself.
  interactions: { name: string; emoji: string }[];
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

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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

// Editing a study's operational details (protocols, locations, taxonomy,
// ...) is available to the creating DRI, an assigned Lab Admin, or a
// superadmin — a Lab Admin pivoting a week's location shouldn't have to
// wait on a DRI to respond while the team is standing in the field.
// Creating a new study and deleting/granting-access-to an existing one are
// stricter, separate checks (see the POST handler and canManageStudy).
function canEditStudy(user: User | null, study: Study): boolean {
  if (!user) return false;
  if (isSuperadmin(user)) return true;
  if (study.createdBy === user.id) return true;
  if (isLabAdmin(user) && study.labAdminIds.includes(user.id)) return true;
  return false;
}

// Deleting a study, or granting another account access to it, is a bigger
// deal than editing its operational details — kept to the creating DRI or
// a superadmin only, even for a Lab Admin who can otherwise edit the study.
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
      // Study Builder's "copy passcode" action asks for the real value back
      // (everywhere else a study is fetched by id, the caller is the
      // unauthenticated field/admin app and never needs it) — gated on the
      // same edit-permission check as the rest of the study's details.
      if (url.searchParams.get("reveal") === "1") {
        const user = await resolveUser(req);
        if (!canEditStudy(user, study)) {
          return Response.json({ error: "you do not have permission to view this study's passcode" }, { status: 403 });
        }
        return Response.json({ study });
      }
      return Response.json({ study: sanitizeForFieldApp(study) });
    }

    // Unauthenticated by design — this is how a field team (no account)
    // gets into a study at all now that there's no per-study URL to share.
    // A study's name isn't guaranteed unique, so the passcode is the real
    // access control here, not the name.
    const name = url.searchParams.get("name");
    const passcode = url.searchParams.get("passcode");
    if (name && passcode) {
      const { blobs } = await store.list();
      const studies = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }))) as Study[];
      const normalizedName = name.trim().toLowerCase();
      const match = studies.find((s) => s && s.name.trim().toLowerCase() === normalizedName && s.passcode === passcode);
      if (!match) {
        return Response.json({ error: "No study matches that name and passcode" }, { status: 401 });
      }
      return Response.json({ study: sanitizeForFieldApp(match) });
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
      interactions: Array.isArray(body.interactions) ? withAutoEmoji(body.interactions) : [],
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

    const allowedFields = [
      "name", "dateStart", "dateEnd", "passcode", "teamCount",
      "protocols", "environments", "objectKitCount", "signTypes", "interactions"
    ];
    const updates = body.updates || {};

    let saved!: Study;
    try {
      // Permission, "not found", and every validation below are re-checked
      // against the freshest read on every retry — a Lab Admin and a DRI
      // can now edit the same study concurrently (see canEditStudy), so a
      // plain read-then-write here would let one silently overwrite the
      // other's change with no error to either of them.
      await updateJSON<Study>(store, body.id, (current) => {
        if (!current) throw new ApiError("not found", 404);
        if (!canEditStudy(user, current)) {
          throw new ApiError("you do not have permission to edit this study", 403);
        }

        const merged: Study = { ...current };
        for (const field of allowedFields) {
          if (field in updates) (merged as any)[field] = updates[field];
        }
        // Assigning Lab Admins to a study is a superadmin-only action,
        // stricter than the general edit check above — a Lab Admin can
        // edit a study they're assigned to but can't grant *other*
        // accounts access to it.
        if ("labAdminIds" in updates) {
          if (!isSuperadmin(user)) {
            throw new ApiError("only superadmins can assign lab admins to a study", 403);
          }
          merged.labAdminIds = updates.labAdminIds;
        }
        // Location is scheduled per week and is expected to pivot —
        // including by a Lab Admin in the field who shouldn't have to
        // wait on a DRI to respond, so this rides the general
        // canEditStudy check above rather than needing its own DRI-only
        // carve-out like labAdminIds does.
        if ("locationSchedule" in updates) {
          const schedule = normalizeLocationSchedule(updates.locationSchedule);
          if (!schedule) {
            throw new ApiError("each location needs a week, state, and city, and a week can only appear once", 400);
          }
          merged.locationSchedule = schedule;
        }
        if (Array.isArray(merged.signTypes)) {
          merged.signTypes = withAutoEmoji(merged.signTypes);
        }
        if (Array.isArray(merged.interactions)) {
          merged.interactions = withAutoEmoji(merged.interactions);
        }
        merged.updatedAt = new Date().toISOString();

        saved = merged;
        return merged;
      });
    } catch (err) {
      if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention updating this study — please retry" }, { status: 409 });
      }
      throw err;
    }
    return Response.json({ ok: true, study: sanitizeForList(saved) });
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
