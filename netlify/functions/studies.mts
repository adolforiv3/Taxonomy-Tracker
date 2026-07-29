import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

interface Study {
  id: string;
  name: string;
  dateStart: string;
  dateEnd: string;
  passcode: string;
  teamCount: number;
  protocols: string[];
  environments: string[];
  objectKitCount: number;
  signTypes: { name: string; emoji: string }[];
  createdAt: string;
  updatedAt?: string;
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
    return Response.json({ studies: sorted.map(sanitizeForList) });
  }

  if (req.method === "POST") {
    const body = await req.json();
    if (!body.name || !body.passcode) {
      return Response.json({ ok: false, error: "Name and passcode are required" }, { status: 400 });
    }
    const study: Study = {
      id: makeId(),
      name: body.name,
      dateStart: body.dateStart || "",
      dateEnd: body.dateEnd || "",
      passcode: body.passcode,
      teamCount: Number(body.teamCount) || 6,
      protocols: Array.isArray(body.protocols) && body.protocols.length ? body.protocols : ["Walk", "Exploration", "Fast-Walk"],
      environments: Array.isArray(body.environments) ? body.environments : [],
      objectKitCount: Number(body.objectKitCount) || 10,
      signTypes: Array.isArray(body.signTypes) ? body.signTypes : [],
      createdAt: new Date().toISOString()
    };
    await store.setJSON(study.id, study);
    return Response.json({ ok: true, study: sanitizeForList(study) });
  }

  if (req.method === "PATCH") {
    const body = await req.json();
    if (!body.id) return Response.json({ ok: false, error: "id is required" }, { status: 400 });
    const existing = await store.get(body.id, { type: "json" }) as Study | null;
    if (!existing) return new Response("Not found", { status: 404 });

    const allowedFields = [
      "name", "dateStart", "dateEnd", "passcode", "teamCount",
      "protocols", "environments", "objectKitCount", "signTypes"
    ];
    const updates = body.updates || {};
    const merged = { ...existing };
    for (const field of allowedFields) {
      if (field in updates) (merged as any)[field] = updates[field];
    }
    merged.updatedAt = new Date().toISOString();

    await store.setJSON(body.id, merged);
    return Response.json({ ok: true, study: sanitizeForList(merged) });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/studies"
};
