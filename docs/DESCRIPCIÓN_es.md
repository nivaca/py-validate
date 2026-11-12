# validate.py 1.8: descripción

## Análisis

validate.py comprueba documentos TEI contra las reglas Schematron de su esquema, desde el terminal, e informa de cada infracción: cuántas veces se incumple cada regla y, para cada infracción, la línea y el `xml:id` del elemento identificable más cercano. Toma las reglas de un ODD, de un archivo ISO Schematron o de un esquema RelaxNG generado a partir de un ODD, que las lleva embebidas, y encuentra el esquema por sí solo en las instrucciones `<?xml-model?>` del documento. Un script complementario, validate-all.sh, comprueba además la estructura con RelaxNG, y una extensión para Visual Studio Code muestra los mismos resultados en el editor, subrayados mientras se escribe. Lo hizo Nicolas Vaughan en 2026, para las ediciones del proyecto SMTrad. validate.py es software libre, bajo la Licencia Pública General de GNU, versión 3 o posterior.

La necesidad nació de oXygen, con el que se validaban los documentos del proyecto y que resultó fallar en silencio de tres maneras: muestra como mucho 100 avisos de validación y descarta el resto sin decirlo; cuando dos reglas de un pattern comparten contexto, solo se ejecuta la primera (*first-match shadowing*); y una regla vacía por error puede invalidar el esquema entero. Un documento podía parecer limpio sin estarlo.

De ahí salieron los requisitos. El informe tenía que estar siempre completo, o decir exactamente cuántas infracciones quedaban sin listar, y dar un recuento total verificable. Las reglas tenían que evaluarse igual que en oXygen, con XPath 3.1, y respetar la semántica de ISO Schematron. Un esquema sin reglas no debía aprobar nada en silencio. El programa debía funcionar desde el terminal, sobre muchos documentos a la vez, y con los esquemas que de verdad usa el proyecto: un ODD propio y un RelaxNG publicado en GitHub. Más adelante se sumó otro requisito: ver los errores mientras se edita, en el editor, sin salir a la terminal.

## Diseño

validate.py es un solo script, dividido en partes con un trabajo cada una. Las fuentes de reglas: la extracción del Schematron de un ODD con la hoja de estilo `extract-isosch.xsl` de TEI, y la cosecha de los patterns embebidos en un RelaxNG, ambas con caché. La autodetección: la lectura de las instrucciones `<?xml-model?>`, la descarga de esquemas remotos a una caché propia y la clasificación de cada esquema por su contenido. El esquema: la lectura de patterns, reglas, asserts, reports y `let`s, y de los mensajes con sus `<value-of>` y `<name/>`. La validación: la evaluación de las reglas con Saxon y la búsqueda de líneas y `xml:id`s con lxml. Y el informe, en texto para el terminal o en JSON (`--json`) para otros programas.

validate-all.sh valida en dos capas sobre el mismo RelaxNG: primero la estructura, con jing (o con lxml si jing no está), y luego las reglas, con validate.py; combina los dos veredictos en su código de salida.

La extensión de VS Code está en `vscode/`: `extension.ts` (la integración con el editor: cuándo validar, los procesos, los diagnósticos, la barra de estado y las órdenes) y `parse.ts` (la lectura de los informes de validate.py y de jing, sin depender del editor, para poder probarla aparte). Al empaquetarse, la extensión lleva su propia copia de validate.py.

Fuera de eso quedan las herramientas: `tools/screenshots.py` hace las capturas de los README, `vscode/src/test/` tiene las pruebas de la extensión, y `docs/example/` tiene un ejemplo autónomo para probar las herramientas.

## Implementación

Está escrito en Python, con dos bibliotecas: saxonche (Saxon C), que evalúa las reglas con XPath 3.1, y lxml, que encuentra las líneas y los `xml:id`s. La capa estructural usa jing, y la extensión está escrita en TypeScript. Son unas 2200 líneas: 660 en validate.py, 160 en validate-all.sh, 590 en la extensión, 450 en sus pruebas y 370 en la herramienta de capturas.

Antes se probaron implementaciones hechas. pyschematron tardaba minutos sobre el corpus, por las búsquedas `//*[@xml:id=…]` de las reglas; jing no admite `queryBinding="xslt2"`; SchXslt exigía administrar más archivos XSLT. Saxon, a través de saxonche, ya era una dependencia del proyecto, corre a la velocidad de C, y su XPath 3.1 es un superconjunto del de oXygen, de modo que `matches()`, `tokenize()`, `some`/`every` y `let` se comportan igual.

Los contextos relativos de las reglas se evalúan sobre todo el documento, y dentro de cada pattern cada nodo se compara solo con la primera regla cuyo contexto lo abarca, como prescribe ISO Schematron. Los `let` del esquema, del pattern y de la regla se traducen a `let $x := … return …` de XPath, y `current()`, que es de XSLT, se liga al nodo de contexto. Los mensajes interpolan sus `<value-of>` y `<name/>` para cada infracción. Una regla que no puede evaluarse se informa una sola vez, con el aviso de que el veredicto está incompleto. Un esquema sin reglas termina con un código de salida propio en lugar de aprobarlo todo.

