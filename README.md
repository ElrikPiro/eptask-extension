# Extensión nativa ElrikPiro

La extensión vive en `extension/` y usa HTML, CSS y JavaScript nativos. No comparte el runtime del frontend React y no requiere instalación de paquetes ni compilación. El manifiesto activo es `extension/manifest.json`; las variantes fuente `manifest.chromium.json` y `manifest.firefox.json` se copian manualmente antes de cargarla.

**Estado:** prototipo implementado con pruebas automatizadas aprobadas; la aceptación final y la distribución quedan pendientes de cargar y verificar ambas variantes en navegadores reales.

## Cargar en Chromium

1. Entra en `extension/` y copia `manifest.chromium.json` sobre `manifest.json`.
2. Abre `chrome://extensions` (o `edge://extensions`), activa el modo de desarrollador y elige **Cargar descomprimida**.
3. Selecciona la carpeta `extension/`.

## Cargar en Firefox

1. Entra en `extension/` y copia `manifest.firefox.json` sobre `manifest.json`.
2. Abre `about:debugging#/runtime/this-firefox`, elige **Cargar complemento temporal…** y selecciona `extension/manifest.json`.
3. El complemento temporal se conserva hasta cerrar Firefox; después hay que cargarlo de nuevo.

Al cambiar de navegador, copia la variante correspondiente al `manifest.json` raíz antes de cargar o recargar la carpeta. Las dos fuentes declaran MV3 y apuntan al mismo código local; Chromium usa un service worker y Firefox scripts de background.

## Servidor HTTP en Firefox MV3

La CSP MV3 predeterminada de Firefox incluye `upgrade-insecure-requests`, que convierte las peticiones `http:` en `https:`. Los tres manifests fijan explícitamente la política local `script-src 'self'; object-src 'self';` para que la URL HTTP configurada llegue al servidor tal como se escribió. Después de cambiar el manifest, recarga la extensión en `about:debugging` (o vuelve a cargar el complemento temporal) antes de conectar. Consulta la [documentación de CSP para WebExtensions de MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy#upgrade_insecure_network_requests_in_manifest_v3).

## Conectar y usar

Abre **Configuración**, escribe la URL HTTP absoluta del backend y el token Bearer, y pulsa **Probar y conectar**. La URL puede incluir el prefijo de un proxy inverso, por ejemplo `http://servidor:puerto/api`. La prueba consulta `/agenda`; solo cuando la respuesta tiene la estructura esperada queda habilitado el monitor.

El popup muestra la primera tarea de `active_urgent_tasks` y el gestor abre en una pestaña nueva. El monitor funciona en background con una alarma nominal de cinco minutos. Las páginas leen la configuración y el historial local de la extensión; abrirlas no consume la cola del backend.

**Un solo lector debe consumir la cola destructiva de notificaciones.** El frontend React conectado llama a `/notifications?mask_as_read=true` cada 20 segundos y el backend no separa colas por cliente. Antes de dejar activo el monitor de la extensión, cierra o desconecta el frontend web y detén cualquier otro consumidor de esa ruta. El frontend web no ofrece un control para desactivar únicamente este sondeo. Si varios lectores siguen conectados, pueden repartirse las notificaciones y el historial de la extensión no podrá recuperar las entradas que haya consumido otro cliente.

## Pruebas locales

Con Node.js 20 o posterior, ejecuta desde `extension/`:

```sh
node --test tests/*.test.cjs
```

La suite usa solo `node:test`, `node:vm` y mocks locales de las APIs WebExtension y `fetch`; no instala dependencias ni necesita el backend. Los resultados de ejecución y cualquier validación con navegadores reales se anotan en [INFORME_PRUEBAS.md](INFORME_PRUEBAS.md).

## Compatibilidad de identidad de tareas

El backend actual devuelve `TaskEntry.id` desde `getTaskUID()` al listar tareas, pero `get_task_information()` intenta leer `getId()` y serializa `id: "unknown"` en la información. El background conserva la identidad estable del listado: vuelve a leer la lista dentro del grupo FIFO, valida el índice y UID, solicita `/task_N`, y acepta ese `unknown` solo si descripción y contexto coinciden con la fila esperada. La respuesta que vuelve a la UI normaliza el ID a la UID del listado. Esta adaptación no cambia el contrato ni el backend.

Para una fila de una página distinta de la actual, el grupo empieza en `/list`, avanza con `/next` hasta la página solicitada y comprueba la página, el total y la UID antes de seleccionar o mutar. Así evita que otra página de esta extensión cambie la selección compartida del backend entre la validación de identidad y la acción. La cola FIFO solo serializa esta extensión: no aísla ni coordina la web React u otros clientes del backend.
