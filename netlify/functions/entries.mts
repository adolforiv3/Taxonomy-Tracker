import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import ExcelJS from "exceljs";
import { verifyToken } from "./utils/auth.mts";
import { usersStore } from "./utils/store.mts";

// One row per run (route + protocol + session), not one row per sign
// observed — matches the run-log format the team already reads day to day.
// "Offload Status" is left blank for the team to fill in by hand, same as
// their existing sheet; this app has no notion of physical device offload.
const RUN_LOG_HEADERS = [
  "Date", "Team", "Location State", "Location City", "Route", "Environment", "Protocol",
  "Object Kit", "Calibration Session ID", "Capture Session IDs", "Signs Observed", "Offload Status", "Notes"
];
// "Signs Observed", "Capture Session IDs", and "Notes" routinely hold long
// free text (capture IDs specifically can be a list of 10+ entries, one per
// line) — a width keyed off the header label alone left them narrow enough
// that content visually spilled across neighboring empty cells (looked like
// data landed in the wrong column, though the underlying cells were correct).
const RUN_LOG_COLUMN_WIDTHS: Record<string, number> = { "Signs Observed": 46, "Capture Session IDs": 30, "Notes": 40 };
const RUN_LOG_WRAP_COLUMNS = new Set(["Signs Observed", "Capture Session IDs", "Notes"]);

// Excel treats a solid pattern's fgColor as the visible fill color and
// largely ignores bgColor, but Apple Numbers' xlsx import has the opposite
// bug — it silently drops fills that only set fgColor. Setting both to the
// same color costs nothing in Excel/Sheets and makes the fill actually show
// up in Numbers too.
function solidFill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb }, bgColor: { argb } };
}
const HEADER_FILL: ExcelJS.FillPattern = solidFill("FFEDEDED");
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFE0E0E0" } },
  left: { style: "thin", color: { argb: "FFE0E0E0" } },
  bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
  right: { style: "thin", color: { argb: "FFE0E0E0" } }
};
// A small pastel palette, hashed onto each distinct value so the same
// Environment name always lands on the same color within and across exports
// (rather than reassigning colors run to run based on encounter order).
const COLOR_PALETTE = ["FFE0D6F7", "FFD6E8FA", "FFFCE3C7", "FFD9F2D9", "FFFAD6E4", "FFFFF3C4", "FFD6F5F0", "FFE8E8E8"];
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
}

// Excel sheet names can't contain \ / ? * [ ] : and are capped at 31 chars.
function sheetSafeName(name: string): string {
  return name.replace(/[\\/?*\[\]:]/g, " ").slice(0, 31) || "Team";
}

// Root app (no studyId) keeps its original unprefixed key scheme so existing data
// stays reachable. Studies created via the Study Builder get their own namespace.
function keyPrefix(studyId: string | null): string {
  return studyId && studyId !== "default" ? `${studyId}/` : "";
}

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

// A "run" is every entry sharing a team + calibration session — the same
// grouping admin.html's team accordion already uses to fold individual sign
// observations back into the run they were captured in. Calibration is the
// anchor (always exactly one per run); capture session IDs are a list of
// however many concurrent captures fed into that run, not a grouping key.
function groupIntoRuns(entries: any[]): any[][] {
  const map = new Map<string, any[]>();
  entries.forEach((e) => {
    const key = `${e.teamId}::${e.calibrationSessionId || e.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  });
  return [...map.values()];
}

// An interaction is tagged per sign observation, not per run, so it's folded
// into the label here rather than needing its own export column — "Crosswalk
// (Reading a book) x2" keeps a tagged observation distinguishable from an
// untagged one of the same sign, in the same summary the team already reads.
function summarizeSigns(run: any[]): string {
  const counts = new Map<string, number>();
  run.forEach((e) => {
    const label = e.interaction ? `${e.signType} (${e.interaction})` : e.signType;
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} x${n}` : label)).join(", ");
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = THIN_BORDER;
  });
}

const OFFLOAD_STATUS_OPTIONS = ["Complete", "Pending", "N/A"];

