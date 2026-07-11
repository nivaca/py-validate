#!/usr/bin/env python3
"""validar_smed.py — Validación Schematron de documentos TEI desde el terminal.

Uso:
    python3 validar_smed.py (-o ODD | -s SCH | -r RNG) [-v] [--max N] DOC.xml [...]

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
import re
import sys
import time
from collections import Counter
from copy import deepcopy
from pathlib import Path

from lxml import etree
from saxonche import PySaxonProcessor

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


# ---------------------------------------------------------------- fuentes

def extraer_sch(odd: Path, proc: PySaxonProcessor) -> Path:
    """ODD -> .sch con extract-isosch.xsl, cacheado por mtime."""
    exigir_archivo(odd, 'el ODD')
    sch = odd.with_suffix('.sch')
    if sch.exists() and sch.stat().st_mtime >= odd.stat().st_mtime:
        print(f"[caché] {sch.name} está al día", file=sys.stderr)
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
    if out.exists() and out.stat().st_mtime >= rng.stat().st_mtime:
        print(f"[caché] {out.name} está al día", file=sys.stderr)
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
    etree.ElementTree(schema).write(str(out), encoding='utf-8',
                                    xml_declaration=True, pretty_print=True)
    print(f"[cosecha] {rng.name} -> {out.name} "
          f"({n_pat} patterns, {n_ns} ns)", file=sys.stderr)
    return out


# ---------------------------------------------------------------- esquema

def cargar_reglas(sch_path: Path):
    """Devuelve (namespaces, patterns); cada pattern es (id, [reglas]) y cada
    regla (context, lets, tests) con test = (tipo, xpath, mensaje)."""
    exigir_archivo(sch_path, 'el Schematron')
    tree = etree.parse(str(sch_path))
    root = tree.getroot()
    nss = {ns.get('prefix'): ns.get('uri') for ns in root.iter(S + 'ns')
           if ns.get('prefix')}
    patterns = []
    for pat in root.iter(S + 'pattern'):
        if pat.get('abstract') == 'true' or pat.get('is-a'):
            avisar_una_vez('abstract',
                           'patterns abstractos/is-a no implementados: omitidos')
            continue
        reglas = []
        for rule in pat.findall(S + 'rule'):
            if rule.get('abstract') == 'true':
                avisar_una_vez('abstract-rule',
                               'reglas abstractas no implementadas: omitidas')
                continue
            lets = [(l.get('name'), l.get('value'))
                    for l in rule.findall(S + 'let')]
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
                    continue
                if qn.localname in ('assert', 'report'):
                    if t.find(S + 'value-of') is not None:
                        avisar_una_vez('value-of',
                                       'sch:value-of en mensajes: se aplana '
                                       '(mensaje sin valor interpolado)')
                    msg = ' '.join(' '.join(t.itertext()).split())
                    tests.append((qn.localname, t.get('test'), msg))
                elif qn.localname != 'let':
                    avisar_una_vez(f'el:{qn.localname}',
                                   f'elemento Schematron no implementado: '
                                   f'{qn.localname} (omitido)')
            reglas.append((rule.get('context'), lets, tests))
        if reglas:
            patterns.append((pat.get('id') or '', reglas))
    if root.find(S + 'phase') is not None:
        avisar_una_vez('phase', 'phases no implementadas: se ejecutan '
                                'todos los patterns')
    return nss, patterns


def con_lets(lets, expr):
    for name, value in reversed(lets):
        expr = f"let ${name} := ({value}) return ({expr})"
    return expr


# ------------------------------------------------------------- validación

def validar(doc_path: Path, nss, patterns, proc, verbose=False, max_list=50):
    exigir_archivo(doc_path, 'el documento')
    lx = etree.parse(str(doc_path))          # para números de línea
    xp = proc.new_xpath_processor()
    for p, u in nss.items():
        xp.declare_namespace(p, u)
    doc = proc.parse_xml(xml_file_name=str(doc_path))
    xp.set_context(xdm_item=doc)

    def nodos(ctx):
        expr = ctx if ctx.startswith('/') else f'//({ctx})'
        r = xp.evaluate(expr)
        if r is None:
            return []
        return [r[i] for i in range(r.size)] if hasattr(r, 'size') else [r]

    def fnpath(node):
        xp.set_context(xdm_item=node)
        try:
            return str(xp.evaluate_single('path(.)'))
        finally:
            xp.set_context(xdm_item=doc)

    def linea_e_id(path_q):
        """fn:path() con notación Q{uri} -> línea y xml:id vía lxml."""
        def q2p(m):
            uri = m.group(1)
            for pre, u in nss.items():
                if u == uri:
                    return f'{pre}:'
            return '*:'                       # fuera de los ns declarados
        lp = re.sub(r'Q\{([^}]*)\}', q2p, path_q)
        try:
            tgt = lx.xpath(lp, namespaces=nss)
            if tgt:
                el = tgt[0]
                anc = el.xpath('ancestor-or-self::*[@xml:id][1]')
                xid = anc[0].get(XMLID) if anc else '—'
                return el.sourceline, xid
        except Exception:
            pass
        return None, '—'

    infracciones = []
    t0 = time.time()
    for pat_id, reglas in patterns:
        ya_casados = set()                    # first-match shadowing
        for ctx, lets, tests in reglas:
            for node in nodos(ctx):
                path_id = fnpath(node)
                if path_id in ya_casados:
                    continue
                ya_casados.add(path_id)
                for tipo, test, msg in tests:
                    xp.set_context(xdm_item=node)
                    try:
                        val = xp.effective_boolean_value(con_lets(lets, test))
                    except Exception as e:
                        val = None
                        print(f"[ERROR XPath] regla '{msg[:50]}': {e}",
                              file=sys.stderr)
                    finally:
                        xp.set_context(xdm_item=doc)
                    if val is None:
                        continue
                    if (tipo == 'assert' and not val) or \
                       (tipo == 'report' and val):
                        infracciones.append((path_id, msg))

    print(f"\n== {doc_path.name} — {len(infracciones)} infracciones "
          f"({time.time()-t0:.1f}s) ==")
    for msg, n in Counter(m for _, m in infracciones).most_common():
        print(f"{n:5d}  {msg[:100]}")
    if verbose and infracciones:
        print(f"\n-- detalle (primeras {min(max_list, len(infracciones))}) --")
        for path_q, msg in infracciones[:max_list]:
            line, xid = linea_e_id(path_q)
            print(f"  l.{line or '?':>6}  [{xid}]  {msg[:90]}")
        if len(infracciones) > max_list:
            print(f"  ... y {len(infracciones)-max_list} más (sube --max)")
    return len(infracciones)


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(
        description='Validación Schematron de documentos TEI desde el terminal')
    ap.add_argument('docs', nargs='+', type=Path)
    g = ap.add_mutually_exclusive_group(required=True)
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
    args = ap.parse_args()

    total = 0
    with PySaxonProcessor(license=False) as proc:
        if args.odd:
            sch = extraer_sch(args.odd, proc)
        elif args.rng:
            sch = sch_desde_rng(args.rng)
        else:
            sch = args.sch
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
