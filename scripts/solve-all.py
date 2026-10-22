"""Solve the whole night as ONE open TSP across all 5 routes.

Start: Waterloo Public Library.
Pre-keep: first 9 stops of J13 as Paulo delivers them.
Solve: all other eligible stops across H21/J3/J13/G7/G11 in optimal order,
treating them as one bag of ~297 stops regardless of routeId.
Finish: anywhere (open tour).
"""
import json, re, sys, argparse

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

ap = argparse.ArgumentParser()
ap.add_argument("--sec", type=int, default=60)
args = ap.parse_args()

# No subs are excluded from the solve; every house ships in the seed. Paulo
# toggles individual houses on/off via the app's per-house Stop setting.
EXCLUDE: set[str] = set()

# Pre-keep: first 9 houses of J13 that Paulo delivers before anything else.
PRE_KEEP = [
    "J13-020",  # 14 Devitt Ave N
    "J13-023",  # 53 Dover St
    "J13-022",  # 47 Dover St
    "J13-034",  # 163 Erb St E
    "J13-035",  # 182 Erb St E
    "J13-037",  # 198 Erb St E
    "J13-038",  # 208 Erb St E Apt A
    "J13-039",  # 218 Erb St E
    "J13-040",  # 238 Erb St E (FriSat)
]

# Load pre-built OSRM driving-distance matrix (340x340 via build-osrm-matrix.py)
with open("night-matrix.json") as f:
    mdata = json.load(f)
matrix_ids = mdata["ids"]         # ["library", "H21-001", ...] in matrix row/col order
full_matrix = mdata["matrix"]
id_to_mi = {s: i for i, s in enumerate(matrix_ids)}

with open("../src/data/subscribers.ts") as f:
    src = f.read()

subs = [(m.group(1), m.group(2))
        for m in re.finditer(r'\{ id: "([^"]+)", routeId: "([^"]+)"', src)]
all_ids = [s for s, _ in subs if s not in EXCLUDE and s not in set(PRE_KEEP)]

print(f"total: {len(subs)} subs")
print(f"ghosts excluded: {sum(1 for s, _ in subs if s in EXCLUDE)}")
print(f"pre-kept (fixed prefix): {len(PRE_KEEP)}")
print(f"to solve: {len(all_ids)} stops")

# OR-Tools starts at the LAST pre-kept stop; the matrix depot = J13-040.
start_id = PRE_KEEP[-1]
sub_ids_for_solver = [start_id] + all_ids

# Slice the pre-built OSRM matrix down to just the stops we're solving over.
n = len(sub_ids_for_solver)
distance = [[0] * n for _ in range(n)]
for i, a in enumerate(sub_ids_for_solver):
    mi = id_to_mi[a]
    for j, b in enumerate(sub_ids_for_solver):
        distance[i][j] = full_matrix[mi][id_to_mi[b]]
print(f"sliced OSRM matrix: {n}x{n}")

END_NODE = n
matrix = [row + [0] for row in distance]
matrix.append([0 if i > 0 else 10**9 for i in range(n + 1)])
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
if not solution:
    sys.exit("no solution")

tour = []
idx = routing.Start(0)
while not routing.IsEnd(idx):
    node = manager.IndexToNode(idx)
    if node != 0 and node != END_NODE:
        tour.append(node)
    idx = solution.Value(routing.NextVar(idx))

solved_order = [all_ids[i - 1] for i in tour]
ordered_ids = PRE_KEEP + solved_order

total = 0
for i in range(len(tour)):
    prev = 0 if i == 0 else tour[i - 1]
    total += distance[prev][tour[i]]
print(f"matrix distance (after pre-kept): {total/1000:.2f} km over {len(all_ids)} stops")

with open("night-ortools.json", "w") as f:
    json.dump({"orderedIds": ordered_ids, "matrixKmPostKept": total / 1000}, f, indent=2)
print(f"wrote night-ortools.json ({len(ordered_ids)} stops total)")
