import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CSV_COLUMNS = [
  "date", "timestamp", "team_id", "protocol", "environment", "object_kit",
  "route", "calibration_session_id", "capture_session_id", "sign_type", "note", "session_notes"
];

function isoWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const week = 1 + Math.ceil((firstThursday - target.valueOf()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(entries: any[]): string {
  const rows = entries
    .slice()
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .map((e) => [
      e.date, e.timestamp, e.teamId, e.protocol, e.environment, e.objectKit,
      e.route, e.calibrationSessionId, e.captureSessionId, e.signType, e.note, e.sessionNotes
    ].map(csvEscape).join(","));
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "taxonomy-entries", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const week = url.searchParams.get("week") || isoWeek(new Date().toISOString().slice(0, 10));
    const { blobs } = await store.list({ prefix: `${week}/` });
    const values = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    const entries = values.filter(Boolean);

    if (url.searchParams.get("format") === "csv") {
      return new Response(toCsv(entries), {
        headers: {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="taxonomy_week_${week}.csv"`
        }
      });
    }
    return Response.json({ week, entries });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const items = Array.isArray(body.entries) ? body.entries : [];
    for (const item of items) {
      const week = isoWeek(item.date);
      await store.setJSON(`${week}/${item.id}`, item);
    }
    return Response.json({ ok: true, count: items.length });
  }

  if (req.method === "DELETE") {
    const body = await req.json();
    const week = body.week || isoWeek(new Date().toISOString().slice(0, 10));
    await store.delete(`${week}/${body.id}`);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/entries"
};
