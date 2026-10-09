# Extensión nativa ElrikPiro

La extensión vive en `extension/` y usa HTML, CSS y JavaScript nativos. No comparte el runtime del frontend React y no requiere instalación de paquetes ni compilación. El manifiesto activo es `extension/manifest.json`; las variantes fuente `manifest.chromium.json` y `manifest.firefox.json` se copian manualmente antes de cargarla.

## Cargar la extensión

En Chromium, copia `manifest.chromium.json` sobre `manifest.json`, abre `chrome://extensions` o `edge://extensions`, activa el modo de desarrollador y elige **Cargar descomprimida**. Selecciona la carpeta `extension/`.

En Firefox, copia `manifest.firefox.json` sobre `manifest.json`, abre `about:debugging#/runtime/this-firefox`, elige **Cargar complemento temporal…** y selecciona `extension/manifest.json`. El complemento temporal se conserva hasta cerrar Firefox; después hay que cargarlo de nuevo.

Al cambiar de navegador, copia la variante correspondiente al `manifest.json` antes de cargar o recargar la carpeta. Chromium usa un service worker y Firefox scripts de background. La suite automatizada cubre las APIs con dobles locales y Node; todavía no valida en una instalación nativa de Firefox o Chromium los diálogos de permisos ni sus almacenes de certificados.

## Preparar paquetes

Desde la raíz del repositorio de la extensión, ejecuta **node scripts/package-extension.mjs**.

