import fs from "fs/promises";

const currentSrc = await fs.readFile("../src/data/subscribers.ts", "utf8");
const h21Lines = currentSrc.split("\n").filter((l) => l.includes('routeId: "H21"'));
console.log(`preserving ${h21Lines.length} H21 rows`);

const parsed = JSON.parse(await fs.readFile("parsed-subs.json", "utf8"));
const j3 = parsed.routes.J3 ?? [];
const j13 = parsed.routes.J13 ?? [];

function fmt(s) {
  const sched = s.schedule ? `, schedule: "${s.schedule}"` : "";
  return `  { id: "${s.id}", routeId: "${s.routeId}", name: ${JSON.stringify(s.name)}, address: ${JSON.stringify(s.address)}, postal: "${s.postal}", city: "${s.city}"${sched} },`;
}

const body = [
  `import type { Subscriber, RouteId } from "@/types";`,
  `import geo from "./subscribers.geocoded.json";`,
  ``,
  `type RawSubscriber = Omit<Subscriber, "lat" | "lng">;`,
  ``,
  `const RAW: RawSubscriber[] = [`,
  ...h21Lines,
  ...j3.map(fmt),
  ...j13.map(fmt),
  `];`,
  ``,
  `const coords = geo.stops as Record<string, { lat: number; lng: number } | null>;`,
  ``,
  `export const SUBSCRIBERS: Subscriber[] = RAW.map((r) => {`,
  `  const c = coords[r.id];`,
  `  if (!c) throw new Error(\`missing geocoded coords for \${r.id} — rerun scripts/geocode.mjs\`);`,
  `  return { ...r, routeId: r.routeId as RouteId, lat: c.lat, lng: c.lng };`,
  `});`,
  ``,
  `export function subscribersForRoutes(routeIds: readonly string[]): Subscriber[] {`,
  `  return SUBSCRIBERS.filter((s) => routeIds.includes(s.routeId));`,
  `}`,
  ``,
  `export function countByRoute(): Record<string, number> {`,
  `  const counts: Record<string, number> = {};`,
  `  for (const s of SUBSCRIBERS) {`,
  `    counts[s.routeId] = (counts[s.routeId] ?? 0) + 1;`,
  `  }`,
  `  return counts;`,
  `}`,
  ``,
].join("\n");

await fs.writeFile("../src/data/subscribers.ts", body);
console.log(`wrote ${h21Lines.length + j3.length + j13.length} total subs (H21:${h21Lines.length}, J3:${j3.length}, J13:${j13.length})`);
