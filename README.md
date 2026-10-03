# Extensión nativa ElrikPiro

La extensión vive en `extension/` y usa HTML, CSS y JavaScript nativos. No comparte el runtime del frontend React y no requiere instalación de paquetes ni compilación. El manifiesto activo es `extension/manifest.json`; las variantes fuente `manifest.chromium.json` y `manifest.firefox.json` se copian manualmente antes de cargarla.

**Estado:** prototipo implementado con suite automatizada aprobada. Compatibilidad validada en **Firefox 140.13.0esr y Chromium 150+**; no se afirma compatibilidad con versiones anteriores.

## Cargar en Chromium

1. Entra en `extension/` y copia `manifest.chromium.json` sobre `manifest.json`.
2. Abre `chrome://extensions` (o `edge://extensions`), activa el modo de desarrollador y elige **Cargar descomprimida**.
3. Selecciona la carpeta `extension/`.

## Cargar en Firefox

1. Entra en `extension/` y copia `manifest.firefox.json` sobre `manifest.json`.
2. Abre `about:debugging#/runtime/this-firefox`, elige **Cargar complemento temporal…** y selecciona `extension/manifest.json`.
3. El complemento temporal se conserva hasta cerrar Firefox; después hay que cargarlo de nuevo.

Al cambiar de navegador, copia la variante correspondiente al `manifest.json` raíz antes de cargar o recargar la carpeta. Las dos fuentes declaran MV3 y apuntan al mismo código local; Chromium usa un service worker y Firefox scripts de background.

## Transporte

El soporte HTTPS está pendiente de implementación.

## Configuración

La página **Configuración** contiene el endpoint, el token Bearer y la acción **Probar y conectar**. La prueba consulta `/agenda`; solo cuando la respuesta tiene la estructura esperada queda habilitado el monitor.

El popup muestra la primera tarea de `active_urgent_tasks` y el gestor abre en una pestaña nueva. El monitor funciona en background con una alarma nominal de cinco minutos. Las páginas leen la configuración y el historial local de la extensión; abrirlas no consume la cola del backend.

## Indicador y acciones rápidas

**Estado:** implementación integrada y suite local aprobada con mocks (4 archivos de prueba, 0 fallos). Compatibilidad validada en Firefox 140.13.0esr y Chromium 150+.

La extensión muestra un badge de acción con un punto textual cuando una lectura válida de `/agenda` encuentra urgentes activas y permite completar o posponer cinco minutos la primera urgente mostrada desde el popup. Se intenta mostrar el punto rojo sobre fondo transparente con las APIs nativas de color del badge; si el navegador no admite ese ajuste o lo rechaza, se usa fondo rojo. El indicador se consulta con una alarma independiente de cinco minutos; esa lectura usa `/agenda` y nunca consume `/notifications`, por lo que el monitor de notificaciones mantiene su propio ciclo. La conexión, una lectura del popup, una acción y la desconexión también actualizan o limpian el indicador. Los mocks validan colores y fallback; la apariencia se ha validado en Firefox 140.13.0esr y Chromium 150+.

Las acciones envían la identidad mostrada (`id`, `description` y `context`) al background. Este vuelve a leer la agenda y recorre el listado paginado dentro de un grupo FIFO para localizar la fila coincidente antes de seleccionar y mutar. También exige que la respuesta de selección coincida en descripción y contexto aunque el ID sea conocido; el backend puede reenumerar IDs JSON y compartir la selección con otros clientes. Si la tarea cambió, no está en el listado vigente o no se puede identificar de forma única, la acción se rechaza sin mutar; si los filtros del gestor ocultan esa urgente, vuelve al gestor y actualiza o ajusta allí los filtros. El snooze envía al backend exactamente `5m`.

La estabilidad del ID depende del proveedor del backend. En el proveedor JSON, TaskProvider reenumera desde cero las tareas no completadas cada vez que reconstruye la lista. En el proveedor Obsidian, ObsidianTaskModel calcula un MD5 a partir de la descripción, la ruta del archivo y la línea; cambios en esos valores pueden cambiarlo. Por eso la extensión vuelve a comprobar los tres campos de identidad contra agenda y listado antes de actuar. Además, la selección y la página son compartidas por el gestor web y otros clientes. El grupo FIFO evita que se intercalen operaciones de las páginas de esta extensión, pero el backend actual no ofrece una acción atómica por UID que evite una carrera con clientes externos.

La coordinación automática de consumidores está pendiente de implementación. **Un solo lector debe consumir la cola destructiva de notificaciones.** El frontend React conectado llama a `/notifications?mask_as_read=true` cada 20 segundos y el backend no separa colas por cliente. Antes de dejar activo el monitor de la extensión, cierra o desconecta el frontend web y detén cualquier otro consumidor de esa ruta. El frontend web no ofrece un control para desactivar únicamente este sondeo. Si varios lectores siguen conectados, pueden repartirse las notificaciones y el historial de la extensión no podrá recuperar las entradas que haya consumido otro cliente.

## Pruebas locales

Con Node.js 20 o posterior, ejecuta desde `extension/`:

```sh
node --test tests/*.test.cjs
```

La suite usa solo `node:test`, `node:vm` y mocks locales de las APIs WebExtension y `fetch`; no instala dependencias ni necesita el backend. La compatibilidad validada cubre Firefox 140.13.0esr y Chromium 150+.

## Compatibilidad de identidad de tareas

El backend devuelve `TaskEntry.id` desde `getTaskUID()` en agenda y listado, pero la semántica del ID depende del modelo: `TaskProvider` JSON usa un índice que vuelve a enumerar al reconstruir la lista; `ObsidianTaskModel` usa un MD5 derivado de descripción, archivo y línea. No se presupone que todos los IDs sean índices ni que sean durables entre cambios. Además, `get_task_information()` intenta leer `getId()` y serializa `id: "unknown"` en la información. El background vuelve a leer el listado en el grupo FIFO, valida la identidad de la fila para esa instantánea, solicita `/task_N` y acepta `unknown` solo si descripción y contexto coinciden con la fila esperada. La respuesta devuelve el ID verificado del listado actual, sin presentarlo como identificador permanente. Esta adaptación no cambia el contrato ni el backend.

Para una fila de una página distinta de la actual, el grupo empieza en `/list`, avanza con `/next` hasta la página solicitada y comprueba la página, el total y el ID devuelto para la fila antes de seleccionar o mutar. Así evita que otra página de esta extensión cambie la selección compartida del backend entre la validación de identidad y la acción. La cola FIFO solo serializa esta extensión: no aísla ni coordina la web React u otros clientes del backend.

## Custodia del token en el monitor

El monitor oculta coincidencias exactas del token en mensajes y timestamps antes de guardarlos en el historial local y antes de generar avisos nativos. Las descripciones de los recordatorios `alert` se redactan antes de truncarse para el aviso. Esto evita exponer la credencial si el backend la incluye en esos campos; la autenticación sigue usando el token configurado. La redacción se aplica al contenido nuevo recibido por el monitor.
