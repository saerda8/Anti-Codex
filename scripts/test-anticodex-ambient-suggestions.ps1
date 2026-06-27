[CmdletBinding()]
param(
    [string]$CodexHome = $(Join-Path $env:APPDATA "anticodex\codex-home-deepseek-app"),
    [string]$InstallRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

$ErrorActionPreference = "Stop"
$startedAt = [DateTime]::UtcNow

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-$Name.json")
        history = (Join-Path $ReportRoot "$stamp-$Name.json")
    }
}

function Save-JsonReport {
    param($Paths, $Payload, [int]$Depth = 12)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

function Invoke-PythonAmbientProbe {
    param([string]$CodexHomePath, [string]$InstallRootPath)
    $pythonCode = @'
import json, os, re, sqlite3, sys

codex_home = os.path.abspath(sys.argv[1])
install_root = os.path.abspath(sys.argv[2])
terms = ("ambient", "suggest", "suggestion", "proactive")
failures = []

def norm(path):
    return os.path.normcase(os.path.abspath(path)).replace("\\", "/")

def rel(path, root):
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except Exception:
        return path.replace("\\", "/")

allowed_name_patterns = [
    re.compile(r"^electron-user-data-adaptive/OnDeviceHeadSuggestModel(/.*)?$", re.I),
    re.compile(r"^skills/gstack/scripts/proactive-suggestions\.json$", re.I),
    re.compile(r"^skills/gstack/scripts/resolvers/preamble/generate-proactive-prompt\.ts$", re.I),
    re.compile(r"^skills/lark-calendar/references/lark-calendar-suggestion\.md$", re.I),
    re.compile(r"^\.patch-backups/shared-plugin-host/skills/gstack/scripts/proactive-suggestions\.json$", re.I),
    re.compile(r"^\.patch-backups/shared-plugin-host/skills/gstack/scripts/resolvers/preamble/generate-proactive-prompt\.ts$", re.I),
]
allowed_install_patterns = [
    re.compile(r"^runtime/scripts/test-anticodex-ambient-suggestions\.ps1$", re.I),
    re.compile(r"^(codex-patched-app|rollback-host)/gen/third_party/devtools-frontend/src/front_end/ui/components/suggestion_input$", re.I),
    re.compile(r"^(codex-patched-app|rollback-host)/gen/third_party/devtools-frontend/src/front_end/ui/(components/suggestion_input|legacy)/.*$", re.I),
]

def allowed(rel_path, patterns):
    return any(pattern.search(rel_path) for pattern in patterns)

def suspicious_name(value):
    text = value.lower()
    return any(term in text for term in terms)

def scan_names(root, patterns):
    entries = []
    if not os.path.isdir(root):
        return {"root": root, "exists": False, "entries": entries}
    for dirpath, dirnames, filenames in os.walk(root):
        # Avoid large generated dependency trees that can contain unrelated suggestion strings.
        parts = set(rel(dirpath, root).lower().split("/"))
        if "node_modules" in parts or ".git" in parts:
            dirnames[:] = []
            continue
        for name in list(dirnames) + list(filenames):
            if not suspicious_name(name):
                continue
            path = os.path.join(dirpath, name)
            rel_path = rel(path, root)
            is_allowed = allowed(rel_path, patterns)
            try:
                st = os.stat(path)
                size = None if os.path.isdir(path) else st.st_size
                mtime = st.st_mtime
            except OSError:
                size = None
                mtime = None
            entries.append({
                "path": rel_path,
                "directory": os.path.isdir(path),
                "allowed": is_allowed,
                "size": size,
                "mtime": mtime,
            })
    return {"root": root, "exists": True, "entries": entries}

codex_name_scan = scan_names(codex_home, allowed_name_patterns)
install_name_scan = scan_names(install_root, allowed_install_patterns)
for entry in codex_name_scan["entries"]:
    if not entry["allowed"]:
        failures.append(f"unexpected suggestion-like Anti-Codex state path: {entry['path']}")
for entry in install_name_scan["entries"]:
    if not entry["allowed"]:
        failures.append(f"unexpected suggestion-like Anti-Codex install path: {entry['path']}")

def json_key_hits(path):
    hits = []
    if not os.path.isfile(path):
        return {"path": path, "exists": False, "hits": hits}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as error:
        return {"path": path, "exists": True, "parseError": str(error), "hits": hits}
    def walk(value, key_path=""):
        if isinstance(value, dict):
            for key, child in value.items():
                current = f"{key_path}.{key}" if key_path else str(key)
                if suspicious_name(str(key)):
                    hits.append(current)
                walk(child, current)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{key_path}[{index}]")
    walk(data)
    return {"path": path, "exists": True, "hits": hits}

config_checks = []
for name in ("config.toml", ".codex-global-state.json"):
    path = os.path.join(codex_home, name)
    if name.endswith(".json"):
        result = json_key_hits(path)
        for hit in result.get("hits", []):
            failures.append(f"ambient suggestion-like config key present: {name}:{hit}")
        config_checks.append(result)
    else:
        hits = []
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for number, line in enumerate(handle, 1):
                    key = line.split("=", 1)[0].strip()
                    if key and suspicious_name(key):
                        hits.append({"line": number, "key": key})
        for hit in hits:
            failures.append(f"ambient suggestion-like config key present: {name}:{hit['key']}")
        config_checks.append({"path": path, "exists": os.path.isfile(path), "hits": hits})

local_state_path = os.path.join(codex_home, "electron-user-data-adaptive", "Local State")
local_state = json_key_hits(local_state_path)
benign_local_state_hits = []
for hit in local_state.get("hits", []):
    # Chromium keeps tab discard counters named *_suggested and on-device browser model metadata.
    if "discards_suggested" in hit or "reloads_suggested" in hit or "discards_proactive" in hit or "reloads_proactive" in hit or hit.startswith("optimization_guide."):
        benign_local_state_hits.append(hit)
    else:
        failures.append(f"unexpected suggestion-like Electron local-state key: {hit}")
local_state["benignHits"] = benign_local_state_hits
local_state["hits"] = [hit for hit in local_state.get("hits", []) if hit not in benign_local_state_hits]

sqlite_checks = []
for name in ("state_5.sqlite", "goals_1.sqlite", "memories_1.sqlite", "logs_2.sqlite"):
    path = os.path.join(codex_home, name)
    check = {"path": path, "exists": os.path.isfile(path), "tableHits": [], "columnHits": [], "targetHits": [], "bodyTextHitCount": 0}
    if os.path.isfile(path):
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            tables = [row["name"] for row in con.execute("select name from sqlite_master where type='table' order by name")]
            for table in tables:
                if suspicious_name(table):
                    check["tableHits"].append(table)
                    failures.append(f"ambient suggestion-like sqlite table: {name}:{table}")
                cols = [row["name"] for row in con.execute(f'pragma table_info("{table}")')]
                for col in cols:
                    if suspicious_name(col):
                        check["columnHits"].append({"table": table, "column": col})
                        failures.append(f"ambient suggestion-like sqlite column: {name}:{table}.{col}")
            if name == "logs_2.sqlite":
                where = " OR ".join(["lower(feedback_log_body) like ?" for _ in terms])
                params = [f"%{term}%" for term in terms]
                try:
                    row = con.execute(f"select count(*) as n from logs where {where}", params).fetchone()
                    check["bodyTextHitCount"] = int(row["n"] or 0)
                except Exception:
                    pass
                for field in ("target", "module_path", "file"):
                    try:
                        where = " OR ".join([f"lower({field}) like ?" for _ in terms])
                        rows = con.execute(f"select {field} as value, count(*) as n, max(ts) as maxTs from logs where {where} group by {field} order by max(ts) desc limit 20", params).fetchall()
                        for row in rows:
                            value = str(row["value"] or "")
                            check["targetHits"].append({"field": field, "value": value, "count": int(row["n"] or 0), "maxTs": row["maxTs"]})
                            failures.append(f"ambient suggestion-like log source: {name}:{field}:{value}")
                    except Exception:
                        pass
            con.close()
        except Exception as error:
            check["error"] = str(error)
            failures.append(f"sqlite ambient suggestion scan failed for {name}: {error}")
    sqlite_checks.append(check)

head_suggest_dir = os.path.join(codex_home, "electron-user-data-adaptive", "OnDeviceHeadSuggestModel")
head_suggest_files = []
if os.path.isdir(head_suggest_dir):
    for dirpath, _, filenames in os.walk(head_suggest_dir):
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            try:
                st = os.stat(path)
                head_suggest_files.append({"path": rel(path, head_suggest_dir), "size": st.st_size, "mtime": st.st_mtime})
            except OSError:
                head_suggest_files.append({"path": rel(path, head_suggest_dir), "size": None, "mtime": None})

payload = {
    "failures": failures,
    "codexHome": codex_home,
    "installRoot": install_root,
    "configChecks": config_checks,
    "electronLocalState": local_state,
    "nameScans": {
        "codexHome": codex_name_scan,
        "installRoot": install_name_scan,
    },
    "sqliteChecks": sqlite_checks,
    "chromiumOnDeviceHeadSuggestModel": {
        "path": head_suggest_dir,
        "exists": os.path.isdir(head_suggest_dir),
        "fileCount": len(head_suggest_files),
        "files": head_suggest_files[:20],
    },
}
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
'@
    $output = $pythonCode | python - $CodexHomePath $InstallRootPath
    return ($output | ConvertFrom-Json -ErrorAction Stop)
}

$probe = Invoke-PythonAmbientProbe -CodexHomePath $CodexHome -InstallRootPath $InstallRoot
$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = (@($probe.failures).Count -eq 0)
    failures = @($probe.failures)
    reportName = "ambient-suggestions"
    noTraffic = $true
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "installed-no-traffic"
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    codexHome = $probe.codexHome
    installRoot = $probe.installRoot
    configChecks = $probe.configChecks
    electronLocalState = $probe.electronLocalState
    nameScans = $probe.nameScans
    sqliteChecks = $probe.sqliteChecks
    chromiumOnDeviceHeadSuggestModel = $probe.chromiumOnDeviceHeadSuggestModel
}

$reportPaths = New-ReportPaths "ambient-suggestions"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 12 -Compress
if ($result.ok -ne $true) { exit 1 }
