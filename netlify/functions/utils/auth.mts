import { scryptSync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_SECRET = Netlify.env.get("USER_TOKEN_SECRET") || "taxonomy-logger-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MASTER_PASSCODE = Netlify.env.get("MASTER_PASSCODE") || "taxonomyadmin";

export type UserRole = "user" | "lab_admin" | "superadmin";

function b64url(buf: Buffer): string {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

export function hashPassword(password: string, salt: string = randomBytes(16).toString("hex")): { salt: string; hash: string } {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  if (!salt || !hash) return false;
  const attempt = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signToken(payload: Record<string, any>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): Record<string, any> | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newSessionToken(userId: string, role: UserRole): string {
  return signToken({ id: userId, role, exp: Date.now() + TOKEN_TTL_MS });
}

export function checkMasterPasscode(passcode: string): boolean {
  return !!passcode && passcode === MASTER_PASSCODE;
}

export function publicUser(user: any): any {
  if (!user) return user;
  const { salt, hash, ...rest } = user;
  return rest;
}

export function isSuperadmin(user: any): boolean {
  return !!user && user.role === "superadmin";
}

export function isLabAdmin(user: any): boolean {
  return !!user && user.role === "lab_admin";
}
