#!/usr/bin/env python3
"""validate.py — Validación Schematron de documentos TEI desde el terminal.

Uso:
    python3 validate.py (-o ODD | -s SCH | -r RNG) [-v] [--max N] DOC.xml [...]

Tres fuentes de reglas, mutuamente excluyentes:
  -o/--odd  ODD con Schematron embebido (p. ej. smed-schema.xml): se extrae
            el .sch con extract-isosch.xsl (TEI Stylesheets) vía Saxon, con
            caché por mtime. Los ODD de personalización SIN reglas embebidas
            (p. ej. tei_all.odd sin compilar) se rechazan con aviso: hay que
            resolverlos antes con odd2odd contra p5subset.xml, o usar -r.
  -s/--sch  ISO Schematron ya extraído: se usa tal cual.
  -r/--rng  RelaxNG generado de un ODD (p. ej. tei_all.rng, smed-schema.rng):
            se cosechan las anotaciones sch:ns / sch:pattern embebidas — las
            mismas reglas que Jing ignora — a un .sch autónomo, con caché
            por mtime.

Ejecución: Saxon (saxonche, XPath 3.1) — superconjunto del binding de oXygen,
de modo que matches(), tokenize(), some/every, if/then/else y <let> se
evalúan de forma idéntica.

Informe: recuento por regla y, con -v, listado por infractor con número de
línea y xml:id del ancestro identificable. Sin tope oculto: --max limita el
detalle, nunca el recuento, y el script declara cuántos quedaron sin listar.
Código de salida: 0 sin infracciones, 1 con infracciones,
2 error de uso, 3 error de entorno (archivo ausente, ODD sin reglas...).

Semántica implementada (subconjunto deliberado de ISO Schematron):
  - pattern / rule / assert / report / let  (let -> "let $x := ... return ...")
    Los <let> de schema y de pattern se anteponen a los de cada regla
    (evaluados en el contexto de la regla, no en la raíz del documento).
  - Contextos relativos ("tei:lem[...]") se evalúan como //(contexto);
    los absolutos ("/tei:TEI/...") tal cual.
  - First-match shadowing DENTRO de cada pattern se respeta.
  - No implementado (el runner avisa una vez por tipo y continúa): phases,
    patterns/reglas abstractos, diagnostics, xsl:key, sch:value-of dentro de
    mensajes (el texto se aplana), sqf:fix (Quick Fixes de oXygen: no afectan
    a los veredictos).

Requisitos: pip install saxonche lxml
            odds/extract-isosch.xsl + common/functions.xsl (TEI Stylesheets)
            junto a este script, solo si se usa -o.
"""

import argparse
import hashlib
import re
import sys
import time
import urllib.request
from urllib.parse import urlparse
from collections import Counter
from copy import deepcopy
from pathlib import Path

from lxml import etree
from saxonche import PySaxonProcessor

__version__ = "1.4"

SCH_NS = 'http://purl.oclc.org/dsdl/schematron'
S = f'{{{SCH_NS}}}'
XMLID = '{http://www.w3.org/XML/1998/namespace}id'
HERE = Path(__file__).resolve().parent

_avisados = set()


def avisar_una_vez(clave, msg):
    if clave not in _avisados:
        _avisados.add(clave)
        print(f"[aviso] {msg}", file=sys.stderr)


def morir(msg):
    """Error de entorno: mensaje a stderr y código de salida 3
    (0 = limpio, 1 = infracciones, 2 = uso, 3 = entorno)."""
    print(msg, file=sys.stderr)
    sys.exit(3)


def exigir_archivo(path: Path, papel: str):
    if not path.is_file():
        morir(f"No existe {papel}: {path.resolve()}")


def cache_al_dia(fuente: Path, derivado: Path) -> bool:
    """La caché se invalida si cambia la fuente O el propio script (un
    generador corregido debe regenerar sus derivados; episodio 2026-07-12)."""
    frescura = max(fuente.stat().st_mtime, Path(__file__).stat().st_mtime)
    if derivado.exists() and derivado.stat().st_mtime >= frescura:
        print(f"[caché] {derivado.name} está al día", file=sys.stderr)
        return True
    return False


# ---------------------------------------------------------------- fuentes

