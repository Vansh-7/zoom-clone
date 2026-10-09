import fs from "node:fs/promises";
import path from "node:path";

const api = process.env.E2E_API_URL;
if (!api) throw new Error("Set E2E_API_URL explicitly.");
const directory = path.resolve("../artifacts/release");
const before = JSON.parse(
  await fs.readFile(path.join(directory, "persistence-before.json"), "utf8"),
);
if (!/^\d{11}$/.test(before.meeting_code))
  throw new Error("Invalid meeting code in persistence snapshot.");
const response = await fetch(`${api}/api/meetings/${before.meeting_code}`);
if (!response.ok)
  throw new Error(`Meeting retrieval failed: ${response.status}`);
const after = await response.json();
const changed = Object.keys(before).filter(
  (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
);
if (changed.length)
  throw new Error(
    `Meeting fields changed across restart: ${changed.join(", ")}`,
  );
await fs.writeFile(
  path.join(directory, "persistence-after.json"),
  JSON.stringify(after, null, 2),
);
console.log("Scheduled meeting retained every field across backend restart.");
