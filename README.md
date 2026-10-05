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

El popup muestra la primera tarea urgente activa de la agenda. Permite completarla o posponerla cinco minutos después de comprobar que su identidad sigue coincidiendo con la agenda actual. El indicador de fondo consulta `/agenda` con una alarma de cinco minutos; no lee ni consume notificaciones. Los errores de conexión muestran un distintivo accesible y se conservan al reiniciar el background.

Los IDs declarados (`id` en JSON o `[id:: …]` en Markdown) se mantienen. Si falta uno, el backend calcula un respaldo MD5 a partir de la descripción, la ruta del archivo y la posición física; la primera escritura lo fija. Un ID duplicado impide identificar el recurso de forma única. Por eso el popup vuelve a contrastar la identidad mostrada con la agenda antes de enviar una acción. Los IDs `.` y `..` se rechazan antes de cualquier petición porque podrían cambiar el destino al usarse como segmentos de ruta. El gestor completo aún no está adaptado a esta API: los comandos antiguos se rechazan sin enviar peticiones. El monitor antiguo de avisos permanece inerte y no elimina el historial guardado localmente.

## Pruebas locales

Con Node.js 20 o posterior, ejecuta desde `extension/`:

```sh
node --test tests/*.test.cjs
```

La suite verifica el contrato de mensajes, el control de permisos, la validación de destinos HTTPS, los errores y las respuestas inciertas mediante dobles locales. También realiza una prueba de loopback con un certificado de prueba temporal para comprobar TLS, una identidad de servidor incorrecta y el rechazo de redirecciones a HTTP. Esa prueba no configura certificados del sistema ni sustituye las pruebas de permisos y confianza en los navegadores.
