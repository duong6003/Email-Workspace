"""Validate run state against .agents/schemas/run-state.schema.json (no external deps)
and cross-check ExecPlan / graph / inventory / traceability consistency."""
import json, re, sys
from pathlib import Path

# Derived from this file's own location, not hard-coded: the repository is also
# checked out as git worktrees under .claude/worktrees/, and an absolute ROOT made
# the validator silently grade a *different* checkout than the one it was run from.
RUN = Path(__file__).resolve().parent
ROOT = RUN.parents[2]

errors, warnings = [], []


def err(m): errors.append(m)
def warn(m): warnings.append(m)


schema = json.loads((ROOT / ".agents/schemas/run-state.schema.json").read_text(encoding="utf-8"))
state = json.loads((RUN / "state.json").read_text(encoding="utf-8"))

# ---- schema validation (subset the schema actually uses) -------------------
def check_obj(inst, sch, path, defs):
    if "$ref" in sch:
        return check_obj(inst, defs[sch["$ref"].split("/")[-1]], path, defs)
    t = sch.get("type")
    if t == "object" or "properties" in sch:
        if not isinstance(inst, dict):
            err(f"{path}: expected object, got {type(inst).__name__}"); return
        for r in sch.get("required", []):
            if r not in inst:
                err(f"{path}: missing required property '{r}'")
        if sch.get("additionalProperties") is False:
            for k in inst:
                if k not in sch.get("properties", {}):
                    err(f"{path}: additional property '{k}' not allowed")
        for k, v in inst.items():
            if k in sch.get("properties", {}):
                check_obj(v, sch["properties"][k], f"{path}.{k}", defs)
    elif t == "array":
        if not isinstance(inst, list):
            err(f"{path}: expected array"); return
        if len(inst) < sch.get("minItems", 0):
            err(f"{path}: minItems {sch['minItems']} violated")
        for i, v in enumerate(inst):
            if "items" in sch:
                check_obj(v, sch["items"], f"{path}[{i}]", defs)
    else:
        if "enum" in sch and inst not in sch["enum"]:
            err(f"{path}: '{inst}' not in enum {sch['enum']}")
        if "anyOf" in sch:
            if not any(_try(inst, s, defs) for s in sch["anyOf"]):
                err(f"{path}: matched no anyOf branch")
            return
        if t == "string":
            if not isinstance(inst, str):
                err(f"{path}: expected string"); return
            if len(inst) < sch.get("minLength", 0):
                err(f"{path}: minLength violated")
            if sch.get("format") == "date-time" and not re.match(
                    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$", inst):
                err(f"{path}: not a valid date-time: {inst}")
        elif t == "integer":
            if not isinstance(inst, int) or isinstance(inst, bool):
                err(f"{path}: expected integer"); return
            if "minimum" in sch and inst < sch["minimum"]:
                err(f"{path}: minimum {sch['minimum']} violated")
        elif isinstance(t, list):
            ok = ("null" in t and inst is None) or ("string" in t and isinstance(inst, str))
            if not ok:
                err(f"{path}: type {t} violated by {inst!r}")


def _try(inst, sch, defs):
    global errors
    saved = list(errors); errors = []
    check_obj(inst, sch, "tmp", defs)
    ok = not errors
    errors = saved
    return ok


check_obj(state, schema, "state", schema.get("$defs", {}))
print("SCHEMA:", "PASS" if not errors else f"FAIL ({len(errors)})")
for e in errors:
    print("   ", e)

# ---- graph consistency -----------------------------------------------------
nodes = {n["id"]: n for n in state["nodes"]}
print(f"\nGRAPH: {len(nodes)} nodes")

for n in state["nodes"]:
    for d in n["dependsOn"]:
        if d not in nodes:
            err(f"node {n['id']}: dependsOn unknown node '{d}'")

# cycle detection
colour = {}
def visit(i, stack):
    if colour.get(i) == 2:
        return
    if colour.get(i) == 1:
        err(f"cycle: {' -> '.join(stack + [i])}"); return
    colour[i] = 1
    for d in nodes[i]["dependsOn"]:
        if d in nodes:
            visit(d, stack + [i])
    colour[i] = 2
for i in nodes:
    visit(i, [])

# every code node has verification
CODE = [i for i in nodes if i.startswith("M") and "-S" in i] + ["arch_contracts"]
for i in CODE:
    sc = " ".join(nodes[i]["successConditions"]).lower()
    if not any(k in sc for k in ("test", "pass", "verif", "evidence", "closed", "exits 0")):
        err(f"code node {i} has no verification in successConditions")

# every milestone has a gate; gate depends on all its slices
for m in range(1, 8):
    gate = f"M{m}-GATE"
    if gate not in nodes:
        err(f"missing {gate}"); continue
    slices = [i for i in nodes if i.startswith(f"M{m}-S")]
    missing = [s for s in slices if s not in nodes[gate]["dependsOn"]]
    if missing:
        err(f"{gate} does not join: {missing}")

# terminal node reachable from every node
def reaches(a, b, seen=None):
    seen = seen or set()
    if a == b: return True
    if a in seen: return False
    seen.add(a)
    return any(reaches(p, b, seen) for p in nodes if a in nodes[p]["dependsOn"])
for i in nodes:
    if i != "completion_gate" and not reaches(i, "completion_gate"):
        warn(f"node {i} does not reach completion_gate")

# critical path
memo = {}
def depth(i):
    if i in memo: return memo[i]
    memo[i] = 1 + max([depth(d) for d in nodes[i]["dependsOn"] if d in nodes] + [0])
    return memo[i]
cp_end = max(nodes, key=depth)
path, cur = [], cp_end
while cur:
    path.append(cur)
    deps = [d for d in nodes[cur]["dependsOn"] if d in nodes]
    cur = max(deps, key=depth) if deps else None
path.reverse()
print(f"   critical path length: {len(path)}")
print("   " + " -> ".join(path))

# ---- traceability arithmetic ----------------------------------------------
rules = json.loads((ROOT / "catalog/ba-rules.json").read_text(encoding="utf-8"))
tests = json.loads((ROOT / "catalog/test-cases.json").read_text(encoding="utf-8"))
notif = json.loads((ROOT / "catalog/notification-rules.json").read_text(encoding="utf-8"))
tp = (RUN / "traceability-plan.yaml").read_text(encoding="utf-8")

allocated = set(re.findall(r"BR-[A-Z]+-\d{3}", tp.split("coverage_check:")[0]))
ba_ids = {r["id"] for r in rules}
not_ids = {r["id"] for r in notif}
print(f"\nTRACEABILITY:")
print(f"   ba-rules.json: {len(ba_ids)}  notification-rules.json: {len(not_ids)}  test-cases.json: {len(tests)}")
missing_rules = sorted((ba_ids | not_ids) - allocated)
if missing_rules:
    err(f"rules not allocated in traceability-plan.yaml: {missing_rules}")
else:
    print(f"   all {len(ba_ids | not_ids)} rules allocated")
bogus = sorted(allocated - ba_ids - not_ids)
if bogus:
    err(f"traceability-plan.yaml references non-existent rule IDs: {bogus}")

# declared test counts must sum to 159
declared = [int(m) for m in re.findall(r"test_count_expected:\s*(\d+)", tp)]
print(f"   declared per-milestone test counts {declared} sum={sum(declared)} (catalog={len(tests)})")
if sum(declared) != len(tests):
    err(f"test_count_expected sums to {sum(declared)}, catalog has {len(tests)}")

# test prefix counts vs claims
from collections import Counter
pref = Counter(t["id"].split("-")[1] for t in tests)
print(f"   test prefixes: {dict(sorted(pref.items()))}")

# ---- traceability.csv structure --------------------------------------------
# Added after a real M4-S1 incident: a checkpoint-6 commit (90ab4b3) closed
# BR-CMP-001/011/012 with every value shifted one column past the empty
# code_paths cell, landing 'closed' in an illegal 15th column instead of
# status -- so status actually read '' for all three, invisible to every
# check that existed at the time because nothing parsed this file as CSV.
# A later rewrite on top of that also collapsed the whole file to one line
# (literal '\n' instead of real newlines). Neither defect was structural
# noise -- both were caught by hand, so both classes are checked here now,
# the same "extend the safety net, not just the instance" response as the
# screen-catalog.yaml checks above (D-38/D-39).
import csv as _csv
tc_path = RUN / "traceability.csv"
tc_rows = list(_csv.reader(tc_path.open(encoding="utf-8", newline="")))
if not tc_rows:
    err("traceability.csv is empty")
else:
    tc_header = tc_rows[0]
    tc_data = tc_rows[1:]
    print(f"\nTRACEABILITY.CSV: {len(tc_data)} data rows, {len(tc_header)} columns")
    bad_width = [(i + 2, r[0] if r else "<empty>", len(r)) for i, r in enumerate(tc_data) if len(r) != len(tc_header)]
    if bad_width:
        err(f"traceability.csv rows with wrong column count (line, rule_id, actual_cols): {bad_width}")
    else:
        status_col = tc_header.index("status")
        code_paths_col = tc_header.index("code_paths")
        test_files_col = tc_header.index("test_files")
        blank_status = [r[0] for r in tc_data if not r[status_col].strip()]
        if blank_status:
            err(f"traceability.csv rows with a blank status (a shifted/corrupted row reads this way, not a legitimate value): {blank_status}")
        test_cases_col = tc_header.index("test_case_ids")
        log_col = tc_header.index("log_or_metric_or_audit")
        milestone_col = tc_header.index("milestone")
        # Strengthened at M6-GATE. The original rule fired only when BOTH
        # code_paths and test_files were blank, so a row could carry code and
        # tests while silently declaring no log/metric/audit and no test case
        # id at all -- which is how 15 of 16 BR-NOT-* rows reached `closed`
        # with an empty log_or_metric_or_audit cell, invisible to every check
        # that existed. AGENTS.md §6 makes logs/metrics/audit part of Definition
        # of Done, so a closed row that genuinely has no such dimension must say
        # so in words ("none: <reason>"), not leave the cell blank. Uses the
        # same substring match ("closed" in status) as the original check, so
        # partially_closed rows are covered too -- consistent with every
        # partially_closed row observed already carrying full evidence.
        #
        # Errors only for the milestone the currently-running gate owns (M6 as
        # of M6-GATE); running this same check against the whole file surfaced
        # 34 more blank cells across M1-M5, already-closed at earlier gates --
        # a real finding (D-133) but a five-milestone re-audit, not this node's
        # own rule ownership. Those stay a warning so they are never silently
        # hidden, without blocking a gate that does not own them. A future
        # gate raises OWNED_MILESTONES to cover its own rows as they close.
        OWNED_MILESTONES = {"M6"}
        for col_name, col_idx in (
            ("code_paths", code_paths_col),
            ("test_files", test_files_col),
            ("test_case_ids", test_cases_col),
            ("log_or_metric_or_audit", log_col),
        ):
            blank_rows = [r for r in tc_data if "closed" in r[status_col] and not r[col_idx].strip()]
            owned = [r[0] for r in blank_rows if r[milestone_col].strip() in OWNED_MILESTONES]
            unowned = [(r[0], r[milestone_col].strip()) for r in blank_rows if r[milestone_col].strip() not in OWNED_MILESTONES]
            if owned:
                err(f"traceability.csv rows marked closed with a blank {col_name} (owned milestone): {owned}")
            if unowned:
                warn(f"traceability.csv rows marked closed with a blank {col_name} (un-owned milestone, disclosed not fixed -- rule_id, milestone): {unowned}")
        missing_tests = []
        for r in tc_data:
            for rel in (p.strip() for p in r[test_files_col].split(";")):
                if rel and not (ROOT / rel).exists():
                    missing_tests.append((r[0], rel))
        if missing_tests:
            err(f"traceability.csv references test files that do not exist (rule_id, path): {missing_tests}")

# ---- ui inventory <-> execplan --------------------------------------------
ui = (RUN / "ui-inventory.yaml").read_text(encoding="utf-8")
plan = (RUN / "EXECPLAN.md").read_text(encoding="utf-8")
screens = re.findall(r"^\s{2}- id: (UI-[A-Z]+-\d{3})", ui, re.M)
print(f"\nUI: {len(screens)} screens {screens}")
overlay_block = ui.split("catalog:")[1].split("# ---")[0]
overlays = re.findall(r"\{id: (\w+),", overlay_block)
print(f"   {len(overlays)} overlays catalogued")
src = (ROOT / "design-reference/ui-handoff-v2/source/app/action-overlays.tsx").read_text(encoding="utf-8")
decl = re.search(r"export type OverlayType =(.*?);", src, re.S).group(1)
truth = set(re.findall(r'"(\w+)"', decl))
print(f"   OverlayType union in source: {len(truth)}")
if set(overlays) != truth:
    err(f"overlay catalogue mismatch: missing {sorted(truth - set(overlays))}, extra {sorted(set(overlays) - truth)}")

for s in screens:
    if s not in (plan + tp):
        warn(f"screen {s} appears in ui-inventory but not in EXECPLAN/traceability-plan")

# ---- screen catalogue ------------------------------------------------------
# Added in M4-S1 after screen-catalog.yaml was found to have stopped parsing as
# YAML at some point during M3 (an unescaped apostrophe closed a single-quoted
# scalar early) while every gate kept passing: nothing in this validator, and
# nothing in packages/architecture-tests, ever parsed the file. A catalogue that
# only humans read is a catalogue that drifts, so it is machine-checked now.
KNOWN_SCREEN_STATUS = {"not_inventoried", "not_started", "in_progress", "partially_migrated", "migrated"}
try:
    import yaml
except ImportError:
    warn("PyYAML not installed: screen-catalog.yaml was not machine-parsed")
else:
    try:
        catalog = yaml.safe_load((RUN / "screen-catalog.yaml").read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        err(f"screen-catalog.yaml does not parse as YAML: {exc}")
        catalog = None
    if catalog is not None:
        cat_screens = catalog.get("screens") or []
        print(f"   screen-catalog.yaml parses: {len(cat_screens)} screen entries, "
              f"{len(catalog.get('overlays') or [])} overlay entries")
        for entry in cat_screens:
            sid = entry.get("id", "<no id>")
            for key in ("id", "name", "route", "status"):
                if not entry.get(key):
                    err(f"screen-catalog.yaml {sid}: missing '{key}'")
            if entry.get("status") not in KNOWN_SCREEN_STATUS:
                err(f"screen-catalog.yaml {sid}: unknown status {entry.get('status')!r}")
        cat_ids = [entry.get("id") for entry in cat_screens]
        dupes = sorted({i for i in cat_ids if cat_ids.count(i) > 1})
        if dupes:
            err(f"screen-catalog.yaml has duplicate screen ids: {dupes}")
        # A catalogue entry with no ui-inventory counterpart is legitimate -- some
        # destinations (e.g. UI-CF-001 /settings/custom-fields) have no handoff screen
        # at all and are production-only additions. It must say so, though: claiming
        # handoff provenance for a screen the handoff inventory never listed is the
        # drift worth catching.
        production_only = sorted(set(cat_ids) - set(screens))
        for entry in cat_screens:
            if entry.get("id") in production_only and (entry.get("source_files") or entry.get("visual_baseline_path")):
                err(f"screen-catalog.yaml {entry['id']}: absent from ui-inventory.yaml but claims handoff "
                    f"source_files/visual_baseline_path")
        if production_only:
            print(f"   production-only screens (no handoff counterpart): {production_only}")
        uncatalogued = sorted(set(screens) - set(cat_ids))
        if uncatalogued:
            err(f"ui-inventory.yaml screens absent from screen-catalog.yaml: {uncatalogued}")

# ---- ExecPlan required sections -------------------------------------------
required_sections = ["Purpose / Big Picture", "Repository Orientation", "Sources of Truth and Precedence",
    "Current-State Assessment", "Scope and Non-Goals", "Assumptions", "Agent Graph",
    "Milestones and Vertical Slices", "Detailed Implementation Steps", "Data and Migration Plan",
    "API and Realtime Contract Plan", "UI Migration and Visual Verification Plan",
    "Security and Tenant-Isolation Plan", "Observability and Audit Plan", "Test Strategy",
    "Deployment and Operations Plan", "Rollback and Recovery", "Progress",
    "Surprises & Discoveries", "Decision Log", "Risks and STOP Gates", "Acceptance Evidence",
    "Outcomes & Retrospective"]
missing_sec = [s for s in required_sections if s not in plan]
print(f"\nEXECPLAN: {len(required_sections) - len(missing_sec)}/{len(required_sections)} required sections present")
for s in missing_sec:
    err(f"EXECPLAN.md missing section: {s}")

# every slice node in state must appear in EXECPLAN
for i in nodes:
    short = i.split("-")[0] + "-" + i.split("-")[1] if "-S" in i else i
    if "-S" in i and short not in plan:
        warn(f"slice {i} ({short}) not referenced in EXECPLAN.md")

# ---- report ---------------------------------------------------------------
print("\n" + "=" * 60)
print(f"ERRORS: {len(errors)}   WARNINGS: {len(warnings)}")
for e in errors: print("  ERROR  ", e)
for w in warnings: print("  WARN   ", w)
sys.exit(1 if errors else 0)
