import type { Context, Config } from "@netlify/functions";
import { hashPassword, verifyPassword, newSessionToken, checkMasterPasscode, publicUser, verifyToken, isSuperadmin, type UserRole } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";
import { updateJSON, ConcurrentWriteError } from "./utils/occ.mts";

interface User {
  id: string;
  email: string;
  salt: string;
  hash: string;
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

async function loadUsers(): Promise<User[]> {
  const store = usersStore();
  const data = await store.get("users", { type: "json" }) as User[] | null;
  return data || [];
}

async function resolveUser(req: Request): Promise<User | null> {
  const token = req.headers.get("x-user-token");
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.id) return null;
  const users = await loadUsers();
  return users.find((u) => u.id === payload.id) || null;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.json();
  const action = body.action;

  if (action === "bootstrapStatus") {
    // Deliberately unauthenticated (the studio login screen calls this
    // before anyone has a session) and deliberately reveals only a
    // boolean — no user data. This exists because listUsers's 403 doesn't
    // distinguish "no account exists yet" from "you're just not logged
    // in as one" — both look identical to an unauthenticated caller, so
    // that path can't be reused to detect bootstrap eligibility.
    const users = await loadUsers();
    return Response.json({ needsBootstrap: users.length === 0 });
  }

  if (action === "bootstrap") {
    // Two people (or a retried request) could hit "bootstrap" at almost
    // the same instant. A plain load-then-save would let both pass the
    // "no users yet" check, both write, and the loser's account would
    // silently cease to exist with no error — they'd believe they have a
    // superadmin login that doesn't actually work. updateJSON() re-checks
    // "no users exist yet" against the freshest possible state on every
    // retry, so only one bootstrap can ever actually win.
    if (!checkMasterPasscode(body.masterPasscode)) {
      return Response.json({ error: "incorrect master passcode" }, { status: 401 });
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!email || password.length < 6) {
      return Response.json({ error: "email and password (6+ chars) required" }, { status: 400 });
    }

    let created!: User;
    try {
      const store = usersStore();
      await updateJSON<User[]>(store, "users", (current) => {
        const users = current || [];
        if (users.length > 0) {
          throw new ApiError("a superadmin account already exists", 400);
        }
        const { salt, hash } = hashPassword(password);
        created = {
          id: makeId(),
          email,
          salt,
          hash,
          role: "superadmin",
          createdAt: new Date().toISOString(),
        };
        return [created];
      });
    } catch (err) {
      if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention setting up the account — please retry" }, { status: 409 });
      }
      throw err;
    }
    const token = newSessionToken(created.id, created.role);
    return Response.json({ token, user: publicUser(created) }, { status: 201 });
  }

  if (action === "createUser") {
    const requester = await resolveUser(req);
    if (!requester || !isSuperadmin(requester)) {
      return Response.json({ error: "only superadmins can create accounts" }, { status: 403 });
    }

    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const role: UserRole = body.role || "client_dri";

    if (!email || password.length < 6) {
      return Response.json({ error: "email and password (6+ chars) required" }, { status: 400 });
    }
    if (!["client_dri", "lab_admin", "superadmin"].includes(role)) {
      return Response.json({ error: "invalid role" }, { status: 400 });
    }

    let created!: User;
    try {
      const store = usersStore();
      // Re-checked against the freshest read on every retry — two
      // superadmins (or a double-click) creating accounts around the same
      // moment could otherwise both pass the "email available" check and
      // one account would silently vanish on the losing write.
      await updateJSON<User[]>(store, "users", (current) => {
        const users = current || [];
        if (users.some((u) => u.email === email)) {
          throw new ApiError("email already exists", 400);
        }
        const { salt, hash } = hashPassword(password);
        created = {
          id: makeId(),
          email,
          salt,
          hash,
          role,
          createdAt: new Date().toISOString(),
        };
        return [...users, created];
      });
    } catch (err) {
      if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention creating this account — please retry" }, { status: 409 });
      }
      throw err;
    }
    return Response.json({ user: publicUser(created) }, { status: 201 });
  }

  if (action === "login") {
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const users = await loadUsers();
    const user = users.find((u) => u.email === email);

    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return Response.json({ error: "invalid email or password" }, { status: 401 });
    }

    const token = newSessionToken(user.id, user.role);
    return Response.json({ token, user: publicUser(user) });
  }

  if (action === "whoami") {
    const user = await resolveUser(req);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ user: publicUser(user) });
  }

  if (action === "listUsers") {
    const requester = await resolveUser(req);
    if (!requester || !isSuperadmin(requester)) {
      return Response.json({ error: "only superadmins can list users" }, { status: 403 });
    }

    const users = await loadUsers();
    return Response.json({ users: users.map(publicUser) });
  }

  if (action === "changePassword") {
    const user = await resolveUser(req);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 6) {
      return Response.json({ error: "current password and new password (6+ chars) required" }, { status: 400 });
    }

    try {
      const store = usersStore();
      // Verifying the *current* password inside the mutator (not before
      // it) matters: if this same account's password changed a split
      // second earlier (another concurrent request, or the account itself
      // racing this one), we must re-check "current password" against
      // that fresh hash on every retry, not a stale one read before the
      // race started.
      await updateJSON<User[]>(store, "users", (current) => {
        const users = current || [];
        const idx = users.findIndex((u) => u.id === user.id);
        if (idx === -1) throw new ApiError("user not found", 404);
        if (!verifyPassword(body.currentPassword, users[idx].salt, users[idx].hash)) {
          throw new ApiError("current password is incorrect", 401);
        }
        const { salt, hash } = hashPassword(body.newPassword);
        const updated = [...users];
        updated[idx] = { ...updated[idx], salt, hash };
        return updated;
      });
    } catch (err) {
      if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof ConcurrentWriteError) {
        return Response.json({ error: "too much contention updating your account — please retry" }, { status: 409 });
      }
      throw err;
    }

    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
};

export const config: Config = {
  path: "/api/users"
};