// Excel's inline dropdown-list syntax (`formulae: ['"A,B,C"']`) breaks if any
// option contains a comma and silently truncates past ~255 characters — a
// hidden reference sheet with one option per row sidesteps both. Every
// dropdown column here points at a range on it instead of an inline list.
function addOptionsSheet(workbook: ExcelJS.Workbook, columns: { header: string; values: string[] }[]): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet("Lists", { state: "veryHidden" });
  sheet.columns = columns.map((c) => ({ header: c.header, width: 20 }));
  const maxLen = Math.max(0, ...columns.map((c) => c.values.length));
  for (let i = 0; i < maxLen; i++) {
    sheet.addRow(columns.map((c) => c.values[i] ?? ""));
  }
  return sheet;
}

function dropdownValidation(sheetName: string, colLetter: string, count: number): ExcelJS.DataValidation | undefined {
  if (count === 0) return undefined;
  return { type: "list", allowBlank: true, formulae: [`${sheetName}!$${colLetter}$2:$${colLetter}$${count + 1}`] };
}

async function buildRunLogWorkbook(entries: any[], studyOptions: { environments: string[]; protocols: string[] } | null): Promise<ExcelJS.Buffer> {
  const runs = groupIntoRuns(entries)
    .slice()
    .sort((a, b) => String(a[0].timestamp).localeCompare(String(b[0].timestamp)));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Run Log");
  sheet.columns = RUN_LOG_HEADERS.map((header) => ({
    header,
    width: RUN_LOG_COLUMN_WIDTHS[header] || Math.max(14, header.length + 2)
  }));
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  // The dropdown should offer every value the study actually defines, plus
  // any observed value that isn't (or no longer is) one of them — otherwise
  // an existing entry could show a value the dropdown itself can't reselect.
  const envOptions = new Set(studyOptions?.environments || []);
  const protocolOptions = new Set(studyOptions?.protocols || []);
  runs.forEach((run) => {
    if (run[0].environment) envOptions.add(String(run[0].environment));
    if (run[0].protocol) protocolOptions.add(String(run[0].protocol));
  });

  runs.forEach((run) => {
    const first = run[0];
    const captureIds = Array.isArray(first.captureSessionIds) ? first.captureSessionIds : [];
    const row = sheet.addRow([
      first.date, first.teamId, first.locationState, first.locationCity, first.route, first.environment,
      first.protocol, first.objectKit, first.calibrationSessionId, captureIds.join("\n"),
      summarizeSigns(run), "", first.sessionNotes
    ]);
    row.eachCell((cell, colNumber) => {
      cell.border = THIN_BORDER;
      if (RUN_LOG_WRAP_COLUMNS.has(RUN_LOG_HEADERS[colNumber - 1])) {
        cell.alignment = { wrapText: true, vertical: "top" };
      }
    });
    if (first.environment) {
      row.getCell(6).fill = solidFill(hashColor(String(first.environment)));
    }
  });

  styleHeaderRow(sheet.getRow(1));
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(RUN_LOG_HEADERS.length).letter}1` };

  const envList = [...envOptions];
  const protocolList = [...protocolOptions];
  const listsSheet = addOptionsSheet(workbook, [
    { header: "Environment", values: envList },
    { header: "Protocol", values: protocolList },
    { header: "Offload Status", values: OFFLOAD_STATUS_OPTIONS }
  ]);
  const envValidation = dropdownValidation(listsSheet.name, "A", envList.length);
  const protocolValidation = dropdownValidation(listsSheet.name, "B", protocolList.length);
  const offloadValidation = dropdownValidation(listsSheet.name, "C", OFFLOAD_STATUS_OPTIONS.length);
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (envValidation) sheet.getCell(`F${r}`).dataValidation = envValidation;
    if (protocolValidation) sheet.getCell(`G${r}`).dataValidation = protocolValidation;
    if (offloadValidation) sheet.getCell(`L${r}`).dataValidation = offloadValidation;
  }

  return (await workbook.xlsx.writeBuffer()) as ExcelJS.Buffer;
}

// The companion "how many of each sign type, per day" tally the team keeps
// alongside the run log — one table per team (teams often work different
// days/routes), rows for every taxonomy item the study defines (so an item
// nobody saw all week still shows as a zero, not a missing row), columns for
// each day that team actually logged something, plus a running total. Also
// the source of the Run Log's Environment/Protocol dropdown options.
async function fetchStudyMeta(studyId: string | null): Promise<{ signTypes: string[]; environments: string[]; protocols: string[] } | null> {
  if (!studyId || studyId === "default") return null;
  const studiesStore = getStore({ name: "studies", consistency: "strong" });
  const study = (await studiesStore.get(studyId, { type: "json" })) as any | null;
  if (!study) return null;
  return {
    signTypes: Array.isArray(study.signTypes) ? study.signTypes.map((t: any) => t.name) : [],
    environments: Array.isArray(study.environments) ? study.environments : [],
    protocols: Array.isArray(study.protocols) ? study.protocols : []
  };
}

const TALLY_ROW_FILL: ExcelJS.FillPattern = solidFill("FFE3F5DE");

async function buildTallyWorkbook(entries: any[], canonicalSignTypes: string[] | null): Promise<ExcelJS.Buffer> {
  const byTeam = new Map<string, any[]>();
  entries.forEach((e) => {
    if (!byTeam.has(e.teamId)) byTeam.set(e.teamId, []);
    byTeam.get(e.teamId)!.push(e);
  });

  const workbook = new ExcelJS.Workbook();
  const usedSheetNames = new Set<string>();

  [...byTeam.keys()].sort().forEach((teamId) => {
    const teamEntries = byTeam.get(teamId)!;
    const dates = [...new Set(teamEntries.map((e) => e.date))].sort();

    const signTypeSet = new Set(canonicalSignTypes && canonicalSignTypes.length ? canonicalSignTypes : []);
    const counts = new Map<string, Map<string, number>>();
    teamEntries.forEach((e) => {
      if (!counts.has(e.signType)) counts.set(e.signType, new Map());
      signTypeSet.add(e.signType); // Set lookups keep this O(1) per entry instead of an O(n) Array.includes() scan
      const perDate = counts.get(e.signType)!;
      perDate.set(e.date, (perDate.get(e.date) || 0) + 1);
    });
    const signTypes = [...signTypeSet].sort((a, b) => a.localeCompare(b));

    let sheetName = sheetSafeName(teamId);
    if (usedSheetNames.has(sheetName)) {
      let n = 2;
      while (usedSheetNames.has(`${sheetName} (${n})`)) n++;
      sheetName = `${sheetName} (${n})`;
    }
    usedSheetNames.add(sheetName);

    const sheet = workbook.addWorksheet(sheetName);
    const headers = ["Signs", ...dates, "Total"];
    sheet.columns = headers.map((h, i) => ({ header: h, width: i === 0 ? 26 : 12 }));
    sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

    signTypes.forEach((s) => {
      const perDate = counts.get(s) || new Map<string, number>();
      const dayCounts = dates.map((d) => perDate.get(d) || 0);
      const total = dayCounts.reduce((sum, n) => sum + n, 0);
      const row = sheet.addRow([s, ...dayCounts, total]);
      row.eachCell((cell) => {
        cell.fill = TALLY_ROW_FILL;
        cell.border = THIN_BORDER;
      });
      row.getCell(headers.length).font = { bold: true };
    });

    styleHeaderRow(sheet.getRow(1));
    sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(headers.length).letter}1` };
  });

  if (usedSheetNames.size === 0) workbook.addWorksheet("No Entries");

  return (await workbook.xlsx.writeBuffer()) as ExcelJS.Buffer;
}

