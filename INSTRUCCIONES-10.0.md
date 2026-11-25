# SG Corredores 10.0 RC1

Fecha de preparación: 25 de noviembre de 2026. Base pública: commit `745c82e197d66d12caaa7448bd09c8be911ae093` de `main`. El archivo principal distingue mayúsculas: `Index.html`. La versión anterior permanece en producción.

## Probar la demostración

Descarga `SG-Corredores-10-DEMO.html` y ábrelo en Chrome o Edge. En Android, si el visor de descargas solo muestra el archivo, usa **Abrir con Chrome** o abre el archivo en un ordenador. La demostración usa únicamente datos ficticios, se reinicia al recargar y no llama a Gmail, Supabase, OpenAI ni LiveKit.

1. En **Pedidos**, mantén pulsado **Puesto** en la fila de **Limón**. Introduce **1** para Salas y **2** para Grupo Fernández. Prueba un precio de **0,65** y pulsa **Guardar este reparto**.
2. Pulsa **Nuevo pedido → ½ palé** para revisar la entrada. El ejemplo de pimiento ya muestra **½ palé** en la hoja.
3. Abre **Más → Facturas**. La demostración muestra una diferencia de precio y una factura de 100 € con 20 € de abono y 80 € pendientes tras descontarlo.
4. En **Cargas → Imprimir hoja A4**, comprueba las columnas y las casillas de verificación. En **Avisos**, abre el aviso de diferencia y revisa el salto al registro.

## Qué contiene el paquete

| Archivo o carpeta | Contenido |
|---|---|
| `Index.html` y `index.html` | App de empleados y redirección compatible con la entrada anterior. |
| `portal.html`, `portal.webmanifest` | Zona Clientes y su acceso instalable. |
| `sg10/` | Interfaz principal, portal, operaciones, walkie, logotipo original y silueta original de Aguacatín. |
| `sw.js`, `version.json` | Caché de archivos de la app, datos de versión y apertura desde notificaciones. |
| `supabase/migrations/` | Migración aditiva de la base de datos existente, sin borrar registros. |
| `supabase/functions/` | Edge Functions nuevas. Las funciones antiguas siguen disponibles. |
| `supabase/setup/` | Tareas de entrega push, lectura de Gmail y anuncio de la publicación. |
| `supabase/tests/` | Prueba SQL de aislamiento, compras, avisos y abonos. |

## Publicar en el proyecto existente

La integración de GitHub devolvió HTTP 403 tanto al crear una rama como al escribir un objeto Git. La copia de lectura del código está en `SG-Corredores-main-antes-10.bundle`, incluida junto al código de entrega. El entorno no dispone de una copia descargable de la base de datos. Hazla antes de aplicar la migración. Las pruebas realizadas en el proyecto usaron una transacción revertida.