def extraer_sch(odd: Path, proc: PySaxonProcessor) -> Path:
    """ODD -> .sch con extract-isosch.xsl, cacheado por mtime."""
    exigir_archivo(odd, 'el ODD')
    sch = odd.with_suffix('.sch')
    if cache_al_dia(odd, sch):
        return sch
    xsl = HERE / 'odds' / 'extract-isosch.xsl'
    if not xsl.is_file():
        morir(f"No encuentro {xsl}; descarga extract-isosch.xsl y "
              f"common/functions.xsl de TEIC/Stylesheets junto al script "
              f"(véase README §2).")
    exe = proc.new_xslt30_processor().compile_stylesheet(stylesheet_file=str(xsl))
    try:
        out = exe.transform_to_string(source_file=str(odd))
    except Exception:
        out = None                # extract-isosch aborta con xsl:message si
                                  # el ODD no tiene constraints; unificamos
    if not out or '<pattern' not in out:
        morir(
            f"El ODD {odd.name} no contiene Schematron embebido: la extracción "
            f"produjo un esquema sin patterns, que validaría cualquier documento "
            f"como correcto. Si es un ODD de personalización sin compilar "
            f"(p. ej. tei_all.odd), resuélvelo primero con odd2odd contra "
            f"p5subset.xml, o valida contra su RelaxNG generado con -r "
            f"(véase README §7).")
    sch.write_text(out, encoding='utf-8')
    print(f"[extracción] {odd.name} -> {sch.name}", file=sys.stderr)
    return sch


def sch_desde_rng(rng: Path) -> Path:
    """Cosecha los sch:ns y sch:pattern embebidos en un RelaxNG generado de
    un ODD, deduplicados, a un .sch autónomo. Cacheado por mtime."""
    exigir_archivo(rng, 'el RelaxNG')
    out = rng.with_suffix('.harvested.sch')
    if cache_al_dia(rng, out):
        return out
    t = etree.parse(str(rng))
    schema = etree.Element(S + 'schema', nsmap={None: SCH_NS})
    schema.set('queryBinding', 'xslt2')
    vistos, n_ns, n_pat = set(), 0, 0
    for tag in ('ns', 'pattern'):
        for el in t.iter(S + tag):
            copia = deepcopy(el)
            copia.tail = None
            clave = etree.tostring(copia)
            if clave in vistos:
                continue
            vistos.add(clave)
            schema.append(copia)
            if tag == 'ns':
                n_ns += 1
            else:
                n_pat += 1
    if not n_pat:
        morir(f"El RelaxNG {rng.name} no contiene anotaciones Schematron "
              f"embebidas (¿fue generado sin ellas?).")
    # Poda de declaraciones de namespace rancias arrastradas por deepcopy:
    # sin esto, lxml puede serializar un elemento {ISO}x sin prefijo bajo una
    # declaración heredada xmlns="TEI", corrompiendo el namespace en el
    # viaje árbol -> bytes -> árbol (verificado con tei_all.rng).
    etree.cleanup_namespaces(schema, top_nsmap={None: SCH_NS})
    etree.ElementTree(schema).write(str(out), encoding='utf-8',
                                    xml_declaration=True, pretty_print=True)
    # Self-check: lo re-parseado debe contener exactamente lo cosechado.
    chk = etree.parse(str(out))
    chk_pat = len(chk.getroot().findall(S + 'pattern'))
    chk_ns = len(chk.getroot().findall(S + 'ns'))
    if (chk_pat, chk_ns) != (n_pat, n_ns):
        morir(f"Self-check de cosecha fallido en {out.name}: cosechados "
              f"{n_pat} patterns/{n_ns} ns, re-leídos {chk_pat}/{chk_ns}. "
              f"Corrupción de namespaces en la serialización; no se valida "
              f"contra un esquema mutilado.")
    print(f"[cosecha] {rng.name} -> {out.name} "
          f"({n_pat} patterns, {n_ns} ns)", file=sys.stderr)
    return out


# ----------------------------------------------------- autodetección

RELAXNG_NS = 'http://relaxng.org/ns/structure/1.0'
TEI_NS = 'http://www.tei-c.org/ns/1.0'


def obtener_recurso(href, base_dir: Path, refresh=False) -> Path:
    """Resuelve el href de una PI xml-model: ruta local (relativa al
    documento) o URL http(s), que se descarga a una caché junto al script
    (.schema-cache/, nombre = hash de la URL + nombre original)."""
    if re.match(r'https?://', href):
        cache = HERE / '.schema-cache'
        cache.mkdir(exist_ok=True)
        nombre = (hashlib.sha256(href.encode()).hexdigest()[:12]
                  + '-' + (Path(urlparse(href).path).name or 'schema'))
        dest = cache / nombre
        if dest.exists() and not refresh:
            print(f"[caché] {href} ya descargado -> {dest.name} "
                  f"(--refresh para forzar)", file=sys.stderr)
            return dest
        print(f"[descarga] {href}", file=sys.stderr)
        try:
            with urllib.request.urlopen(href, timeout=60) as r:
                datos = r.read()
        except Exception as e:
            morir(f"No pude descargar el esquema {href}: {e}")
        dest.write_bytes(datos)
        return dest
    p = (base_dir / href).resolve() if not Path(href).is_absolute() else Path(href)
    exigir_archivo(p, f"el esquema referido por xml-model ({href})")
    return p


