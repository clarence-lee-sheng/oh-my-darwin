import { existsSync, readFileSync, writeFileSync } from "node:fs";

const dataPath = "data/penguins.csv";
const outputPath = "insights.json";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

function countBy(rows, field) {
  return rows.reduce((acc, row) => {
    const key = row[field];
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function meanBy(rows, groupField, valueField) {
  const groups = new Map();
  for (const row of rows) {
    const raw = row[valueField];
    if (raw === "" || raw === "NA") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const key = row[groupField];
    const cur = groups.get(key) ?? { sum: 0, n: 0 };
    cur.sum += value;
    cur.n += 1;
    groups.set(key, cur);
  }
  return Object.fromEntries([...groups].map(([k, v]) => [k, v.sum / v.n]));
}

function maxKey(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function approx(actual, expected, tolerance = 0.1) {
  return typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
}

function exactObject(actual, expected) {
  return JSON.stringify(sortObj(actual)) === JSON.stringify(sortObj(expected));
}

function sortObj(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

const rows = parseCsv(readFileSync(dataPath, "utf-8"));
const expected = {
  row_count: rows.length,
  species_counts: countBy(rows, "species"),
  island_counts: countBy(rows, "island"),
  most_common_island: maxKey(countBy(rows, "island")),
  year_range: [Math.min(...rows.map((r) => Number(r.year))), Math.max(...rows.map((r) => Number(r.year)))],
  missing_measurement_rows: rows.filter((r) => ["bill_length_mm", "bill_depth_mm", "flipper_length_mm", "body_mass_g"].some((f) => !r[f])).length,
  mean_body_mass_g_by_species: meanBy(rows, "species", "body_mass_g"),
  mean_flipper_length_mm_by_species: meanBy(rows, "species", "flipper_length_mm"),
};
expected.species_with_highest_mean_body_mass = maxKey(expected.mean_body_mass_g_by_species);
expected.species_with_longest_mean_flipper = maxKey(expected.mean_flipper_length_mm_by_species);

let out = {};
if (existsSync(outputPath)) {
  try {
    out = JSON.parse(readFileSync(outputPath, "utf-8"));
  } catch (e) {
    out = { __parse_error: String(e) };
  }
}

const checks = [
  ["row_count", out.row_count === expected.row_count],
  ["species_counts", exactObject(out.species_counts, expected.species_counts)],
  ["island_counts", exactObject(out.island_counts, expected.island_counts)],
  ["most_common_island", out.most_common_island === expected.most_common_island],
  ["year_range", Array.isArray(out.year_range) && out.year_range[0] === expected.year_range[0] && out.year_range[1] === expected.year_range[1]],
  ["missing_measurement_rows", out.missing_measurement_rows === expected.missing_measurement_rows],
  ["species_with_highest_mean_body_mass", out.species_with_highest_mean_body_mass === expected.species_with_highest_mean_body_mass],
  ["species_with_longest_mean_flipper", out.species_with_longest_mean_flipper === expected.species_with_longest_mean_flipper],
  ["mean_body_mass_g_by_species", Object.entries(expected.mean_body_mass_g_by_species).every(([k, v]) => approx(out.mean_body_mass_g_by_species?.[k], v, 0.1))],
  ["executive_summary", typeof out.executive_summary === "string" && out.executive_summary.length >= 80 && out.executive_summary.length <= 600 && ["Adelie", "Chinstrap", "Gentoo"].every((s) => out.executive_summary.includes(s))],
];

const passed = checks.filter(([, ok]) => ok).length;
writeFileSync("score-details.json", JSON.stringify({ score: passed, max_score: checks.length, checks: Object.fromEntries(checks), expected }, null, 2) + "\n");
console.log(`score: ${passed}`);
console.log(`passed: ${passed}/${checks.length}`);
if (passed !== checks.length) {
  console.log("failed checks:", checks.filter(([, ok]) => !ok).map(([name]) => name).join(", "));
}
process.exit(passed === checks.length ? 0 : 1);
