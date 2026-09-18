export type RouteId = "H21" | "J3" | "J13";

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
}
