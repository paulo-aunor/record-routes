// Built-in routes use their short code (H21, J3, ...); imported routes derive theirs from the PDF.
export type RouteId = string;

export interface Route {
  id: RouteId;
  code: string;
  city: string;
  postalPrefix: string;
}

export interface Subscriber {
  id: string;
  name: string;
  address: string;
  postal: string;
  city: string;
  routeId: RouteId;
  lat: number;
  lng: number;
  schedule?: string;
  note?: string;        // delivery note carried from an imported PDF ("Attn: ...")
}

export interface ShiftState {
  date: string;
  routeIds: RouteId[];
  startedAt: number | null;
  finishedAt: number | null;
  deliveredIds: string[];
  skippedIds: string[];
  orderedIds: string[];
  deliveryDayIdx?: number;
  // "gps" once the shift started from a live location or was re-routed from one.
  // Those orders are anchored to wherever Paulo was standing, so Shift done does
  // not save them over the library-anchored order for next time.
  startMode?: "library" | "gps";
}
