#!/usr/bin/env bash
# validate-all.sh — validación bicapa de documentos TEI desde el terminal:
#   capa 1: estructura RelaxNG   (jing; si no está instalado, lxml)
#   capa 2: reglas Schematron    (validate.py -r, cosechadas del mismo .rng)
#
# Uso:
#   validate-all.sh [-v] [-m N] esquema.rng documento.xml [más.xml ...]
#   validate-all.sh [-v] [-m N] documento.xml [más.xml ...]        (v1.2)
#     -v    modo detallado de la capa Schematron (líneas y xml:ids)
#     -m N  máximo de infractores detallados (pasa --max N a validate.py)
#
# Desde v1.2 (a juego con validate.py 1.2): si el primer argumento no es un
# esquema RelaxNG (se clasifica por CONTENIDO, no por extensión), se asume
# que todo son documentos y el .rng se AUTODETECTA de la PI <?xml-model?>
# del primero, reutilizando la resolución y la caché de descargas
# (.schema-cache/) de validate.py. La capa Schematron corre entonces con la
# autodetección propia de validate.py (que converge en la misma fuente).
#
# Un único .rng alimenta ambas capas, eliminando el riesgo de divergencia
# entre artefactos regenerados asimétricamente.
#
# Códigos de salida:
#   0  ambas capas limpias
#   1  infracciones solo en la capa RelaxNG
#   2  infracciones solo en la capa Schematron
#   3  infracciones en ambas
#   4  error de entorno o de uso (mensaje por stderr)
#
# Ambas capas se ejecutan SIEMPRE (sin cortocircuito): en una campaña de
# corrección conviene ver el panorama completo de una vez.

set -u

VERBOSE=""
MAX=""
while getopts ":vm:" opt; do
  case $opt in
    v) VERBOSE="-v" ;;
    m) MAX="$OPTARG" ;;
    \?) echo "Opción desconocida: -$OPTARG" >&2; exit 4 ;;
    :)  echo "La opción -$OPTARG requiere un valor" >&2; exit 4 ;;
  esac
done
shift $((OPTIND - 1))

if [ $# -lt 1 ]; then
  echo "Uso: $(basename "$0") [-v] [-m N] [esquema.rng] documento.xml [más.xml ...]" >&2
  exit 4
fi

# validate.py: junto a este wrapper, o en el PATH (se necesita ya para la
# clasificación y la autodetección)
VALIDATE="$(dirname "$0")/validate.py"
[ -f "$VALIDATE" ] || VALIDATE=$(command -v validate.py) || {
  echo "No encuentro validate.py (ni junto al wrapper ni en el PATH)" >&2; exit 4; }

[ -f "$1" ] || { echo "No existe: $1" >&2; exit 4; }

# ¿El primer argumento es un esquema RelaxNG? (clasificación por contenido)
es_rng() {
  python3 - "$1" <<'PY'
import sys
from lxml import etree
try:
    ns = etree.QName(etree.parse(sys.argv[1]).getroot()).namespace
except Exception:
    sys.exit(1)
sys.exit(0 if ns == 'http://relaxng.org/ns/structure/1.0' else 1)
PY
}

AUTO=0
if es_rng "$1"; then
  RNG=$1; shift
  if [ $# -lt 1 ]; then
    echo "Falta el documento a validar" >&2; exit 4
  fi
else
  AUTO=1
  # Autodetección: href RelaxNG de la PI xml-model del primer documento,
  # resuelto/descargado con las funciones y la caché de validate.py.
  RNG=$(python3 - "$VALIDATE" "$1" <<'PY'
import sys, importlib.util
from pathlib import Path
from lxml import etree
spec = importlib.util.spec_from_file_location("validate", sys.argv[1])
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
doc = Path(sys.argv[2])
tree = etree.parse(str(doc))
pis = tree.xpath('//processing-instruction("xml-model")')
href = None
for pi in pis:                       # preferencia: PI tipada RelaxNG
    if pi.get('href') and pi.get('schematypens') == v.RELAXNG_NS:
        href = pi.get('href'); break
if not href:                         # respaldo: cualquier PI con href
    for pi in pis:
        if pi.get('href'):
            href = pi.get('href'); break
if not href:
    print(f"{doc.name} no lleva PI xml-model con href; pasa el esquema "
          f"explícitamente", file=sys.stderr)
    sys.exit(3)
local = v.obtener_recurso(href, doc.parent)
if v.clasificar_esquema(local) != 'rng':
    print(f"El esquema detectado ({href}) no es RelaxNG; la capa "
          f"estructural necesita un .rng — pásalo explícitamente",
          file=sys.stderr)
    sys.exit(3)
print(local)
PY
) || exit 4
  echo "[auto] esquema RelaxNG: $RNG" >&2
fi

for d in "$@"; do
  [ -f "$d" ] || { echo "No existe el documento: $d" >&2; exit 4; }
done

echo "=== capa 1: estructura RelaxNG ($(basename "$RNG")) ===" >&2
if command -v jing >/dev/null 2>&1; then
  jing "$RNG" "$@"
  rc1=$?
  # jing: 0 válido, 1 inválido, >1 error de entorno
  [ $rc1 -gt 1 ] && { echo "jing terminó con error de entorno ($rc1)" >&2; exit 4; }
else
  echo "[aviso] jing no está instalado; uso el RelaxNG de lxml (más lento" >&2
  echo "        en esquemas grandes; para lo definitivo: apt/brew install jing)" >&2
  python3 - "$RNG" "$@" <<'PYEOF'
import sys
from lxml import etree
rng = etree.RelaxNG(etree.parse(sys.argv[1]))
bad = 0
for doc in sys.argv[2:]:
    try:
        ok = rng.validate(etree.parse(doc))
    except etree.XMLSyntaxError as e:
        print(f"{doc}: mal formado: {e}"); bad = 1; continue
    if not ok:
        bad = 1
        for e in rng.error_log:
            print(f"{doc}:{e.line}: {e.message}")
sys.exit(bad)
PYEOF
  rc1=$?
fi
[ $rc1 -eq 0 ] && echo "(estructura limpia)" >&2

echo "=== capa 2: reglas Schematron ===" >&2
# shellcheck disable=SC2086
if [ $AUTO -eq 1 ]; then
  python3 "$VALIDATE" $VERBOSE ${MAX:+--max "$MAX"} "$@"
else
  python3 "$VALIDATE" -r "$RNG" $VERBOSE ${MAX:+--max "$MAX"} "$@"
fi
rc2=$?
[ $rc2 -ge 2 ] && { echo "validate.py terminó con error ($rc2)" >&2; exit 4; }

# Síntesis y código de salida compuesto
total=0
[ $rc1 -ne 0 ] && total=$((total + 1))
[ $rc2 -ne 0 ] && total=$((total + 2))
case $total in
  0) echo "=== VEREDICTO: válido en ambas capas ===" >&2 ;;
  1) echo "=== VEREDICTO: infracciones RelaxNG (estructura) ===" >&2 ;;
  2) echo "=== VEREDICTO: infracciones Schematron ===" >&2 ;;
  3) echo "=== VEREDICTO: infracciones en ambas capas ===" >&2 ;;
esac
exit $total
