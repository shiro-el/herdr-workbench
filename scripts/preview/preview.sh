#!/bin/sh
# preview.png from a made-up scene, apart from your own Herdr: its own core, app home, HOME and projects. Windows, Git Bash.
#   sh scripts/preview/preview.sh up       build it in $DEMO (default C:/avery) and open its window
#   sh scripts/preview/preview.sh scene    play the scene and save preview.png at the repo's top
#   sh scripts/preview/preview.sh do …     run anything inside it: `preview.sh do herdr-app status`
#   sh scripts/preview/preview.sh down     close its window, stop its core and delete $DEMO
# Nothing of yours goes in: the agents are stand-ins (fake-agent.mjs) and the projects are made here.
set -eu
here=$(cd "$(dirname "$0")" && pwd) src=$(cd "$(dirname "$0")/../.." && pwd)
D=${DEMO:-C:/avery}
H=$D A=$D/.config/herdr-app S=$D/.stage C=$D/code
win() { cygpath -w "$1"; }
mixed() { cygpath -m "$1"; }
real_app=$(mixed "${USERPROFILE:-$HOME}/.config/herdr-app")

demo() {
  HERDR_APP_HOME=$(win "$A") HC_SESSION=workbench-preview USERPROFILE=$(win "$H") HOME=$(win "$H") \
    GH_CONFIG_DIR=$(win "$S/gh") HERDR_TELEMETRY=0 DO_NOT_TRACK=1 \
    GIT_AUTHOR_NAME="Avery Chen" GIT_AUTHOR_EMAIL=avery@example.com GIT_COMMITTER_NAME="Avery Chen" GIT_COMMITTER_EMAIL=avery@example.com \
    "$@"
}
json() { python -c 'import json, sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@"; }
pick() { python -c "import json, sys; print(json.load(sys.stdin)['$1'])"; }

repos() {
  mkdir -p "$C" "$S/remotes"
  # forno-lume: a bakery's site, two commits ahead of its remote, this week's page not committed yet.
  git init -q -b main "$C/forno-lume"; cd "$C/forno-lume"
  mkdir -p src/pages src/components public data docs
  printf '# Forno Lume\n\nThe site of a neighbourhood bakery: what is baked each day, hours, pickup orders.\n\n## Develop\n\n```sh\nnpm install\nnpm run dev\n```\n\n- Pages live in `src/pages`.\n- The week comes from `data/bake.csv`.\n' > README.md
  printf 'day,bread,note,price,sold_out\nTue,Country loaf,"Levain, 20%% whole wheat",6.50,\nWed,Seeded rye,"Sunflower, flax, a long cold proof",7.00,\nThu,Focaccia,"Rosemary and flaky salt, by the slab",4.00,yes\nFri,Fig and walnut,Only twenty of these,8.50,\nSat,Ten-year rye,"From the starter, nothing else",9.00,\n' > data/bake.csv
  printf '{\n  "name": "forno-lume",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest" }\n}\n' > package.json
  printf 'export function DayRow([day, bread, note, price]) {\n  return `<div class="day"><span class="d">${day}</span>${bread}<span class="price">${price}</span></div>`;\n}\n' > src/components/DayRow.js
  printf ':root { --paper: #f3ede2; --ink: #1f1b16; --rust: #a8401c; }\nbody { margin: 0; font-family: Georgia, serif; }\n' > src/style.css
  cp "$here/icons/forno-lume.svg" public/favicon.svg
  printf '# This week page\n\n- [x] A row per day from data/bake.csv\n- [x] Sold out reads struck through\n- [ ] Pickup slots form\n' > docs/week.md
  git add -A; demo git commit -qm "Start the site"
  git init -q --bare "$S/remotes/forno-lume.git"; git remote add origin "$S/remotes/forno-lume.git"; git push -q -u origin main
  printf '.day { border-top: 1px solid #d9cfbf; }\n' >> src/style.css; demo git commit -qam "Rules between days"
  demo git commit -q --allow-empty -m "Hours in the side column"
  cp "$here/bake.html" src/pages/week.html
  # orders-api and recipes
  git init -q -b main "$C/orders-api"; cd "$C/orders-api"; mkdir -p app tests
  printf 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/slots")\ndef slots():\n    return []\n' > app/main.py
  printf 'def test_slots():\n    assert True\n' > tests/test_slots.py; printf '# Orders API\n\nPickup orders for Forno Lume.\n' > README.md
  cp "$here/icons/orders-api.svg" favicon.svg
  git add -A; demo git commit -qm "Orders skeleton"
  git init -q -b main "$C/recipes"; cd "$C/recipes"; mkdir -p breads
  printf '# Recipes\n\nThe bakery'"'"'s formulas, in bakers'"'"' percentages.\n' > README.md; printf '# Country loaf\n' > breads/country.md
  cp "$here/icons/recipes.svg" icon.svg
  git add -A; demo git commit -qm "Recipes"
}

app_home() {
  mkdir -p "$A/themes" "$A/mods/demo-stage" "$S/gh"
  cp -r "$src/layouts" "$src/mods" "$src/t3-common" "$src/keys.json" "$A/"
  curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/herdr-t3/main/extras/themes/herdr-t3.json -o "$A/themes/herdr-t3.json"
  cp "$here/stage-main.js" "$A/mods/demo-stage/main.js"; echo '{ "place": "none", "title": "Demo stage" }' > "$A/mods/demo-stage/mod.json"
  # The stagehand in a 0px block.
  python - "$(mixed "$A/layouts/herdr-t3.json")" <<'PY'
import json, sys
p = sys.argv[1]; L = json.load(open(p, encoding="utf-8"))
def walk(n):
    if n.get("id") == "work-bottom-inset": n["children"].append({"id": "stage", "type": "block", "size": {"px": 0}, "content": {"mod": "demo-stage"}})
    for c in n.get("children", []): walk(c)
walk(L); json.dump(L, open(p, "w", encoding="utf-8"), indent=2)
PY
  v=$(herdr-app --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  printf '{"last_run":"%s","presented":["%s"]}' "$v" "$v" > "$A/update-notes.json"
  printf '{ "appearance": "dark", "theme": "herdr-t3", "font": "JetBrains Mono", "font_size": 12, "ui_font": "Geist", "zoom": 1,\n  "minimum_contrast": 3, "sounds": { "enabled": false }, "telemetry": false }\n' > "$A/settings.json"
  printf '{ "frame.welcomed": "finished", "layout": "herdr-t3",\n  "t3-actions": { "last": "dev", "list": [\n    { "id": "dev", "name": "Dev server", "command": "npm run dev", "icon": "play", "place": "tab" },\n    { "id": "test", "name": "Test", "command": "npm test", "icon": "test", "place": "down" } ] } }\n' > "$A/shared.json"
  # 1600x1000, on the screen your own window is on.
  python - "$real_app/window.json" "$(mixed "$A/window.json")" <<'PY'
import json, sys
try: w = json.load(open(sys.argv[1]))
except Exception: w = {}
b = w.get("bounds", [100, 100, 0, 0])
json.dump({"state": "windowed", "bounds": [b[0], b[1], 1600.0, 1000.0], **({"display": w["display"]} if "display" in w else {})}, open(sys.argv[2], "w"))
PY
}

open_app() {
  exe=$(mixed "$(command -v herdr-app)")
  case $exe in *.exe) ;; *) exe=$exe.exe ;; esac
  demo powershell -NoProfile -Command "(Start-Process -FilePath '$exe' -WorkingDirectory '$(win "$H")' -PassThru).Id" | tr -d '\r' > "$S/app.pid"
  for _ in $(seq 30); do demo herdr-app status >/dev/null 2>&1 && return; sleep 1; done
  echo "the demo window didn't answer" >&2; exit 1
}

