"""Solve an arbitrary subset of routes as one open TSP from the library.

Reuses the pre-built OSRM matrix (night-matrix.json). No pre-kept prefix —
the solver picks the first stop from the library freely.

Usage: python3 solve-subset.py H21 G7 G11 [--sec 90]
"""
import json, re, sys, argparse
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

ap = argparse.ArgumentParser()
ap.add_argument("routes", nargs="+", help="route IDs, e.g. H21 G7 G11")
ap.add_argument("--sec", type=int, default=90)
args = ap.parse_args()

route_set = set(args.routes)

with open("night-matrix.json") as f: md = json.load(f)
with open("../src/data/subscribers.ts") as f: src = f.read()

matrix_ids = md["ids"]
full_matrix = md["matrix"]
id_to_mi = {s: i for i, s in enumerate(matrix_ids)}

subs = [(m.group(1), m.group(2)) for m in re.finditer(r'\{ id: "([^"]+)", routeId: "([^"]+)"', src)]
stops = [s for s, r in subs if r in route_set]
print(f"routes={sorted(route_set)}, stops={len(stops)}")

# Depot = library (matrix_ids[0]). Open tour: start at library, end anywhere.
n = len(stops) + 1   # +1 for library
distance = [[0] * n for _ in range(n)]
# Row 0 = library
lib_mi = id_to_mi["library"]
for j, s in enumerate(stops):
    d = full_matrix[lib_mi][id_to_mi[s]]
    distance[0][j + 1] = d
    distance[j + 1][0] = full_matrix[id_to_mi[s]][lib_mi]
# Rows 1..n = stops
for i, a in enumerate(stops):
    ma = id_to_mi[a]
    for j, b in enumerate(stops):
        distance[i + 1][j + 1] = full_matrix[ma][id_to_mi[b]]
print(f"sliced matrix: {n}x{n}")

# Open-tour trick: virtual sink reachable free from every real node, infinity from depot.
END = n
matrix = [row + [0] for row in distance]
matrix.append([0 if i > 0 else 10**9 for i in range(n + 1)])
matrix[END][END] = 0

manager = pywrapcp.RoutingIndexManager(n + 1, 1, [0], [END])
routing = pywrapcp.RoutingModel(manager)

def dist_cb(a, b):
    return matrix[manager.IndexToNode(a)][manager.IndexToNode(b)]

transit = routing.RegisterTransitCallback(dist_cb)
routing.SetArcCostEvaluatorOfAllVehicles(transit)
p = pywrapcp.DefaultRoutingSearchParameters()
p.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
p.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
p.time_limit.seconds = args.sec

print(f"solving with GUIDED_LOCAL_SEARCH for {args.sec}s...")
sol = routing.SolveWithParameters(p)
if not sol: sys.exit("no solution")

tour = []
idx = routing.Start(0)
while not routing.IsEnd(idx):
    node = manager.IndexToNode(idx)
    if node != 0 and node != END: tour.append(node)
    idx = sol.Value(routing.NextVar(idx))

ordered = [stops[i - 1] for i in tour]
total = 0
for i in range(len(tour)):
    prev = 0 if i == 0 else tour[i - 1]
    total += distance[prev][tour[i]]
print(f"matrix distance: {total/1000:.2f} km over {len(ordered)} stops")

key = "+".join(sorted(route_set))
with open(f"subset-{key}.json", "w") as f:
    json.dump({"routeSet": sorted(route_set), "orderedIds": ordered, "matrixKm": total / 1000}, f, indent=2)
print(f"wrote subset-{key}.json")