El proceso comprueba que los manifests completos coincidan salvo el background propio de cada navegador, valida CSP y permisos, revisa referencias a recursos locales y excluye pruebas y archivos de desarrollo. Genera **extension/dist/chromium-unpacked/** y **chromium.zip**, además de **firefox-unpacked/** y **firefox-unsigned.xpi**. Ambos paquetes usan las mismas fuentes y assets; solo cambia el manifest de destino. **package-report.json** registra las verificaciones y los bloqueos de entrega; **SHA256SUMS** contiene los hashes de los archivos comprimidos, el informe y cada archivo de las dos carpetas desempaquetadas. El ZIP y XPI se generan de forma determinista. La carpeta **dist/** es temporal y no se versiona.

Las carpetas desempaquetadas sirven para carga manual de desarrollo. **firefox-unsigned.xpi** es un candidato para el proceso de Mozilla y no se puede instalar en Firefox estable sin firma. El flujo **Package browser extensions** ejecuta la suite de extensión y las comprobaciones del empaquetador en cada cambio. La prueba HTTPS contra el backend real requiere su checkout y entorno de pruebas contiguos; en el repositorio aislado informa un skip explícito, así que ese flujo de paquetes no acredita esa integración. Solo una ejecución manual con **Submit the Firefox package to Mozilla for unlisted signing** habilitado envía la extensión a Mozilla para obtener una firma de distribución directa.

Antes de solicitar firma Firefox, configura en el repositorio las variables **FIREFOX_ADDON_ID** y **FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON**, y los secretos **WEB_EXT_API_KEY** y **WEB_EXT_API_SECRET**. La declaración JSON tiene las claves **required** y **optional**, según la [clasificación de datos de Firefox](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/). Clasifica el tráfico real de la extensión antes de establecerla; el builder no elige estas categorías por ti. La identidad y clasificación pueden incluirse en el manifest Firefox o proporcionarse mediante variables de CI; el paso de firma se detiene si falta cualquiera de las dos. La firma sin listar usa [Mozilla web-ext](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) y no publica una ficha pública. No se han suministrado credenciales ni se ha enviado un paquete para firma.

El archivo **chromium.zip** es un paquete para un canal admitido, no un instalador persistente universal. Una distribución no listada en Chrome Web Store es una opción posible cuando se confirme que esa tienda sirve a los navegadores de destino; se aplican su [revisión y sus políticas](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution/). La tienda, la identidad estable de Chromium y su disponibilidad para cada distribución siguen pendientes de verificación.

## Conexión segura

En **Configuración**, introduce una dirección HTTPS del servidor, un token Bearer y un tiempo de espera. La extensión normaliza la ruta para usar `/api/v1`. Rechaza direcciones HTTP, credenciales en la URL, consultas, fragmentos, segmentos codificados que cambien la ruta y prefijos duplicados.

Al elegir **Probar y conectar**, el navegador solicita permiso para acceder al host HTTPS configurado. El permiso se pide desde esa acción del usuario y se comprueba antes de cada solicitud. Si se deniega o se revoca, la conexión queda desactivada. El background es el único componente que realiza peticiones; envía el token como `Authorization: Bearer` solo al origen y a la ruta API validados. Las solicitudes omiten credenciales del navegador, no siguen redirecciones y no se guardan en caché.

El token se conserva en el almacenamiento local de la extensión. Los errores remotos se reducen a mensajes seguros antes de guardarlos o mostrarlos; los datos de recursos, como IDs y enlaces HAL, se mantienen intactos para no cambiar su identidad.

La conexión comprueba que el servidor responde con el recurso HAL raíz esperado. Las lecturas y mutaciones usan operaciones tipadas de la API. Si se pierde la respuesta de una mutación, la interfaz la marca como incierta y no la reenvía automáticamente.

## Popup e indicador

El popup muestra la primera tarea urgente activa de la agenda. Permite completarla o posponerla cinco minutos después de volver a consultar la agenda y comprobar el ID mostrado. Si cambia la conexión mientras esa consulta está en curso, no envía la operación al nuevo destino. Los errores de conexión muestran un distintivo accesible y se conservan al reiniciar el background.

El botón **Abrir gestor** reutiliza la pestaña del gestor de esta extensión que se haya usado más recientemente. Si esa pestaña está en una ventana minimizada, la restaura y le devuelve el foco. Si no hay una pestaña válida, abre una nueva. Las páginas externas y las pestañas de esta extensión con otra ruta, consulta o fragmento no cuentan como gestor. El orden de uso se guarda en el perfil local y se reconcilia cuando se inicia el background; si no puede reconstruirse, se prioriza la pestaña activa de la ventana actualmente enfocada. Sin una ventana enfocada, se elige primero el ID de pestaña menor. La operación no cambia la selección de tarea ni la copia de avisos.

## Avisos y copia local

El background lee el historial de avisos mediante `GET` con una alarma cada cinco minutos. Valida la identidad del historial, los números de secuencia, las marcas de tiempo y los límites de retención antes de guardar la respuesta en el almacenamiento local de ese perfil. La identidad de cada aviso combina el ID del historial y su secuencia, por lo que dos avisos con el mismo texto siguen siendo distintos. El background guarda las entradas y el cursor antes de mostrar una notificación nativa; los avisos nuevos de un ciclo se agrupan en una sola alerta.

El servidor conserva una ventana limitada y puede retirar entradas antiguas. Si el cliente detecta un salto de secuencia dentro del mismo historial, la copia local muestra el rango que no recibió. Un cambio de servidor o de identidad de historial conserva las entradas antiguas con su origen y no las atribuye al historial nuevo. El dispositivo conserva como máximo 1024 avisos; si se alcanza ese límite, mantiene los más recientes e indica que la copia local se truncó. Un fallo al leer o validar el historial no se interpreta como una agenda vacía ni permite continuar con la comprobación de tareas urgentes.

La comprobación de tareas urgentes solo se ejecuta cuando una lectura válida confirma que no hay avisos nuevos. Usa la zona horaria y la agenda anunciadas por el servidor; una alerta nativa de tarea requiere el contexto exacto `alert`.

El gestor y el popup muestran la copia guardada sin consultar la red. **Vaciar** borra solo la copia local de ese perfil y los registros locales antiguos; conserva el cursor y la identidad del servidor para evitar repetir alertas ya recibidas. No modifica ni reconoce los avisos del servidor ni elimina las notificaciones que ya creó el sistema operativo. Cada perfil del navegador mantiene su propia copia.

## Gestor

La página principal carga tareas, agenda, estadísticas, eventos, estrategias y proyectos mediante lecturas HAL autenticadas. Cada instancia del gestor mantiene sus propios filtros, búsqueda, paginación, algoritmo, heurística, selección y formularios; una vista no cambia las consultas de otra instancia. La selección de una tarea desde la agenda pide su detalle por ID incluso si no aparece en la página actual. Un ID ausente o ambiguo produce un error visible y no selecciona otra fila.

Las acciones y sus campos proceden de las capacidades anunciadas por cada recurso. Las ediciones de una tarea combinan cambios de propiedades y esfuerzo en una sola operación. Los campos de identidad, estado y esfuerzo derivado no se envían como cambios. Abrir otro recurso, actualizar datos, recibir una invalidación no cambia el destino ni descarta un borrador; se puede cargar la versión remota conservando el borrador o descartarlo de forma explícita. Las mutaciones confirmadas actualizan las vistas con sus propios parámetros. Los resultados inciertos no se reenvían automáticamente.

Recuperar el foco o volver a mostrar la pestaña no consulta el servidor. Las actualizaciones se solicitan con **Actualizar datos**, con una acción o consulta del usuario, o cuando el background recibe avisos nuevos o detecta un cambio en el orden de las tareas urgentes. El background conserva los IDs ordenados de la última comprobación para evitar recargas cuando la prioridad sigue igual.

**Completar tarea** está en la cabecera del detalle, junto a **Actualizar datos**. Una confirmación correcta vuelve a la lista de tareas; un fallo conserva el detalle. Los campos de contexto muestran un desplegable con todos los prefijos de comando configurados y publicados por la API, tanto al crear como al editar. Si el servidor todavía no publica esos prefijos en la capacidad, se extraen de las descripciones explícitas de los filtros de contexto; los filtros de tareas activas e inactivas no son contextos. La opción **Escribir otro contexto…** abre un campo de texto para escribir, por ejemplo, un sufijo admitido por un prefijo. El contexto actual se conserva aunque no coincida exactamente con una opción.

Los campos de inicio y vencimiento usan un calendario y un selector de hora independientes. **Elegir hora y zona** abre un popup de reloj de 24 horas para seleccionar horas, minutos y una zona horaria. **Aceptar** aplica ambas selecciones; **Cancelar** conserva los valores anteriores. La zona inicial es la del navegador y la selección se conserva en los borradores. La fecha, hora y zona elegidas se convierten a ISO 8601 en UTC antes de enviarse a la API. Los valores existentes se muestran en esa misma zona; los campos que no se han editado no se reenvían. Una hora inexistente por el cambio horario se rechaza. Si una hora se repite en otoño, se utiliza su primera ocurrencia. Los eventos y sus recuentos incluyen únicamente tareas sin completar, también las que esperan otro evento.

Después de confirmar una acción, el gestor actualiza primero los datos que están a la vista. Las demás vistas afectadas se recargan al abrirlas y no muestran acciones hasta tener datos actuales. Si llega otro cambio mientras una lectura está en curso, el gestor descarta la respuesta anterior y conserva pendiente la actualización más reciente.

El coste restante mostrado es el valor `totalCost` recibido del servidor. La interfaz no vuelve a descontar el trabajo registrado ni altera cantidades recibidas.

Los IDs declarados (`id` en JSON o `[id:: …]` en Markdown) se mantienen. Si falta uno, el backend calcula un respaldo MD5 a partir de la descripción, la ruta del archivo y la posición física; la primera escritura lo fija. Un ID duplicado impide identificar el recurso de forma única. La extensión conserva los IDs opacos recibidos, salvo `.` y `..`, que se rechazan antes de una petición porque podrían cambiar el destino al usarse como segmentos de ruta. Los mensajes antiguos de comando se rechazan sin contactar con el servidor.

El popup utiliza [timepicker-ui 4.4.0](https://github.com/pglejzer/timepicker-ui) y su plugin de zona horaria, incluidos localmente con licencia MIT. No carga scripts, estilos ni fuentes desde servicios externos. Las licencias y la procedencia están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Pruebas locales

Con Node.js 20 o posterior, ejecuta desde `extension/`:

```sh
node --test tests/*.test.cjs
```

La suite verifica el contrato de mensajes, el control de permisos, la validación de destinos HTTPS, el monitor de avisos, las vistas locales del gestor y popup y la agenda del popup en documentos aislados con un DOM de prueba. Comprueba reinicio del background, perfiles simulados, orden de persistencia antes de las alertas nativas, identidades repetidas, límites, huecos, cambios de historial, borrado local durante una lectura y fallos que impiden continuar hacia la agenda. Incluye formularios, operaciones, consultas explícitas, borradores y lecturas que terminan fuera de orden. También realiza una prueba de loopback con un certificado temporal para comprobar TLS, una identidad de servidor incorrecta y el rechazo de redirecciones a HTTP. No configura certificados del sistema ni sustituye las pruebas con ventanas y perfiles reales de Firefox y Chromium; los permisos, la confianza TLS y la separación de perfiles nativos siguen pendientes de esa comprobación.


Con Playwright y sus navegadores de prueba instalados, **node scripts/test-time-picker-browser.mjs** verifica el popup real en Chromium. Con **TIME_PICKER_BROWSER=firefox** se ejecuta en Firefox. Se puede indicar una instalación externa de Playwright mediante **PLAYWRIGHT_MODULE** y guardar capturas con **TIME_PICKER_SCREENSHOTS**. La prueba sirve los archivos reales con la CSP de la extensión y simula únicamente las APIs del navegador y las respuestas del gateway; verifica interacción, cancelación, conservación de borradores, retirada del popup al actualizar y conversión a UTC. No sustituye las comprobaciones de permisos con una extensión instalada.