up() {
  [ -e "$D" ] && { echo "$D exists: preview.sh down first" >&2; exit 1; }
  mkdir -p "$S"
  repos; app_home; open_app
  [ "$(demo hc server status --json | pick core)" != "$(hc server status --json | pick core)" ] || { echo "the demo core is your own: stopping" >&2; exit 1; }
  echo "up: $D"
}

# `space <name> <tab> <app> <state> <title> [screen]` / `tab <space id> <folder> <tab> <app> <state> <title> [screen]`
agent_argv() { app=$1 state=$2 title=$3; shift 3; python -c 'import json, sys; print(json.dumps(sys.argv[1:]))' node "$(mixed "$here/fake-agent.mjs")" "$app" "$state" "$title" "$@"; }
space() {
  n=$1 t=$2; shift 2
  demo herdr-app do space.new "$(python -c 'import json, sys; print(json.dumps({"name": sys.argv[1], "folder": sys.argv[2], "tab": sys.argv[3], "argv": json.loads(sys.argv[4])}))' "$n" "$(mixed "$C/$n")" "$t" "$(agent_argv "$@")")" | pick space
}
tab() {
  sp=$1 n=$2 t=$3; shift 3
  demo herdr-app do tab.new "$(python -c 'import json, sys; print(json.dumps({"space": sys.argv[1], "folder": sys.argv[2], "name": sys.argv[3], "argv": json.loads(sys.argv[4])}))' "$sp" "$(mixed "$C/$n")" "$t" "$(agent_argv "$@")")" | pick terminal
}
kid() { demo hc run --bg --json --parent "$1" --no-notify --cwd "$(mixed "$C/$2")" -- node "$(mixed "$here/fake-agent.mjs")" "$3" "$4" "$5" >/dev/null; }

