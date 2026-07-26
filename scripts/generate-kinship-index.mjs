#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const requireFromScript = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    input: path.join(projectRoot, "data", "giapha-converted.json"),
    out: path.join(projectRoot, "data", "kinship-index.csv"),
    format: "csv",
    includeUnresolved: true,
    summaryOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input" && next) {
      args.input = path.resolve(projectRoot, next);
      index += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(projectRoot, next);
      index += 1;
    } else if (arg === "--format" && next) {
      args.format = next;
      index += 1;
    } else if (arg === "--resolved-only") {
      args.includeUnresolved = false;
    } else if (arg === "--summary-only") {
      args.summaryOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!["csv", "json"].includes(args.format)) {
    throw new Error("--format chi nhan csv hoac json");
  }

  if (!args.out.endsWith(`.${args.format}`)) {
    args.out = args.out.replace(/\.[^.]+$/, "") + `.${args.format}`;
  }

  return args;
}

function printHelp() {
  console.log(`
Usage: npm run kinship:generate -- [options]

Options:
  --input <file>       File JSON dau vao. Mac dinh: data/giapha-converted.json
  --out <file>         File ket qua. Mac dinh: data/kinship-index.csv
  --format csv|json    Dinh dang xuat. Mac dinh: csv
  --resolved-only      Chi xuat cac cap da xac dinh duoc danh xung
  --summary-only       Chi chay thong ke, khong ghi file ket qua
`);
}

function loadKinshipModule() {
  const filename = path.join(projectRoot, "utils", "kinshipHelpers.ts");
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filename,
  }).outputText;

  const moduleRef = { exports: {} };
  const localRequire = (request) => {
    if (request.startsWith("@/")) {
      return requireFromScript(path.join(projectRoot, request.slice(2)));
    }
    return requireFromScript(request);
  };

  const runner = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    compiled,
  );
  runner(moduleRef.exports, localRequire, moduleRef, filename, path.dirname(filename));

  return moduleRef.exports;
}

function normalizeStatus(result) {
  return result && result.aCallsB !== "Chưa xác định" ? "resolved" : "unresolved";
}

function getCategory(result) {
  if (!result || result.aCallsB === "Chưa xác định") return "Không xác định";
  const description = result.description.split(" (")[0].split(" - ")[0];

  if (description.startsWith("Thông qua hôn nhân của cả")) {
    return "Thông qua hôn nhân của cả hai bên";
  }
  if (description.startsWith("Thông qua hôn nhân của")) {
    return "Thông qua hôn nhân một bên";
  }
  if (description.startsWith("Họ hàng")) return "Họ hàng";
  if (description.startsWith("Anh em họ")) return "Anh em họ";
  if (description.startsWith("Bên Nội") || description.startsWith("Bên Ngoại")) {
    return "Họ hàng vế trên";
  }
  if (description.startsWith("Quan hệ đồng")) {
    return "Đồng phối ngẫu";
  }

  return description;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows) {
  const headers = [
    "person_a_id",
    "person_a_name",
    "person_b_id",
    "person_b_name",
    "a_calls_b",
    "b_calls_a",
    "status",
    "category",
    "distance",
    "description",
    "path",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsv(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const persons = input.persons ?? [];
  const relationships = input.relationships ?? [];
  const { computeKinship } = loadKinshipModule();

  const rows = [];
  const categories = new Map();
  const startedAt = performance.now();
  let totalPairs = 0;
  let resolved = 0;
  let unresolved = 0;

  for (let i = 0; i < persons.length; i += 1) {
    for (let j = i + 1; j < persons.length; j += 1) {
      totalPairs += 1;
      const personA = persons[i];
      const personB = persons[j];
      const result = computeKinship(personA, personB, persons, relationships);
      const status = normalizeStatus(result);
      const category = getCategory(result);

      categories.set(category, (categories.get(category) ?? 0) + 1);
      if (status === "resolved") resolved += 1;
      else unresolved += 1;

      if (args.summaryOnly || (status === "unresolved" && !args.includeUnresolved)) {
        continue;
      }

      rows.push({
        person_a_id: personA.id,
        person_a_name: personA.full_name,
        person_b_id: personB.id,
        person_b_name: personB.full_name,
        a_calls_b: result?.aCallsB ?? "Chưa xác định",
        b_calls_a: result?.bCallsA ?? "Chưa xác định",
        status,
        category,
        distance: result?.distance ?? -1,
        description: result?.description ?? "Không tìm thấy quan hệ trong phạm vi dữ liệu",
        path: (result?.pathLabels ?? []).join(" | "),
      });
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const summary = {
    persons: persons.length,
    sourceRelationships: relationships.length,
    unorderedPairs: totalPairs,
    exportedRows: rows.length,
    resolved,
    unresolved,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    pairsPerSecond: Number((totalPairs / (elapsedMs / 1000)).toFixed(2)),
    categories: Object.fromEntries(
      [...categories.entries()].sort((a, b) => b[1] - a[1]),
    ),
  };

  if (!args.summaryOnly) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    const content =
      args.format === "json"
        ? `${JSON.stringify({ summary, rows }, null, 2)}\n`
        : toCsv(rows);
    fs.writeFileSync(args.out, content, "utf8");
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!args.summaryOnly) {
    console.log(`Da ghi: ${path.relative(projectRoot, args.out)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