def clasificar_esquema(path: Path) -> str:
    """Clasifica por CONTENIDO real (no por extensión): 'rng' | 'sch' | 'odd'."""
    try:
        root = etree.parse(str(path)).getroot()
    except etree.XMLSyntaxError as e:
        morir(f"El esquema {path.name} no es XML bien formado: {e}")
    ns = etree.QName(root).namespace
    if ns == RELAXNG_NS:
        return 'rng'
    if ns == SCH_NS:
        return 'sch'
    if ns == TEI_NS:
        return 'odd'
    morir(f"No reconozco el esquema {path.name} (raíz en namespace {ns}); "
          f"indícalo explícitamente con -o, -s o -r.")


def href_xml_model(doc_path: Path, preferencia=(SCH_NS, RELAXNG_NS)):
    """href de la PI <?xml-model?> del documento: la primera cuyo
    schematypens figure en `preferencia` (por orden); en su defecto, la
    primera PI con href. Termina con código 3 si no hay ninguna."""
    exigir_archivo(doc_path, 'el documento')
    try:
        tree = etree.parse(str(doc_path))
    except etree.XMLSyntaxError as e:
        morir(f"El documento {doc_path.name} no está bien formado: {e}")
    entradas = [(pi.get('href'), pi.get('schematypens') or '')
                for pi in tree.xpath('//processing-instruction("xml-model")')
                if pi.get('href')]
    if not entradas:
        morir(f"{doc_path.name} no lleva ninguna PI <?xml-model?> con href; "
              f"indica el esquema explícitamente.")
    for ns in preferencia:
        for href, tipo in entradas:
            if tipo == ns:
                return href
    return entradas[0][0]


def detectar_esquema(doc_path: Path, refresh=False):
    """Lee las PIs <?xml-model?> del documento y devuelve (ruta, tipo).
    Preferencia: una PI con schematypens de Schematron; en su defecto, la
    de RelaxNG (cuyo Schematron embebido se cosechará); hrefs duplicados
    (el patrón habitual: el mismo .rng asociado dos veces, una por capa)
    cuentan como una sola fuente. La clasificación final es por contenido,
    no por extensión ni por lo que la PI declare."""
    href = href_xml_model(doc_path)
    print(f"[xml-model] esquema detectado: {href}", file=sys.stderr)
    local = obtener_recurso(href, doc_path.parent, refresh)
    tipo = clasificar_esquema(local)
    print(f"[xml-model] clasificado por contenido como: {tipo}",
          file=sys.stderr)
    return local, tipo


# ---------------------------------------------------------------- esquema

def leer_lets(el):
    return [(l.get('name'), l.get('value')) for l in el.findall(S + 'let')]


def leer_mensaje(t):
    """Texto aplanado de un assert/report y sus segmentos ('txt' | 'exp')
    para interpolar sch:value-of."""
    segs = []
    if t.text and t.text.strip():
        segs.append(('txt', ' '.join(t.text.split())))
    for hijo in t:
        if isinstance(hijo.tag, str):
            hq = etree.QName(hijo)
            if hq.namespace == SCH_NS and hq.localname == 'value-of':
                segs.append(('exp', hijo.get('select')))
            else:
                txt = ' '.join(''.join(hijo.itertext()).split())
                if txt:
                    segs.append(('txt', txt))
        if hijo.tail and hijo.tail.strip():
            segs.append(('txt', ' '.join(hijo.tail.split())))
    msg = ' '.join(s for k, s in segs if k == 'txt')
    return msg, segs


