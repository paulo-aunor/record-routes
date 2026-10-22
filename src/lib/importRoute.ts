import { anchorIdsFor } from "@/data/anchors";
import type { Subscriber } from "@/types";
import { matrixIdFor } from "./matrixAlias";
import { optimize, type Coord } from "./optimizer-v2";
import { deriveRouteId, type ParsedRoute, type ParsedSub } from "./pdfRouteList";
import type { ImportedRoute } from "./registry-core";

// Imported houses get an id built from the address, not from their position in
// the PDF, so a house stopped or noted today is the same house after next
// month's re-import.
export function subscriberId(routeId: string, address: string, taken: Set<string>): string {
  const slug = address.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `${routeId}~${slug}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? "";
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

export const addressNoteKey = (address: string) => address.replace(/\s+/g, " ").trim().toUpperCase();

// Notes are joined with " · ". A re-import carries the old combined note and the
// PDF supplies its own again, so compare segment by segment or they'd stack up.
function joinNotes(...parts: (string | undefined)[]): { note?: string } {
  const segments = parts.flatMap((x) => (x ? x.split(" · ") : [])).map((x) => x.trim()).filter(Boolean);
  const unique = [...new Set(segments)];
  return unique.length > 0 ? { note: unique.join(" · ") } : {};
}

export type BuiltRoute = {
  imported: Omit<ImportedRoute, "rev">;
  unplaced: ParsedSub[];      // rows whose address couldn't be located; left out of the route
  seedKm: number;             // length of the library-start order
  estimatedStops: number;     // stops whose distances are straight-line estimates
};

export function buildImportedRoute(
  parsed: ParsedRoute,
  coords: readonly (Coord | null)[],
  now: number,
  carry: ReadonlyMap<string, string> = new Map(),
): BuiltRoute {
  if (coords.length !== parsed.subs.length) throw new Error("importRoute: coordinates don't line up with the stops.");
  const id = deriveRouteId(parsed.code);
  const taken = new Set<string>();
  const subs: Subscriber[] = [];
  const unplaced: ParsedSub[] = [];

  parsed.subs.forEach((p, i) => {
    const c = coords[i];
    if (!c) { unplaced.push(p); return; }
    subs.push({
      id: subscriberId(id, p.address, taken),
      name: p.name,
      address: p.address,
      postal: p.postal,
      city: p.city,
      routeId: id,
      lat: c.lat,
      lng: c.lng,
      schedule: p.schedule,
      ...joinNotes(p.note, carry.get(addressNoteKey(p.address))),
    });
  });
  if (subs.length === 0) throw new Error(`None of the ${parsed.subs.length} addresses on ${parsed.code} could be located.`);

  const byId = new Map(subs.map((s) => [s.id, { lat: s.lat, lng: s.lng }]));
  const addressOf = new Map(subs.map((s) => [s.id, matrixIdFor(s.address, s.city)]));
  const solved = optimize({
    stopIds: subs.map((s) => s.id),
    coordOf: (x) => byId.get(x),
    matrixIdOf: (x) => addressOf.get(x),
    preKeep: anchorIdsFor([id], subs),
    timeBudgetMs: 4000,
  });

  return {
    imported: {
      route: {
        id,
        code: parsed.code,
        city: mostCommon(subs.map((s) => s.city)),
        postalPrefix: mostCommon(subs.map((s) => s.postal.slice(0, 3))),
      },
      importedAt: now,
      subs,
      seed: solved.orderedIds,
    },
    unplaced,
    seedKm: solved.distanceM / 1000,
    estimatedStops: solved.estimatedStops,
  };
}
