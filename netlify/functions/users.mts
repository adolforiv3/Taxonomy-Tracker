import type { Context, Config } from "@netlify/functions";
import { hashPassword, verifyPassword, newSessionToken, checkMasterPasscode, publicUser, verifyToken, isSuperadmin, type UserRole } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";

interface User {
  id: string;
  email: string;
  salt: string;
  hash: string;
  role: UserRole;
  createdAt: string;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

async function loadUsers(): Promise<User[]> {
  const store = usersStore();
  const data = await store.get("users", { type: "json" }) as User[] | null;
  return data || [];
}

async function saveUsers(users: User[]): Promise<void> {
  const store = usersStore();
  await store.setJSON("users", users);
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

  if (action === "bootstrap") {
    const users = await loadUsers();
    if (users.length > 0) {
      return Response.json({ error: "a superadmin account already exists" }, { status: 400 });
    }
    if (!checkMasterPasscode(body.masterPasscode)) {
      return Response.json({ error: "incorrect master passcode" }, { status: 401 });
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!email || password.length < 6) {
      return Response.json({ error: "email and password (6+ chars) required" }, { status: 400 });
    }

    const { salt, hash } = hashPassword(password);
    const user: User = {
      id: makeId(),
      email,
      salt,
      hash,
      role: "superadmin",
      createdAt: new Date().toISOString(),
    };
    await saveUsers([user]);
    const token = newSessionToken(user.id, user.role);
    return Response.json({ token, user: publicUser(user) }, { status: 201 });
  }

  if (action === "createUser") {
    const requester = await resolveUser(req);
    if (!requester || !isSuperadmin(requester)) {
      return Response.json({ error: "only superadmins can create accounts" }, { status: 403 });
    }

    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const role: UserRole = body.role || "user";

    if (!email || password.length < 6) {
      return Response.json({ error: "email and password (6+ chars) required" }, { status: 400 });
    }
    if (!["user", "lab_admin", "superadmin"].includes(role)) {
      return Response.json({ error: "invalid role" }, { status: 400 });
    }

    const users = await loadUsers();
    if (users.some((u) => u.email === email)) {
      return Response.json({ error: "email already exists" }, { status: 400 });
    }

    const { salt, hash } = hashPassword(password);
    const user: User = {
      id: makeId(),
      email,
      salt,
      hash,
      role,
      createdAt: new Date().toISOString(),
    };
    await saveUsers([...users, user]);
    return Response.json({ user: publicUser(user) }, { status: 201 });
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

    if (!verifyPassword(body.currentPassword, user.salt, user.hash)) {
      return Response.json({ error: "current password is incorrect" }, { status: 401 });
    }

    const { salt, hash } = hashPassword(body.newPassword);
    const users = await loadUsers();
    const idx = users.findIndex((u) => u.id === user.id);
    if (idx === -1) return Response.json({ error: "user not found" }, { status: 404 });

    const updated = [...users];
    updated[idx] = { ...updated[idx], salt, hash };
    await saveUsers(updated);

    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
};

export const config: Config = {
  path: "/api/users"
};
