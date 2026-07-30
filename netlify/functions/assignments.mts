import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { verifyToken, isSuperadmin, isLabAdmin, type UserRole } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";

// A DRI/lab admin plans out, ahead of time, exactly which team carries which
// kit on which route/environment for a given day — replacing the earlier
// real-time "first team to tap the tile wins it" kit-hold system. Since a
// human with full day-of context is doing the planning, there's no
// concurrent-selection race to guard against; the only integrity check left
// is catching an admin's own mistake (assigning the same kit to two teams
// on the same day).
interface Assignment {
  id: string;
  studyId: string;
  date: string; // YYYY-MM-DD, the field day this assignment is valid for
  teamId: string; // team name, matches what field entries are tagged with
  kitNumber: number;
  route: string;
  environment: string;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

interface Study {
  id: string;
  createdBy: string;
  labAdminIds: string[];
}

interface User {
  id: string;
  role: UserRole;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function assignmentsKey(studyId: string): string {
  return studyId;
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

async function canManageAssignmentsFor(user: User | null, studyId: string): Promise<boolean> {
  if (!user) return false;
  if (isSuperadmin(user)) return true;
  // Deliberately excludes the study's creator (the Client DRI) — a DRI's
  // job is scoping the study itself, day-to-day team/kit/route assignment
  // is the Lab Admin's job, per explicit product decision.
  if (!isLabAdmin(user)) return false;
  const studiesStore = getStore({ name: "studies", consistency: "strong" });
  const study = (await studiesStore.get(studyId, { type: "json" })) as Study | null;
  if (!study) return false;
  return study.labAdminIds.includes(user.id);
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "assignments", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    // Unauthenticated on purpose — the field app (no login) reads today's
    // assignments to populate the team picker, the same way it reads the
    // study definition itself.
    const studyId = url.searchParams.get("study");
    if (!studyId) return Response.json({ error: "study is required" }, { status: 400 });
    const date = url.searchParams.get("date");

    const all = (await store.get(assignmentsKey(studyId), { type: "json" }) as Assignment[] | null) || [];
    const filtered = date ? all.filter((a) => a.date === date) : all;
    return Response.json({ assignments: filtered });
  }

  if (req.method === "POST") {
    const user = await resolveUser(req);
    const body = await req.json();
    if (!body.studyId || !(await canManageAssignmentsFor(user, body.studyId))) {
      return Response.json({ error: "you do not have permission to manage assignments for this study" }, { status: 403 });
    }
    if (!body.date || !body.teamId || !body.kitNumber || !body.environment) {
      return Response.json({ error: "date, teamId, kitNumber, and environment are required" }, { status: 400 });
    }

    const key = assignmentsKey(body.studyId);
    const existing = (await store.get(key, { type: "json" }) as Assignment[] | null) || [];

    const sameDay = existing.filter((a) => a.date === body.date);
    if (sameDay.some((a) => a.teamId === body.teamId)) {
      return Response.json({ error: `${body.teamId} already has an assignment for ${body.date}` }, { status: 400 });
    }
    const kitConflict = sameDay.find((a) => a.kitNumber === Number(body.kitNumber));
    if (kitConflict) {
      return Response.json(
        { error: `Kit ${body.kitNumber} is already assigned to ${kitConflict.teamId} on ${body.date}` },
        { status: 400 }
      );
    }

    const assignment: Assignment = {
      id: makeId(),
      studyId: body.studyId,
      date: body.date,
      teamId: body.teamId,
      kitNumber: Number(body.kitNumber),
      route: body.route || "",
      environment: body.environment,
      createdBy: user!.id,
      createdAt: new Date().toISOString()
    };

    await store.setJSON(key, [...existing, assignment]);
    return Response.json({ ok: true, assignment });
  }

  if (req.method === "PATCH") {
    const user = await resolveUser(req);
    const body = await req.json();
    if (!body.studyId || !(await canManageAssignmentsFor(user, body.studyId))) {
      return Response.json({ error: "you do not have permission to manage assignments for this study" }, { status: 403 });
    }
    if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });

    const key = assignmentsKey(body.studyId);
    const existing = (await store.get(key, { type: "json" }) as Assignment[] | null) || [];
    const idx = existing.findIndex((a) => a.id === body.id);
    if (idx === -1) return Response.json({ error: "not found" }, { status: 404 });

    const updates = body.updates || {};
    const merged = { ...existing[idx] };
    if ("kitNumber" in updates) merged.kitNumber = Number(updates.kitNumber);
    if ("route" in updates) merged.route = updates.route;
    if ("environment" in updates) merged.environment = updates.environment;
    merged.updatedAt = new Date().toISOString();

    const sameDayOthers = existing.filter((a) => a.date === merged.date && a.id !== merged.id);
    const kitConflict = sameDayOthers.find((a) => a.kitNumber === merged.kitNumber);
    if (kitConflict) {
      return Response.json(
        { error: `Kit ${merged.kitNumber} is already assigned to ${kitConflict.teamId} on ${merged.date}` },
        { status: 400 }
      );
    }

    const next = [...existing];
    next[idx] = merged;
    await store.setJSON(key, next);
    return Response.json({ ok: true, assignment: merged });
  }

  if (req.method === "DELETE") {
    const user = await resolveUser(req);
    const body = await req.json();
    if (!body.studyId || !(await canManageAssignmentsFor(user, body.studyId))) {
      return Response.json({ error: "you do not have permission to manage assignments for this study" }, { status: 403 });
    }
    if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });

    const key = assignmentsKey(body.studyId);
    const existing = (await store.get(key, { type: "json" }) as Assignment[] | null) || [];
    await store.setJSON(key, existing.filter((a) => a.id !== body.id));
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/assignments"
};