1. En GitHub, abre `SG-corredores/sg-corredores-app` como propietario. Guarda o publica una rama de respaldo desde `main`. Conserva la rama y el ZIP de esta entrega para revertir la web con un commit de reversión si fuera necesario.
2. En [Supabase → Backups](https://supabase.com/dashboard/project/zyzcnosaavvcijsmcowq/database/backups), comprueba el respaldo y su fecha. Si el plan no permite descargar un respaldo, usa Supabase CLI con acceso autorizado a la base para hacer un volcado de esquema y datos y guárdalo fuera del repositorio público. Exporta los archivos de Storage por separado si hay objetos que conservar. No subas datos o claves a GitHub.
3. En [Supabase → SQL Editor](https://supabase.com/dashboard/project/zyzcnosaavvcijsmcowq/sql/new), pega el archivo completo `supabase/migrations/20261125190000_sg10.sql` y pulsa **Run** una sola vez. Es una transacción: ante un error, revisa el mensaje antes de volver a ejecutarla. El SQL añadido usa las tablas que la app tiene en ese proyecto, así que aplicar solo los archivos web dejaría funciones incompletas.
4. En [Supabase → URL Configuration](https://supabase.com/dashboard/project/zyzcnosaavvcijsmcowq/auth/url-configuration), añade exactamente `https://sg-corredores.github.io/sg-corredores-app/portal.html` a las URL de redirección permitidas. Conserva las URL permitidas que ya existan.
5. Desde la carpeta `app/` extraída del ZIP, despliega las funciones con la CLI. Si prefieres Dashboard, crea las cinco funciones con los nombres exactos y pega su respectivo `index.ts`. Las tres rutas de usuario validan el token con Supabase Auth dentro de la función en cada petición. Los dos procesos de fondo comprueban un secreto de servidor.

```bash
supabase login
supabase functions deploy sg10-client-admin --project-ref zyzcnosaavvcijsmcowq --no-verify-jwt
supabase functions deploy sg10-aguacatin --project-ref zyzcnosaavvcijsmcowq --no-verify-jwt
supabase functions deploy sg10-walkie --project-ref zyzcnosaavvcijsmcowq --no-verify-jwt
supabase functions deploy sg10-push --project-ref zyzcnosaavvcijsmcowq --no-verify-jwt
supabase functions deploy sg10-gmail --project-ref zyzcnosaavvcijsmcowq --no-verify-jwt
```

6. Completa los secretos en Supabase. Guarda **el mismo valor nuevo, largo y aleatorio** como `SG10_WORKER_SECRET` en Edge Functions y como `sg10_worker_secret` en Vault. Comprueba las claves VAPID existentes, mantenlas si ya funcionan. La clave pública del navegador debe corresponder a `VAPID_PRIVATE_KEY` y a las suscripciones. Revisa estos nombres de secreto:

| Para | Claves de servidor |
|---|---|
| Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `SG10_WORKER_SECRET` |
| Gmail automático | `SG10_GMAIL_WORKSPACE` (UUID de la fila de `sg_workspaces`), `SG10_GMAIL_OWNER` (UUID de la cuenta propietaria que autorizó Gmail), `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `OPENAI_API_KEY`, `SG10_WORKER_SECRET` |
| Gmail opcional | `SG10_GMAIL_ADDRESS` si el buzón autorizado es distinto del ya previsto, `SG10_INVOICE_MODEL` si se quiere otro modelo de extracción |
| Aguacatín | `OPENAI_API_KEY`; opcionales `SG10_FAST_MODEL` y `SG10_REASONING_MODEL`, con valores predeterminados `gpt-6.2-sol` y `gpt-6.2-astra` |
| Walkie | `LIVEKIT_URL` (wss), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` de tu instancia LiveKit |

7. Aplica `supabase/setup/activar_avisos_y_gmail.sql` cuando estén configurados los secretos. La entrega push consulta la cola cada 20 segundos. Gmail hace una lectura incremental de candidatos recientes, con reintentos y deduplicación. En la app, el administrador puede reautorizar el buzón en **Ajustes → Gmail de empresa**. La función de Gmail requiere acceso OAuth ya concedido al buzón de empresa.
8. En GitHub, copia **el contenido de `app/`** de este ZIP en la raíz del repositorio, respetando `Index.html` y `index.html`. Si usas Git, crea una rama desde el `main` actual, copia los archivos, revisa `git diff --check`, haz commit y abre el PR. No sustituyas el árbol completo por el ZIP si hay cambios posteriores en `main`. GitHub Pages debe publicar desde la raíz de `main`.
9. Cuando Pages muestre `10.0.0-rc.1` en `version.json`, abre la app con una cuenta de empleado y otra de cliente. Haz las pruebas funcionales sin usar facturas reales para borrar o editar registros. Para avisar a los usuarios de una versión ya disponible ejecuta `supabase/setup/anunciar_version.sql`.
10. En el teléfono, abre **Avisos → Activar push**, concede el permiso, cierra la app y genera una incidencia de prueba en un entorno de pruebas. En iPhone abre la app desde el acceso instalado en la pantalla de inicio. Comprueba además micrófono, cámara y walkie en dispositivos reales.

## Implementación y limitaciones verificables

- **Pedidos y compras.** Hoja diaria de tres columnas, acciones secundarias agrupadas, edición directa, texto y voz con revisión, guardado por lotes y precios por céntimos. El reparto crea compras individuales para el mismo pedido, acepta medias unidades, conserva el puesto y el precio y rechaza excesos al guardar el lote. Para una prueba aislada, usa el demo adjunto.
- **Comisiones y cargas.** Naya a 0,035 €/kg, Cotelo a 0,040 €/kg y excepciones de Ortega y Huerta. Tarifas adicionales y peso por caja por cliente/producto, impresión A4, periodos y revisión. Los datos de tara, IVA y precios se leen del registro. Las hojas de carga van por cliente y puesto en dos columnas. PDF mediante el diálogo de impresión. Sigue pendiente el envío automático del PDF aprobado por Gmail. El estado enviado registra un envío efectuado por el usuario.
- **Facturación.** Extracción PDF, revisión persistente y avisos de falta de pedido, diferencias e incidencias. El saldo de una factura resta los abonos aprobados y vinculados al original. La factura queda pendiente si faltan datos. El abono reduce el saldo de facturación. Los kilos y las comisiones se liquidan con las cargas confirmadas y se mantiene independiente el saldo de factura para no duplicar cargos. El portal muestra el resumen de facturas autorizadas. Falta publicar el PDF original en el portal y verificar OAuth y una recepción real.
- **Zona Clientes y galería.** Cuentas individuales vinculadas a empresa, pedido, historial, compras, facturas autorizadas y galería con fotos privadas y selección de destinatarios. Falta una bandeja dedicada para mensajería bidireccional.
- **Avisos, IA y voz.** Campana con historial, contador y preferencias. Push con colas y suscripciones reales cuando se activen la función y la tarea. Aguacatín enlaza con los dos modelos con una cuenta con correo. Las respuestas complejas leen datos autorizados. Los borradores se confirman antes de guardar. La voz sigue usando la integración de voz previa. Su acento y latencia se deben comprobar con el proveedor y los dispositivos. El walkie usa WebRTC a través de LiveKit y necesita un servidor y dos cuentas para la prueba operativa. El funcionamiento en segundo plano depende del dispositivo. La APK queda fuera de esta entrega.
- **Seguridad y capacidad.** Los accesos de cliente están separados de los de empleado. Se probó aislamiento con dos empresas y una cuenta de personal en una transacción revertida. La personalización de permisos por empleado y la prueba concurrente con 30 empleados y 50 empresas siguen pendientes. Tampoco hay verificación en iPhone físico.

## Pruebas de esta entrega

- Chromium en vista móvil de 390 px y en escritorio. Se abrió la hoja diaria, se comprobaron las tres columnas, se hizo una pulsación larga sobre Puesto, se guardó el reparto de ejemplo, se comprobó el botón de medio palé, se abrió la hoja imprimible y se comprobó el saldo de 80 € en facturas.
- Sintaxis de JavaScript, módulos, JSON y manifiestos. Se verificó que logotipo y Aguacatín coinciden byte por byte con los activos originales que incrustaba `Index.html`.
- En PostgreSQL del proyecto se ejecutaron la migración y datos ficticios dentro de una transacción revertida. Pasaron las pruebas de aislamiento de empresas, palés y fotos privados, repetición de peticiones sin duplicar, reparto de 2½ palés a dos proveedores, conservación de 0,65 €, rechazo de exceso, aviso de precio distinto, un abono aprobado que deja 80 € de 100 €, y bloqueo de un abono superior al saldo restante.
- Las cinco Edge Functions se entregan completas para desplegar. No se ha verificado una llamada real a los proveedores de voz, Gmail, Web Push, OpenAI o LiveKit con las nuevas funciones. Los dos procesos programados están preparados en SQL y todavía no se han activado en producción.

Para comprobar la migración en modo de ensayo, usa una rama de Supabase o concatena su SQL con `supabase/tests/sg10-transaction.sql` quitando las líneas finales `notify pgrst, 'reload schema';` y `commit;` de la migración y añadiendo `rollback;` al final de la consulta completa. Mantén el `begin;` al principio. Las comprobaciones incluyen escritura de filas ficticias y dependen de las tablas base de SG Corredores ya existentes.

Usa Linux o un directorio con distinción de mayúsculas y minúsculas al extraer `app/`. Allí `Index.html` y `index.html` son archivos distintos. En otros sistemas se puede preparar la rama y aplicar la actualización desde GitHub Codespaces.
