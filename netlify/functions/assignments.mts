import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { verifyToken, isSuperadmin, isLabAdmin, type UserRole } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";
import { updateJSON, ConcurrentWriteError } from "./utils/occ.mts";

// A lab admin plans out, ahead of time, exactly which team carries which
// kit for a given day — replacing the earlier real-time "first team to tap
// the tile wins it" kit-hold system. Since a human with full day-of context
// is doing the planning, there's no concurrent-*selection* race to guard
// against; the only integrity check left is catching an admin's own mistake
// (assigning the same kit to two teams on the same day). Geographic
// location is a DRI-owned, study-level concept scheduled per week (see
// studies.mts's locationSchedule) — it doesn't live here.
//
// That said, every assignment for a given study — regardless of team or
// date — is stored under one shared blob key, and this study can now be
// edited by more than one Lab Admin concurrently. Every write below goes
// through updateJSON() (see utils/occ.mts) precisely because a plain
// read-modify-write here would let two Lab Admins creating or editing
// *unrelated* assignments for the same study silently overwrite one
// another — the losing write returns success but its effect disappears.
//
// A team's assignment carries one or more routes: a primary, plus optional
// backups for when the primary is obstructed or otherwise compromising data
// accuracy. Each route has its own environment, since a backup route may run
// through a different environment type than the primary. The field app
// prompts the team to pick which route they're actually using whenever more
// than one is on offer.
interface AssignmentRoute {
  id: string;
  label: string; // "Primary Route", "Backup Route 1", ...
  route: string;
  environment: string;
}

interface Assignment {
  id: string;
  studyId: string;
  date: string; // YYYY-MM-DD, the field day this assignment is valid for
  teamId: string; // team name, matches what field entries are tagged with
  kitNumber: number;
  routes: AssignmentRoute[];
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

function assignmentsKey(studyId: string): string {
  return studyId;
}

function normalizeRoutes(input: any): AssignmentRoute[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const routes: AssignmentRoute[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = input[i] || {};
    if (!r.environment) return null;
    routes.push({
      id: r.id || makeId(),
      label: i === 0 ? "Primary Route" : `Backup Route ${i}`,
      route: r.route || "",
      environment: r.environment
    });
  }
  return routes;
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
    if (!body.date || !body.teamId || !body.kitNumber) {
      return Response.json({ error: "date, teamId, and kitNumber are required" }, { status: 400 });
    }
    const routes = normalizeRoutes(body.routes);
    if (!routes) {
      return Response.json({ error: "at least one route with an environment is required" }, { status: 400 });
    }

    const key = assignmentsKey(body.studyId);
    let created!: Assignment;
    try {
      await updateJSON<Assignment[]>(store, key, (current) => {
        const existing = current || [];
        // Re-checked against the freshest read on every retry attempt, not
        // just once against a snapshot — otherwise two concurrent creates
        // could each individually pass this check and still collide.
        const sameDay = existing.filter((a) => a.date === body.date);
        if (sameDay.some((a) => a.teamId === body.teamId)) {
          throw new ApiError(`${body.teamId} already has an assignment for ${body.date}`, 400);
        }
        const kitConflict = sameDay.find((a) => a.kitNumber === Number(body.kitNumber));
        if (kitConflict) {
          throw new ApiError(`Kit ${body.kitNumber} is already assigned to ${kitConflict.teamId} on ${body.date}`, 400);
        }
        created = {
          id: makeId(),
          studyId: body.studyId,
          date: body.date,
          teamId: body.teamId,
          kitNumber: Number(body.kitNumber),
          routes,
          createdBy: user!.id,
          createdAt: new Date().toISOString()
        };
        return [...existing, created];
      });
    } catch (err) {
      if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention creating this assignment — please retry" }, { status: 409 });
      }
      throw err;
    }
    return Response.json({ ok: true, assignment: created });
  }

  if (req.method === "PATCH") {
    const user = await resolveUser(req);
    const body = await req.json();
    if (!body.studyId || !(await canManageAssignmentsFor(user, body.studyId))) {
      return Response.json({ error: "you do not have permission to manage assignments for this study" }, { status: 403 });
    }
    if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });

    const key = assignmentsKey(body.studyId);
    let saved!: Assignment;
    try {
      await updateJSON<Assignment[]>(store, key, (current) => {
        const existing = current || [];
        const idx = existing.findIndex((a) => a.id === body.id);
        if (idx === -1) throw new ApiError("not found", 404);

        const updates = body.updates || {};
        const merged = { ...existing[idx] };
        if ("kitNumber" in updates) merged.kitNumber = Number(updates.kitNumber);
        if ("routes" in updates) {
          const routes = normalizeRoutes(updates.routes);
          if (!routes) throw new ApiError("at least one route with an environment is required", 400);
          merged.routes = routes;
        }
        merged.updatedAt = new Date().toISOString();

        const sameDayOthers = existing.filter((a) => a.date === merged.date && a.id !== merged.id);
        const kitConflict = sameDayOthers.find((a) => a.kitNumber === merged.kitNumber);
        if (kitConflict) {
          throw new ApiError(`Kit ${merged.kitNumber} is already assigned to ${kitConflict.teamId} on ${merged.date}`, 400);
        }

        saved = merged;
        const next = [...existing];
        next[idx] = merged;
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention updating this assignment — please retry" }, { status: 409 });
      }
      throw err;
    }
    return Response.json({ ok: true, assignment: saved });
  }

  if (req.method === "DELETE") {
    const user = await resolveUser(req);
    const body = await req.json();
    if (!body.studyId || !(await canManageAssignmentsFor(user, body.studyId))) {
      return Response.json({ error: "you do not have permission to manage assignments for this study" }, { status: 403 });
    }
    if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });

    const key = assignmentsKey(body.studyId);
    try {
      await updateJSON<Assignment[]>(store, key, (current) => {
        const existing = current || [];
        return existing.filter((a) => a.id !== body.id);
      });
    } catch (err) {
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention removing this assignment — please retry" }, { status: 409 });
      }
      throw err;
    }
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/assignments"
};