Todo lo que se guarda en caché (esquemas descargados, reglas cosechadas y extraídas) se escribe en un archivo temporal que luego se renombra, de modo que quien lo lea ve o ningún archivo o uno completo, aunque varias validaciones corran a la vez. Una copia dañada se detecta y se reemplaza, y una descarga que no sea XML nunca se guarda.

### La extensión de VS Code

La extensión ejecuta `validate.py --json`, y jing si el esquema es RelaxNG, al abrir un documento, al guardarlo y mientras se escribe, cuando la escritura se detiene (medio segundo por defecto, un ajuste). Las infracciones aparecen como diagnósticos: subrayadas en el texto, con el mensaje al pasar el puntero, y en el panel Problemas, con la capa que encontró cada una (Schematron, RelaxNG o XML). Una regla con `role="warning"` o `role="info"` se muestra con esa gravedad.

El texto sin guardar se escribe en una carpeta temporal privada, nunca junto al archivo del usuario, y validate.py lo trata con `--as` como si fuera el archivo real, para que las rutas relativas de `<?xml-model?>` sigan funcionando. Mientras una etiqueta está a medio escribir, el error de buena formación aparece en su línea; si el nombre de un elemento está mal escrito, también se marca la línea donde se abrió, y jing señala el elemento. Una barra de estado muestra el resultado del archivo actual: validando, limpio, el número de problemas o un fallo. Si el Python configurado no tiene saxonche, la extensión dice cuál probó y ofrece elegir otro, comprobándolo antes de guardarlo. La orden *Refresh Schema* vuelve a descargar un esquema remoto que haya cambiado.

### Proceso y distribución

El trabajo pasó por ocho etapas: primero el informe sin tope, con el ODD del proyecto (versión 1.0); luego la cosecha de reglas del RelaxNG y las dos capas de validate-all.sh (1.1); la detección del esquema por `<?xml-model?>` y los mensajes interpolados (1.2 y 1.3); la corrección de reglas que nunca se ejecutaban y de los mensajes (1.4 y 1.6); el informe JSON y la extensión de VS Code, con la elección del intérprete y la barra de estado (1.5; extensión 0.1 a 0.3); las escrituras atómicas de la caché (1.7); la validación mientras se escribe (1.8; extensión 0.4 y 0.4.1), y por último la orden *Refresh Schema*, el icono y las capturas (extensión 0.4.2 a 0.5.1).

El código se gestiona con git, en un solo repositorio publicado en GitHub (https://github.com/nivaca/validate) y en Codeberg (https://codeberg.org/nivaca/validate). Cada versión se etiqueta (`vX.Y` cuando cambia validate.py, `vscode-vA.B.C` cuando cambia solo la extensión) y se publica en las dos forjas, con el paquete de la extensión (`.vsix`) adjunto.

## Validación

La extensión tiene 11 pruebas automáticas (`npm test`), que corren con el ejecutor de pruebas de Node. Comprueban cómo los informes de validate.py y de jing se convierten en diagnósticos, las gravedades, dónde empiezan y terminan los subrayados y los mensajes de error; una de ellas ejecuta validate.py de principio a fin. Otra prueba (`npm run test:integration`) ejecuta la extensión dentro de un VS Code real, sin pantalla y con un perfil propio: comprueba que los errores caigan en las líneas correctas y se vean subrayados, que se encuentre un elemento mal escrito, que se valide el texto sin guardar y que *Refresh Schema* recoja un esquema cambiado en un pequeño servidor web.

validate.py se comprueba con documentos y esquemas pequeños hechos para cada caso (*shadowing*, `let`s en cada nivel, espacios de nombres, atributos, texto mal formado, las tres fuentes de reglas), comparando el resultado antes y después de cada cambio, y con el ejemplo de `docs/example/`. La caché se probó volviendo a descargar el esquema durante 20 segundos mientras otros tres procesos validaban: la versión anterior falló 88 veces de 635; la nueva, ninguna. Las capturas de los README se rehacen con `tools/screenshots.py` y se revisan a ojo.

## Plataforma

Funciona en Linux. validate.py necesita Python 3.9 o superior, con saxonche y lxml; jing es opcional, para la capa estructural, y la ruta del ODD necesita además `extract-isosch.xsl` y `common/functions.xsl` de las hojas de estilo de TEI junto al script. La extensión necesita Visual Studio Code 1.85 o posterior; en Linux conviene la versión nativa (RPM o deb) y no la Flatpak, que no ve el Python ni el jing del sistema.

Al ser Python y una extensión de VS Code, debería funcionar también en Windows y macOS, pero allí no se ha probado. Solo necesita internet para descargar los esquemas remotos la primera vez, o al refrescarlos.

## Ambiente

Lo desarrollé en Fedora Linux 45 con KDE Plasma, con Python 3.15, Node.js y Visual Studio Code, y con git, con repositorios en GitHub y Codeberg. El icono de la extensión se dibujó como SVG, y las capturas se hacen con Xvfb, ImageMagick y Pillow.

Para usar validate.py basta instalar saxonche y lxml (`pip install saxonche lxml`, mejor en un entorno virtual) y ejecutar `python3 validate.py documento.xml`. Para la extensión, se descarga el `.vsix` de las versiones publicadas y se instala con `code --install-extension`; en sus ajustes, `schematron.pythonPath` indica el Python que tiene saxonche y lxml. Las descargas de esquemas quedan en `.schema-cache/`, junto al script.