def cargar_reglas(sch_path: Path):
    """Devuelve (namespaces, patterns); cada pattern es (id, [reglas]), cada
    regla (context, [tests]) y cada test (tipo, xpath, mensaje, segmentos).
    Los <let> (de schema, pattern y regla, por ese orden) ya van integrados
    en las expresiones XPath de tests y segmentos."""
    exigir_archivo(sch_path, 'el Schematron')
    root = etree.parse(str(sch_path)).getroot()
    nss = {ns.get('prefix'): ns.get('uri') for ns in root.iter(S + 'ns')
           if ns.get('prefix')}
    lets_schema = leer_lets(root)
    patterns = []
    for pat in root.iter(S + 'pattern'):
        if pat.get('abstract') == 'true' or pat.get('is-a'):
            avisar_una_vez('abstract',
                           'patterns abstractos/is-a no implementados: omitidos')
            continue
        lets_pat = lets_schema + leer_lets(pat)
        reglas = []
        for rule in pat.findall(S + 'rule'):
            if rule.get('abstract') == 'true':
                avisar_una_vez('abstract-rule',
                               'reglas abstractas no implementadas: omitidas')
                continue
            lets = lets_pat + leer_lets(rule)
            tests = []
            for t in rule:
                if not isinstance(t.tag, str):      # comentarios, PIs
                    continue
                qn = etree.QName(t)
                if qn.namespace != SCH_NS:
                    avisar_una_vez(f'ns:{qn.namespace}',
                                   f'elementos ajenos a Schematron ignorados '
                                   f'(p. ej. {qn.localname} de {qn.namespace}); '
                                   f'no afectan a los veredictos')
                elif qn.localname in ('assert', 'report'):
                    msg, segs = leer_mensaje(t)
                    segs = [(k, con_lets(lets, v) if k == 'exp' else v)
                            for k, v in segs]
                    tests.append((qn.localname, con_lets(lets, t.get('test')),
                                  msg, segs))
                elif qn.localname != 'let':
                    avisar_una_vez(f'el:{qn.localname}',
                                   f'elemento Schematron no implementado: '
                                   f'{qn.localname} (omitido)')
            reglas.append((rule.get('context'), tests))
        if reglas:
            patterns.append((pat.get('id') or '', reglas))
    if root.find(S + 'phase') is not None:
        avisar_una_vez('phase', 'phases no implementadas: se ejecutan '
                                'todos los patterns')
    return nss, patterns


def con_lets(lets, expr):
    for name, value in reversed(lets):
        expr = f"let ${name} := ({value}) return ({expr})"
    # current() es XSLT, no XPath: en Schematron refiere al nodo de contexto
    # de la regla. Se liga en la posición más externa y se sustituye, lo que
    # reproduce exactamente esa semántica (las Guidelines P5 lo usan).
    if 'current()' in expr:
        expr = expr.replace('current()', '$VALIDATE_CTX')
        expr = f"let $VALIDATE_CTX := . return ({expr})"
    return expr


# ------------------------------------------------------------- validación

def ruta_lxml(path_q, nss):
    """fn:path() (notación Q{uri}local) -> XPath 1.0 evaluable por lxml."""
    def paso(m):
        uri, local = m.group(1), m.group(2)
        if not uri:
            return local
        for pre, u in nss.items():
            if u == uri:
                return f'{pre}:{local}'
        return f"*[local-name()='{local}' and namespace-uri()='{uri}']"
    return re.sub(r'Q\{([^}]*)\}([^\[/]+)', paso, path_q)