scene() {
  web=$(space forno-lume "Mobile header" codex working "Fix the header on mobile")
  api=$(space orders-api "Pickup slots" claude blocked "Add the /slots endpoint")
  tab "$api" orders-api "Slot tests" pi working "Tests for pickup slots" >/dev/null
  rec=$(space recipes "Levain guide" pi done "Write the levain guide")
  tab "$rec" recipes "Units" codex working "Grams everywhere" >/dev/null
  t=$(tab "$web" forno-lume "This week page" claude done "Build this week's page" "$(mixed "$here/screen-week.txt")")
  kid "$t" forno-lume codex done "Read bake.csv"
  kid "$t" forno-lume claude working "Pickup slots form"
  sleep 2
  demo herdr-app do pane.focus "$(json terminal "$t")" >/dev/null
  demo herdr-app do layout.show '{"id":"panel"}' >/dev/null
  demo herdr-app do layout.select '{"stack":"panel-body","child":"files"}' >/dev/null
  demo herdr-app do "demo-stage.view:430|330|$(mixed "$C/forno-lume")|src/pages/week.html" >/dev/null
  # The Page mode's browser, and the Inbox's git counts.
  sleep 12
  out=${1:-$src/preview.png}
  demo herdr-app shot "$(mixed "$out")"
}

down() {
  [ -d "$D" ] || { echo "nothing at $D"; return; }
  for t in $(demo hc ls --all --json | python -c 'import json, sys; print(" ".join(t["address"] for t in json.load(sys.stdin)["terminals"]))'); do
    demo hc kill "$t" >/dev/null 2>&1 || true; done
  demo hc server stop >/dev/null 2>&1 || true
  [ -f "$S/app.pid" ] && powershell -NoProfile -Command "Stop-Process -Id $(cat "$S/app.pid") -ErrorAction SilentlyContinue" || true
  sleep 2; cd /; rm -rf "$D"; echo "down: $D removed"
}

case ${1-} in
  up) up ;;
  scene) shift; scene "$@" ;;
  do) shift; demo "$@" ;;
  down) down ;;
  *) sed -n 2,7p "$0" >&2; exit 1 ;;
esac
