# Extensión nativa ElrikPiro

La extensión vive en `extension/` y usa HTML, CSS y JavaScript nativos. No comparte el runtime del frontend React y no requiere instalación de paquetes ni compilación. El manifiesto activo es `extension/manifest.json`; las variantes fuente `manifest.chromium.json` y `manifest.firefox.json` se copian manualmente antes de cargarla.

## Cargar la extensión

En Chromium, copia `manifest.chromium.json` sobre `manifest.json`, abre `chrome://extensions` o `edge://extensions`, activa el modo de desarrollador y elige **Cargar descomprimida**. Selecciona la carpeta `extension/`.

En Firefox, copia `manifest.firefox.json` sobre `manifest.json`, abre `about:debugging#/runtime/this-firefox`, elige **Cargar complemento temporal…** y selecciona `extension/manifest.json`. El complemento temporal se conserva hasta cerrar Firefox; después hay que cargarlo de nuevo.

Al cambiar de navegador, copia la variante correspondiente al `manifest.json` antes de cargar o recargar la carpeta. Chromium usa un service worker y Firefox scripts de background. La suite automatizada cubre las APIs con dobles locales y Node; todavía no valida en una instalación nativa de Firefox o Chromium los diálogos de permisos ni sus almacenes de certificados.

## Conexión segura

En **Configuración**, introduce una dirección HTTPS del servidor, un token Bearer y un tiempo de espera. La extensión normaliza la ruta para usar `/api/v1`. Rechaza direcciones HTTP, credenciales en la URL, consultas, fragmentos, segmentos codificados que cambien la ruta y prefijos duplicados.

Al elegir **Probar y conectar**, el navegador solicita permiso para acceder al host HTTPS configurado. El permiso se pide desde esa acción del usuario y se comprueba antes de cada solicitud. Si se deniega o se revoca, la conexión queda desactivada. El background es el único componente que realiza peticiones; envía el token como `Authorization: Bearer` solo al origen y a la ruta API validados. Las solicitudes omiten credenciales del navegador, no siguen redirecciones y no se guardan en caché.

El token se conserva en el almacenamiento local de la extensión. Los errores remotos se reducen a mensajes seguros antes de guardarlos o mostrarlos; los datos de recursos, como IDs y enlaces HAL, se mantienen intactos para no cambiar su identidad.

La conexión comprueba que el servidor responde con el recurso HAL raíz esperado. Las lecturas y mutaciones usan operaciones tipadas de la API. Si se pierde la respuesta de una mutación, la interfaz la marca como incierta y no la reenvía automáticamente.

## Popup e indicador

El popup muestra la primera tarea urgente activa de la agenda. Permite completarla o posponerla cinco minutos después de volver a consultar la agenda y comprobar el ID mostrado. Si cambia la conexión mientras esa consulta está en curso, no envía la operación al nuevo destino. Los errores de conexión muestran un distintivo accesible y se conservan al reiniciar el background.

## Avisos y copia local

El background lee el historial de avisos mediante `GET` con una alarma cada cinco minutos. Valida la identidad del historial, los números de secuencia, las marcas de tiempo y los límites de retención antes de guardar la respuesta en el almacenamiento local de ese perfil. La identidad de cada aviso combina el ID del historial y su secuencia, por lo que dos avisos con el mismo texto siguen siendo distintos. El background guarda las entradas y el cursor antes de mostrar una notificación nativa; los avisos nuevos de un ciclo se agrupan en una sola alerta.

El servidor conserva una ventana limitada y puede retirar entradas antiguas. Si el cliente detecta un salto de secuencia dentro del mismo historial, la copia local muestra el rango que no recibió. Un cambio de servidor o de identidad de historial conserva las entradas antiguas con su origen y no las atribuye al historial nuevo. El dispositivo conserva como máximo 1024 avisos; si se alcanza ese límite, mantiene los más recientes e indica que la copia local se truncó. Un fallo al leer o validar el historial no se interpreta como una agenda vacía ni permite continuar con la comprobación de tareas urgentes.

La comprobación de tareas urgentes solo se ejecuta cuando una lectura válida confirma que no hay avisos nuevos. Usa la zona horaria y la agenda anunciadas por el servidor; una alerta nativa de tarea requiere el contexto exacto `alert`.

El gestor y el popup muestran la copia guardada sin consultar la red. **Vaciar** borra solo la copia local de ese perfil y los registros locales antiguos; conserva el cursor y la identidad del servidor para evitar repetir alertas ya recibidas. No modifica ni reconoce los avisos del servidor ni elimina las notificaciones que ya creó el sistema operativo. Cada perfil del navegador mantiene su propia copia.

## Gestor

La página principal carga tareas, agenda, estadísticas, eventos, estrategias y proyectos mediante lecturas HAL autenticadas. Cada instancia del gestor mantiene sus propios filtros, búsqueda, paginación, algoritmo, heurística, selección y formularios; una vista no cambia las consultas de otra instancia. La selección de una tarea desde la agenda pide su detalle por ID incluso si no aparece en la página actual. Un ID ausente o ambiguo produce un error visible y no selecciona otra fila.

Las acciones y sus campos proceden de las capacidades anunciadas por cada recurso. Las ediciones de una tarea combinan cambios de propiedades y esfuerzo en una sola operación. Los campos de identidad, estado y esfuerzo derivado no se envían como cambios. Abrir otro recurso, actualizar datos, recibir una invalidación o volver a la página no cambia el destino ni descarta un borrador; se puede cargar la versión remota conservando el borrador o descartarlo de forma explícita. Las mutaciones confirmadas actualizan las vistas con sus propios parámetros. Los resultados inciertos no se reenvían automáticamente.

El coste restante mostrado es el valor `totalCost` recibido del servidor. La interfaz no vuelve a descontar el trabajo registrado ni altera cantidades recibidas.

Los IDs declarados (`id` en JSON o `[id:: …]` en Markdown) se mantienen. Si falta uno, el backend calcula un respaldo MD5 a partir de la descripción, la ruta del archivo y la posición física; la primera escritura lo fija. Un ID duplicado impide identificar el recurso de forma única. La extensión conserva los IDs opacos recibidos, salvo `.` y `..`, que se rechazan antes de una petición porque podrían cambiar el destino al usarse como segmentos de ruta. Los mensajes antiguos de comando se rechazan sin contactar con el servidor.

## Pruebas locales

Con Node.js 20 o posterior, ejecuta desde `extension/`:

```sh
node --test tests/*.test.cjs
```

La suite verifica el contrato de mensajes, el control de permisos, la validación de destinos HTTPS, el monitor de avisos, las vistas locales del gestor y popup y la agenda del popup en documentos aislados con un DOM de prueba. Comprueba reinicio del background, perfiles simulados, orden de persistencia antes de las alertas nativas, identidades repetidas, límites, huecos, cambios de historial, borrado local durante una lectura y fallos que impiden continuar hacia la agenda. Incluye formularios, operaciones, consultas explícitas, borradores y lecturas que terminan fuera de orden. También realiza una prueba de loopback con un certificado temporal para comprobar TLS, una identidad de servidor incorrecta y el rechazo de redirecciones a HTTP. No configura certificados del sistema ni sustituye las pruebas con ventanas y perfiles reales de Firefox y Chromium; los permisos, la confianza TLS y la separación de perfiles nativos siguen pendientes de esa comprobación.
