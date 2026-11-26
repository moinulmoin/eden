// Prints Eden's usage numbers from the eden_telemetry Analytics Engine
// dataset, through the cf login: pnpm --dir telemetry run stats
import { spawnSync } from "node:child_process";

const days = 7;
const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;

const reports = [
  {
    title: `Active installs, last ${days} days`,
    sql: `SELECT count(DISTINCT blob1) AS installs, SUM(_sample_interval) AS events FROM eden_telemetry WHERE ${since}`,
  },
  {
    title: `Commands by outcome, last ${days} days`,
    sql: `SELECT blob2 AS command, if(blob4 = '', 'ok', blob4) AS outcome, SUM(_sample_interval) AS events, count(DISTINCT blob1) AS installs FROM eden_telemetry WHERE ${since} GROUP BY command, outcome ORDER BY events DESC`,
  },
  {
    title: `Eden versions, last ${days} days`,
    sql: `SELECT blob3 AS eden, count(DISTINCT blob1) AS installs, SUM(_sample_interval) AS events FROM eden_telemetry WHERE ${since} GROUP BY eden ORDER BY installs DESC`,
  },
  {
    title: `Eve versions and Worlds, last ${days} days`,
    sql: `SELECT if(blob8 = '', 'unknown', blob8) AS eve, if(blob9 = '', 'unknown', blob9) AS world, count(DISTINCT blob1) AS installs FROM eden_telemetry WHERE ${since} GROUP BY eve, world ORDER BY installs DESC`,
  },
  {
    title: `Platforms, last ${days} days`,
    sql: `SELECT blob6 AS os, blob7 AS arch, double2 AS node, blob10 AS ci, count(DISTINCT blob1) AS installs FROM eden_telemetry WHERE ${since} GROUP BY os, arch, node, ci ORDER BY installs DESC`,
  },
];

function table(rows) {
  if (rows.length === 0) return "  (no events)";
  const columns = Object.keys(rows[0]);
  const cells = [columns, ...rows.map((row) => columns.map((column) => String(row[column])))];
  const widths = columns.map((_, index) => Math.max(...cells.map((line) => line[index].length)));
  return cells.map((line) => "  " + line.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()).join("\n");
}

for (const report of reports) {
  const result = spawnSync("cf", ["analytics-engine", "sql", "query", "--body", `${report.sql} FORMAT JSON`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    console.error(`cf analytics-engine sql query failed for "${report.title}". Run cf auth whoami to check the login, then retry.`);
    process.exit(1);
  }
  const { data = [] } = JSON.parse(result.stdout);
  console.log(`${report.title}\n${table(data)}\n`);
}