def validar(doc_path: Path, nss, patterns, proc, verbose=False, max_list=50):
    exigir_archivo(doc_path, 'el documento')
    try:
        lx = etree.parse(str(doc_path))      # para números de línea
    except etree.XMLSyntaxError as e:
        morir(f"El documento {doc_path.name} no está bien formado: {e}. "
              f"Corrígelo antes de validar (xmllint --noout lo localiza).")
    xp = proc.new_xpath_processor()
    for p, u in nss.items():
        xp.declare_namespace(p, u)
    doc = proc.parse_xml(xml_file_name=str(doc_path))
    xp.set_context(xdm_item=doc)

    def en(node, metodo, expr):
        """Evalúa expr con `node` como contexto y restaura el documento."""
        xp.set_context(xdm_item=node)
        try:
            return metodo(expr)
        finally:
            xp.set_context(xdm_item=doc)

    def nodos(ctx):
        expr = ctx if ctx.startswith('/') else f'//({ctx})'
        r = xp.evaluate(expr)
        if r is None:
            return []
        return [r[i] for i in range(r.size)] if hasattr(r, 'size') else [r]

    def interpolar(node, msg, segs):
        if not any(k == 'exp' for k, _ in segs):
            return msg
        try:
            partes = []
            for k, v in segs:
                if k == 'txt':
                    partes.append(v)
                else:
                    r = en(node, xp.evaluate, v)
                    partes.append(str(r) if r is not None else '')
            return ' '.join(p for p in partes if p)
        except Exception:
            return msg

    def linea_e_id(path_q):
        """Número de línea y xml:id del ancestro identificable, vía lxml."""
        try:
            tgt = lx.xpath(ruta_lxml(path_q, nss), namespaces=nss)
            if tgt:
                el = tgt[0]
                if not isinstance(el, etree._Element):   # atributo, texto
                    el = el.getparent()
                anc = el.xpath('ancestor-or-self::*[@xml:id][1]')
                xid = anc[0].get(XMLID) if anc else '—'
                return el.sourceline, xid
        except Exception:
            pass
        return None, '—'

    infracciones = []
    errores = Counter()
    t0 = time.time()
    for pat_id, reglas in patterns:
        ya_casados = set()                    # first-match shadowing
        for ctx, tests in reglas:
            for node in nodos(ctx):
                path_id = str(en(node, xp.evaluate_single, 'path(.)'))
                if path_id in ya_casados:
                    continue
                ya_casados.add(path_id)
                for tipo, test, msg, segs in tests:
                    try:
                        val = en(node, xp.effective_boolean_value, test)
                    except Exception as e:
                        errores[(msg[:50], str(e).strip())] += 1
                        continue
                    if val == (tipo == 'report'):
                        infracciones.append(
                            (path_id, msg, interpolar(node, msg, segs)))

    for (msg, err), n in errores.items():
        print(f"[ERROR XPath] regla '{msg}': {err} ({n} nodos)",
              file=sys.stderr)
    print(f"\n== {doc_path.name} — {len(infracciones)} infracciones "
          f"({time.time()-t0:.1f}s) ==")
    if errores:
        print(f"[!] {sum(errores.values())} evaluaciones fallidas en "
              f"{len(errores)} reglas: el veredicto es INCOMPLETO")
    for msg, n in Counter(m for _, m, _ in infracciones).most_common():
        print(f"{n:5d}  {msg[:100]}")
    if verbose and infracciones:
        print(f"\n-- detalle (primeras {min(max_list, len(infracciones))}) --")
        for path_q, msg, interp in infracciones[:max_list]:
            line, xid = linea_e_id(path_q)
            print(f"  l.{line or '?':>6}  [{xid}]  {interp[:140]}")
        if len(infracciones) > max_list:
            print(f"  ... y {len(infracciones)-max_list} más (sube --max)")
    return len(infracciones)


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(
        description='Validación Schematron de documentos TEI desde el terminal')
    ap.add_argument('--version', action='version',
                    version=f'%(prog)s {__version__}')
    ap.add_argument('docs', nargs='+', type=Path)
    g = ap.add_mutually_exclusive_group(required=False)
    g.add_argument('-o', '--odd', type=Path,
                   help='ODD con Schematron embebido del que extraer el .sch')
    g.add_argument('-s', '--sch', type=Path, help='.sch ya extraído')
    g.add_argument('-r', '--rng', type=Path,
                   help='RelaxNG generado de un ODD; se cosecha su Schematron embebido')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='listado detallado con líneas y xml:ids')
    ap.add_argument('--max', type=int, default=50,
                    help='máximo de infracciones detalladas (def. 50; '
                         'el recuento total nunca se trunca)')
    ap.add_argument('--refresh', action='store_true',
                    help='con autodetección por xml-model: volver a '
                         'descargar el esquema aunque esté en caché')
    args = ap.parse_args()

    total = 0
    with PySaxonProcessor(license=False) as proc:
        if args.odd:
            sch = extraer_sch(args.odd, proc)
        elif args.rng:
            sch = sch_desde_rng(args.rng)
        elif args.sch:
            sch = args.sch
        else:
            local, tipo = detectar_esquema(args.docs[0], args.refresh)
            if len(args.docs) > 1:
                print("[aviso] esquema detectado del PRIMER documento; se "
                      "aplica a todos los de esta invocación", file=sys.stderr)
            if tipo == 'odd':
                sch = extraer_sch(local, proc)
            elif tipo == 'rng':
                sch = sch_desde_rng(local)
            else:
                sch = local
        nss, patterns = cargar_reglas(sch)
        n_reglas = sum(len(r) for _, r in patterns)
        print(f"[esquema] {len(patterns)} patterns, {n_reglas} reglas, "
              f"prefijos: {', '.join(nss)}", file=sys.stderr)
        for d in args.docs:
            total += validar(d, nss, patterns, proc,
                             verbose=args.verbose, max_list=args.max)
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    main()
