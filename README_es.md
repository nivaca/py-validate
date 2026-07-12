# validate.py — Validación Schematron desde el terminal

Validador de la capa Schematron del proyecto SMTrad. Extrae las reglas ISO
Schematron embebidas en el ODD (`smed-schema.xml`) y las ejecuta contra uno o
más documentos TEI con Saxon (XPath 3.1), produciendo un informe completo —
sin el tope de visualización de oXygen — con recuento por regla y, en modo
detallado, número de línea y `xml:id` de cada infractor.

**Por qué existe.** oXygen presenta tres modos de fallo silencioso
documentados en la historia de este proyecto: el tope de *validation
highlights* (por defecto 100; los errores excedentes se descartan sin aviso),
el *first-match shadowing* entre reglas con contexto idéntico, y las reglas
estructuralmente vacías que invalidan el esquema entero. Este script elimina
el primero por diseño (lista todo, o avisa exactamente cuántos quedan fuera),
y hace visibles los otros dos al dar siempre un recuento total verificable.

---

## 1. Requisitos

| Componente | Versión | Papel |
|---|---|---|
| Python | ≥ 3.9 | intérprete |
| [saxonche](https://pypi.org/project/saxonche/) | ≥ 12 | motor XSLT 3.0 / XPath 3.1 (Saxon C) |
| [lxml](https://pypi.org/project/lxml/) | ≥ 4.9 | resolución de números de línea |
| `extract-isosch.xsl` + `common/functions.xsl` | TEI Stylesheets (rama `dev`) | extracción ODD → `.sch` (solo con `-o`) |

El binding XPath 3.1 de Saxon es un superconjunto del motor de oXygen, de
modo que `matches()`, `tokenize()`, `some/every … satisfies`, `if/then/else`
y los `<let>` de las reglas se evalúan de forma idéntica en ambos entornos.

## 2. Instalación

```sh
# 1. Dependencias Python
pip install saxonche lxml

# 2. Hojas de estilo TEI (solo necesarias para la extracción con -o).
#    Deben respetar esta estructura de carpetas junto al script, porque
#    extract-isosch.xsl importa ../common/functions.xsl:
mkdir -p odds common
curl -sL -o odds/extract-isosch.xsl \
  https://raw.githubusercontent.com/TEIC/Stylesheets/dev/odds/extract-isosch.xsl
curl -sL -o common/functions.xsl \
  https://raw.githubusercontent.com/TEIC/Stylesheets/dev/common/functions.xsl
```

Disposición resultante:

```
validate/
├── validate.py
├── odds/
│   └── extract-isosch.xsl
└── common/
    └── functions.xsl
```

Las rutas a `odds/` y `common/` se resuelven relativas al script
(`Path(__file__).parent`), no al directorio de trabajo: puedes invocarlo
desde cualquier sitio.

## 3. Uso

```
python3 validate.py (-o ODD | -s SCH | -r RNG) [-v] [--max N] DOC.xml [...]
```

| Opción | Efecto |
|---|---|
| `-o, --odd RUTA` | Extrae el `.sch` de un ODD **con Schematron embebido** (con caché, §4) y valida con él. Un ODD sin reglas embebidas (p. ej. `tei_all.odd` sin compilar) se rechaza con aviso, no se valida en vacío (§7) |
| `-s, --sch RUTA` | Usa un `.sch` ya extraído; omite la extracción |
| `-r, --rng RUTA` | **Cosecha** las anotaciones `sch:ns`/`sch:pattern` embebidas en un RelaxNG generado de ODD (deduplicadas, con caché) y valida con ellas — las mismas reglas que Jing ignora |
| `-v, --verbose` | Listado detallado: línea, `xml:id`, mensaje por infractor |
| `--max N` | Máximo de infractores en el detalle (defecto 50). Si hay más, el script **dice cuántos quedaron fuera** — nunca trunca en silencio |

Las tres fuentes de reglas son mutuamente excluyentes y exactamente una es
obligatoria.

### Recetas

```sh
# Ciclo cotidiano: extraer si hace falta y validar
python3 validate.py -o ../smed-schema/smed-schema.xml ../salmarc_ed_lat.xml

# Informe completo para la campaña de corrección
python3 validate.py -o ../smed-schema/smed-schema.xml -v --max 999 \
    ../salmarc_ed_lat.xml > pendientes.txt

# Varios documentos contra un .sch fijo
python3 validate.py -s smed-schema.sch -v ed_lat.xml ed_es.xml

# Contra el Schematron de las Guidelines, cosechado del RNG de tei_all (§7)
python3 validate.py -r tei_all.rng -v documento.xml

# Un solo artefacto para las dos capas: estructura con Jing, reglas con -r
jing smed-schema.rng ed_lat.xml && python3 validate.py -r smed-schema.rng ed_lat.xml

# En un Makefile o hook pre-commit (código de salida ≠ 0 si hay infracciones)
python3 validate.py -s smed-schema.sch ed_lat.xml || echo "hay pendientes"
```

### Códigos de salida

| Código | Significado |
|---|---|
| 0 | sin infracciones |
| 1 | una o más infracciones |
| 2 | error de invocación (argparse) |
| 3 | error de entorno (archivo inexistente, XSLT ausente, ODD/RNG sin reglas), con mensaje por stderr |

## 4. Configuración y caché

- **Caché de extracción**: con `-o`, el `.sch` se escribe junto al ODD
  (mismo nombre, extensión `.sch`); con `-r`, junto al RNG (extensión
  `.harvested.sch`). Solo se regeneran si el mtime de la fuente es
  posterior. El mensaje `[caché] ... está al día` lo indica. Para forzar la
  regeneración: `touch` a la fuente o borrar el derivado.
- **Prefijos de namespace**: se leen de los `<ns>` del propio `.sch`
  (actualmente solo `tei:`). No hay nada que configurar a mano.
- **Sin archivo de configuración**: todo el estado observable está en la
  línea de órdenes y en los dos artefactos (ODD, `.sch`).

## 5. Funcionamiento interno

### Pipeline

1. **Extracción** (solo `-o`): Saxon aplica `extract-isosch.xsl` al ODD y
   produce el ISO Schematron con `queryBinding="xslt2"` — un `pattern` por
   `constraintSpec`, como hace la cadena TEI estándar.
2. **Carga de reglas**: lxml parsea el `.sch` y construye la lista de
   patterns → reglas → (`context`, `let*`, tests `assert`/`report`).
3. **Ejecución**: para cada regla, los nodos de contexto se localizan con
   Saxon (`//(contexto)` para contextos relativos; los absolutos tal cual) y
   cada test se evalúa como *effective boolean value* en XPath 3.1. Los
   `<let>` se traducen a la expresión nativa `let $x := (...) return (...)`.
4. **Informe**: recuento agregado por mensaje de regla; con `-v`, cada
   infractor se resuelve a línea física y `xml:id` mediante `fn:path()`
   (Saxon) → conversión de la notación `Q{uri}` a prefijos → localización
   del nodo con lxml (`sourceline` + primer ancestro con `@xml:id`).

### Semántica ISO Schematron implementada

Cubierto — el subconjunto exacto que usa el ODD smed:

- `pattern`, `rule`, `assert`, `report`, `let`;
- `current()` (función XSLT usada por las reglas de las Guidelines P5): se
  traduce a una ligadura del nodo de contexto (`let $VALIDATE_CTX := .`) con
  sustitución textual, que reproduce exactamente su semántica Schematron;
- **first-match shadowing dentro de cada pattern**: un nodo casado por una
  regla anterior del mismo pattern queda excluido de las siguientes,
  conforme al estándar. (La extracción TEI emite un pattern por
  constraintSpec, de modo que el shadowing *entre* constraintSpecs es
  imposible por construcción — el runner lo honra igualmente por fidelidad.)

No implementado — el script **avisa por stderr una vez por tipo** y
continúa: `phase` (se ejecutan todos los patterns), patterns/reglas
abstractos (se omiten), `diagnostics`, `xsl:key`, `sch:value-of` dentro de
mensajes (el texto se aplana: mensaje sin el valor interpolado) y elementos
de otros espacios de nombres como `sqf:fix` (Quick Fixes de oXygen, que no
afectan a los veredictos). Con el ODD smed nada de esto aparece; con
Schematron de las Guidelines (§7) verás los avisos de `value-of` y `sqf`.

### Rendimiento

Edición completa (~28 000 líneas, 28 reglas, incluidos barridos
`//*[@xml:id = ...]` por cada lem vacío): **≈ 1-2 s** en hardware corriente.
El coste dominante son esos barridos O(n²); si algún día pesaran, la
alternativa documentada en el ODD es `id()` sobre motor Saxon.

## 6. Interpretación de la salida

```
[caché] smed-schema.sch está al día
[esquema] 28 patterns, 28 reglas, prefijos: tei

== salmarc_ed_lat.xml — 250 infracciones (0.8s) ==
  219  Empty lem must have a corresp attribute.
   30  An empty lem must be followed by an rdg with @type="variation-present".
    1  Every pointer in the corresp attribute of this empty lem must be ...

-- detalle (primeras 300) --
  l.  2637  [o5h_cfj_2cc]  An empty lem must be followed by an rdg with ...
```

- Las líneas `[...]` van por **stderr** (diagnóstico del propio script); el
  informe va por **stdout** — la redirección `> pendientes.txt` captura solo
  el informe.
- En el detalle, el `xml:id` es el del **ancestro identificable más
  cercano** al nodo infractor (típicamente el `<app>`), y la línea es la del
  nodo infractor mismo en el archivo fuente.
- La cifra total del encabezado es siempre exacta; `--max` limita solo el
  listado, nunca el recuento.

## 7. Validar contra un ODD estándar (tei_all y compañía)

Un ODD de personalización estándar como `tei_all.odd` es un manifiesto de
`moduleRef`s: sus reglas Schematron viven en las fuentes de las Guidelines
(`p5subset.xml`), no en el archivo. Por eso `-o` lo **rechaza** con código 3
en lugar de validar contra un esquema vacío que daría por bueno cualquier
documento. Dos rutas:

- **Ruta canónica**: compilar el ODD contra `p5subset.xml` con `odd2odd.xsl`
  (cadena TEI completa; exige clonar el repositorio de Stylesheets) y pasar
  el ODD compilado a `-o`.
- **Ruta pragmática (recomendada)**: `-r tei_all.rng`. El RelaxNG que
  distribuyen TEI y oXygen (`frameworks/tei/xml/tei/custom/schema/relaxng/`)
  lleva embebidas exactamente las mismas reglas; el script las cosecha,
  deduplica y ejecuta. Recuerda que con un esquema estándar la proporción se
  invierte respecto a smed: el grueso de la validación es la capa RelaxNG
  (Jing) y el Schematron de P5 aporta solo unas decenas de co-restricciones
  — aquí el runner es el complemento, no el plato principal.

**De dónde obtener `tei_all.rng`** (no lo generes: se distribuye compilado,
con el Schematron de las Guidelines embebido):

```sh
# release oficial de TEI (la más reciente):
curl -sLO https://www.tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng
# o el que trae tu oXygen (misma versión de P5 que tu editor):
#   $OXYGEN_HOME/frameworks/tei/xml/tei/custom/schema/relaxng/tei_all.rng
```

Elige **una** fuente y úsala para ambas capas: mezclar el `.rng` de oXygen
en Jing con el de tei-c.org en el runner (o viceversa) puede producir
discrepancias entre capas por diferencia de versión de P5.

**Receta bicapa completa contra el estándar:**

```sh
jing tei_all.rng documento.xml && python3 validate.py -r tei_all.rng documento.xml
```

El `&&` corta en la primera capa que falle; tras el runner, `$? -eq 1`
significa inequívocamente "infracciones Schematron" (no error de entorno,
que es 3). La primera corrida cosecha a `tei_all.harvested.sch` (muchos más
patterns que un esquema de proyecto: tei_all incluye todos los módulos);
las siguientes usan la caché.

Nota sobre recuentos: el `.rng` generado de un ODD embebe, además de las
reglas propias, el Schematron de las Guidelines para cada módulo incluido
(p. ej. "Abstract model violation: Lines may not contain hi", regla P5
sobre `tei:l`). La ruta `-r` valida por tanto un **superconjunto** de la
ruta `-o` — más patterns, y potencialmente infracciones nuevas que oXygen
también reportaría. Los patterns cosechados que quedan sin reglas
utilizables (vacíos o abstractos) se descartan, de ahí que la cifra de
`[esquema]` pueda ser menor que la de `[cosecha]`.

La ruta `-r` funciona igualmente con el `.rng` **propio**: un único
artefacto alimenta entonces ambas capas (estructura con Jing, reglas con el
runner), eliminando el riesgo de divergencia entre un `.rng` y un `.sch`
regenerados asimétricamente.

## 8. Qué NO valida este script

La **capa estructural RelaxNG** (modelos de contenido, atributos permitidos)
es competencia del `.rng` generado del mismo ODD. Desde terminal:

```sh
jing smed-schema.rng salmarc_ed_lat.xml     # apt install jing / brew install jing
```

Jing ignora el Schematron embebido en el RNG — exactamente el hueco que este
script cubre. Las dos órdenes juntas replican la validación completa de
oXygen, sin topes y con salida procesable.

## 9. Problemas conocidos y resolución

| Síntoma | Causa | Remedio |
|---|---|---|
| `OSError: failed to load external entity "X.xml"` | El documento no existe en la ruta dada (mensaje críptico de lxml) | Verificar ruta; las versiones recientes del script lo comprueban antes (`No existe el documento: /ruta/absoluta`) |
| `No encuentro .../odds/extract-isosch.xsl` | Faltan las hojas TEI o la estructura de carpetas | Repetir §2, respetando `odds/` y `common/` junto al script |
| `XTSE0165 ... functions.xsl` | `extract-isosch.xsl` presente pero `common/functions.xsl` ausente | Descargar la segunda hoja |
| `[ERROR XPath] regla '...'` | Un test del `.sch` no compila/evalúa en XPath 3.1 | Revisar esa regla en el ODD; el resto de reglas sigue ejecutándose |
| `[aviso] elemento Schematron no implementado: X` | El `.sch` usa constructos fuera del subconjunto (§5) | Ampliar el runner o reformular la regla |
| El `.sch` no refleja un cambio reciente del ODD/RNG | Caché por mtime con reloj/copias raras (Dropbox) | `touch` a la fuente o borrar el derivado (`.sch` / `.harvested.sch`) |
| `El ODD X no contiene Schematron embebido` (código 3) | ODD de personalización sin compilar (p. ej. `tei_all.odd`) | Usar `-r` sobre su RNG generado, o compilar con `odd2odd` (§7). Saxon imprime antes su propio error `XTMM9000`: es el mismo diagnóstico en crudo |
| `El RelaxNG X no contiene anotaciones Schematron` (código 3) | RNG generado sin reglas embebidas | Regenerarlo desde el ODD con la cadena estándar, o usar `-o`/`-s` |
| `[aviso] sch:value-of en mensajes...` / `...elementos ajenos (sqf)...` | Schematron de las Guidelines (§7) | Informativo; los veredictos no se ven afectados |
| `[aviso] elementos ajenos a Schematron ignorados (p. ej. report de http://www.tei-c.org/ns/1.0)` | Un `assert`/`report` quedó en namespace TEI en vez de Schematron — en el ODD propio significa una regla **nunca aplicada** por ninguna ruta | Localizarlo (`python3 -c "from lxml import etree; t=etree.parse('X.rng'); [print(e.sourceline, ' '.join((e.text or '').split())[:70]) for e in t.iter('{http://www.tei-c.org/ns/1.0}report')]"`) y corregir el namespace en la fuente |
| Recuentos distintos de los de oXygen | Tope de highlights de oXygen, o `.rng` desactualizado en oXygen | Subir el tope (Options → Preferences → Editor → Document Checking) y regenerar el `.rng`; la cifra del script es la exacta |

## 10. Historial de diseño

Decisiones que conviene no re-litigar sin releer la historia del proyecto:

- **Runner propio en vez de implementación empaquetada**: `pyschematron`
  (XPath 2.0 en Python puro) tarda minutos en este corpus por los barridos
  `//*[@xml:id=…]`; Jing no soporta `queryBinding="xslt2"`; SchXslt exige
  gestionar artefactos XSLT adicionales. Saxon vía `saxonche` ya era
  dependencia del proyecto y da velocidad C con el binding correcto.
- **Sin tope oculto**: el defecto `--max 50` limita el *detalle*, pero el
  script declara siempre el total y cuántos quedaron sin listar — respuesta
  directa al episodio del tope de oXygen (julio 2026).
- **Rechazo de esquemas vacíos**: un ODD o RNG sin reglas termina con
  código 3 en vez de "validar" en vacío — cierre del cuarto modo de fallo
  silencioso posible (esquema sin contenido que aprueba todo).
- **Un pattern por constraintSpec**: heredado de la extracción TEI; hace
  estructuralmente imposible el shadowing entre constraintSpecs que afectó
  a versiones antiguas del esquema.