// Resolves the requesting lab admin/superadmin from the bearer token, if present.
// A valid token here means "acting with admin oversight" — it's what grants
// cross-team edit access and is the *only* thing that grants delete access.
// Field teams never hold one of these; they authenticate purely by naming
// their team, which is why deletion (a destructive, hard-to-undo action) is
// gated on this instead of on teamId matching.
async function resolveAdmin(req: Request): Promise<{ id: string; role: string } | null> {
  const token = req.headers.get("x-user-token");
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.id) return null;

  const store = usersStore();
  const users = (await store.get("users", { type: "json" }) as any[] | null) || [];
  const user = users.find((u) => u.id === payload.id);
  return user ? { id: user.id, role: user.role } : null;
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "taxonomy-entries", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const studyId = url.searchParams.get("study");
    const prefix = keyPrefix(studyId);
    const week = url.searchParams.get("week") || isoWeek(new Date().toISOString().slice(0, 10));
    const { blobs } = await store.list({ prefix: `${prefix}${week}/` });
    const values = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    const entries = values.filter(Boolean);

    if (url.searchParams.get("format") === "xlsx") {
      const xlsxHeaders = { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
      const studyMeta = await fetchStudyMeta(studyId);
      if (url.searchParams.get("view") === "tally") {
        const buffer = await buildTallyWorkbook(entries, studyMeta ? studyMeta.signTypes : null);
        return new Response(buffer, {
          headers: { ...xlsxHeaders, "content-disposition": `attachment; filename="taxonomy_tally_week_${week}.xlsx"` }
        });
      }
      const buffer = await buildRunLogWorkbook(entries, studyMeta);
      return new Response(buffer, {
        headers: { ...xlsxHeaders, "content-disposition": `attachment; filename="taxonomy_runs_week_${week}.xlsx"` }
      });
    }
    return Response.json({ week, entries });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const items = Array.isArray(body.entries) ? body.entries : [];
    const teamId = body.teamId;

    // Require team ID to submit entries
    if (!teamId) {
      return Response.json({ error: "teamId is required" }, { status: 400 });
    }

    // All entries must be from the same team
    if (items.some((item) => item.teamId !== teamId)) {
      return Response.json({ error: "all entries must be from the same team" }, { status: 400 });
    }

    for (const item of items) {
      const prefix = keyPrefix(item.studyId || null);
      const week = isoWeek(item.date);
      await store.setJSON(`${prefix}${week}/${item.id}`, item);
    }
    return Response.json({ ok: true, count: items.length });
  }

  if (req.method === "PATCH") {
    const body = await req.json();
    const admin = await resolveAdmin(req);
    const teamId = body.teamId;

    // Either an authenticated lab admin/superadmin, or the owning team, may edit.
    if (!admin && !teamId) {
      return Response.json({ error: "teamId is required" }, { status: 400 });
    }

    const prefix = keyPrefix(body.studyId || null);
    const week = body.week || isoWeek(new Date().toISOString().slice(0, 10));
    const key = `${prefix}${week}/${body.id}`;
    const existing = await store.get(key, { type: "json" });
    if (!existing) return new Response("Not found", { status: 404 });

    if (!admin && existing.teamId !== teamId) {
      return Response.json({ error: "you can only edit entries from your team" }, { status: 403 });
    }

    const allowedFields = ["date", "route", "signType", "calibrationSessionId", "captureSessionIds", "sessionNotes", "note"];
    const updates = body.updates || {};
    const merged = { ...existing };
    for (const field of allowedFields) {
      if (field in updates) merged[field] = updates[field];
    }
    merged.editedAt = new Date().toISOString();

    await store.setJSON(key, merged);
    return Response.json({ ok: true, entry: merged });
  }

  if (req.method === "DELETE") {
    // Deletion is destructive and hard to undo, so it's restricted to
    // authenticated lab admins/superadmins only — field teams can edit their
    // own runs (see PATCH above) but can never delete one, by design.
    const admin = await resolveAdmin(req);
    if (!admin) {
      return Response.json({ error: "only lab admins can delete entries" }, { status: 403 });
    }

    const body = await req.json();
    const prefix = keyPrefix(body.studyId || null);
    const week = body.week || isoWeek(new Date().toISOString().slice(0, 10));
    const key = `${prefix}${week}/${body.id}`;

    await store.delete(key);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/entries"
};
