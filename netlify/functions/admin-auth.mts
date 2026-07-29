import type { Context, Config } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { passcode } = await req.json();
  const expected = Netlify.env.get("ADMIN_PASSCODE");

  if (!expected) return Response.json({ ok: false, error: "Admin passcode not configured" }, { status: 500 });
  if (passcode !== expected) return Response.json({ ok: false }, { status: 401 });

  return Response.json({ ok: true });
};

export const config: Config = {
  path: "/api/admin-auth"
};
