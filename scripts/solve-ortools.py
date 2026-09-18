"""Solve the delivery TSP for one route using OR-Tools with real OSRM road distances.
Uses GUIDED_LOCAL_SEARCH strategy which finds near-optimal solutions for open TSP
(start at library, end at last stop, no return).

usage: python3 solve-ortools.py H21|J3|J13 [--sec 30]
"""
import json, re, sys, urllib.request, urllib.parse, ssl, argparse

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

ap = argparse.ArgumentParser()
ap.add_argument("route")
ap.add_argument("--sec", type=int, default=30)
args = ap.parse_args()

# Subs in data but confirmed absent from latest depot PDF. Kept in data (may re-subscribe)
# but excluded from seed order so they don't distort OR-Tools' route.
EXCLUDE = {
    "H21-003", "H21-008", "H21-025",   # gone since Sept PDF
    "J3-012",  "J3-043",               # gone since Sept PDF
    "J13-036", "J13-062",              # 190 Erb still gone; 191 Royal newly gone
}

with open("../src/data/subscribers.geocoded.json") as f: geo = json.load(f)
with open("../src/data/subscribers.ts") as f: src = f.read()
subs = [(m.group(1), m.group(2)) for m in re.finditer(r'\{ id: "([^"]+)", routeId: "([^"]+)"', src)]
stops = [s for s, r in subs if r == args.route and s not in EXCLUDE]

print(f"{args.route}: {len(stops)} stops (excluded {sum(1 for s, r in subs if r == args.route and s in EXCLUDE)} ghosts)")

# Coord list: library + stops
coords = [(geo["library"]["lng"], geo["library"]["lat"])]
for id_ in stops: coords.append((geo["stops"][id_]["lng"], geo["stops"][id_]["lat"]))

# Fetch OSRM distance matrix
coord_str = ";".join(f"{x:.6f},{y:.6f}" for x, y in coords)
url = f"http://router.project-osrm.org/table/v1/driving/{coord_str}?annotations=distance,duration"
print(f"fetching OSRM table ({len(coords)}x{len(coords)})...")
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
req = urllib.request.Request(url, headers={"User-Agent": "record-routes/0.1"})
data = json.loads(urllib.request.urlopen(req, context=ctx, timeout=60).read())
if data.get("code") != "Ok": sys.exit(f"OSRM error: {data.get('message')}")

# Distances in meters (int for OR-Tools)
n = len(coords)
distance = [[int(round(data["distances"][i][j])) for j in range(n)] for i in range(n)]

# OR-Tools setup: 1 vehicle, open tour (no return to depot)
# We add a virtual "sink" node with zero distance from all real nodes and infinity from depot,
# forcing the vehicle to end at whichever node connects to sink for free.
END_NODE = n
matrix = [row + [0] for row in distance]  # each real row: append 0 (dist to sink)
matrix.append([0 if i > 0 else 10**9 for i in range(n + 1)])  # sink row: 0 from all reals, infinity from depot
matrix[END_NODE][END_NODE] = 0

manager = pywrapcp.RoutingIndexManager(n + 1, 1, [0], [END_NODE])
routing = pywrapcp.RoutingModel(manager)

def dist_cb(a, b):
    return matrix[manager.IndexToNode(a)][manager.IndexToNode(b)]

transit_idx = routing.RegisterTransitCallback(dist_cb)
routing.SetArcCostEvaluatorOfAllVehicles(transit_idx)

params = pywrapcp.DefaultRoutingSearchParameters()
params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
params.time_limit.seconds = args.sec

print(f"solving with GUIDED_LOCAL_SEARCH for {args.sec}s...")
solution = routing.SolveWithParameters(params)
if not solution: sys.exit("no solution")

# Extract tour
tour = []
idx = routing.Start(0)
while not routing.IsEnd(idx):
    node = manager.IndexToNode(idx)
    if node != 0 and node != END_NODE: tour.append(node)
    idx = solution.Value(routing.NextVar(idx))

# Convert node indices to stop IDs
ordered_ids = [stops[i - 1] for i in tour]

# Compute total matrix distance
total = 0
for i in range(len(tour)):
    prev = 0 if i == 0 else tour[i - 1]
    total += distance[prev][tour[i]]
print(f"matrix distance: {total/1000:.2f} km")

with open(f"{args.route.lower()}-ortools.json", "w") as f:
    json.dump({"orderedIds": ordered_ids, "matrixKm": total / 1000}, f, indent=2)
print(f"wrote {args.route.lower()}-ortools.json")
