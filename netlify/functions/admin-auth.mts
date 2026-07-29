import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { passcode, studyId } = await req.json();

  let expected: string | null | undefined;
  if (studyId && studyId !== "default") {
    const store = getStore({ name: "studies", consistency: "strong" });
    const study = await store.get(studyId, { type: "json" }) as any;
    if (!study) return Response.json({ ok: false, error: "Study not found" }, { status: 404 });
    expected = study.passcode;
  } else if (studyId === "__studio__") {
    expected = Netlify.env.get("STUDIO_PASSCODE");
  } else {
    expected = Netlify.env.get("ADMIN_PASSCODE");
  }

  if (!expected) return Response.json({ ok: false, error: "Passcode not configured" }, { status: 500 });
  if (passcode !== expected) return Response.json({ ok: false }, { status: 401 });

  return Response.json({ ok: true });
};

export const config: Config = {
  path: "/api/admin-auth"
};
