# toolshed: plan de implementación

## Qué cambia

`toolshed` es un servidor privado con herramientas para tus agentes. Arranca con `qr.create`, `pdf.merge` y `pdf.split`. Tiene un solo dueño, un contenedor, NestJS, SQLite y páginas HTML generadas por NestJS.

**Fuera de alcance:** usuarios, equipos, cobros, short URLs, OAuth, Redis y Postgres. OAuth entra solo si T11 demuestra que hace falta.

## Decisiones cerradas

| Decisión | Motivo |
| --- | --- |
| NestJS solo | 69 MB en reposo, un contenedor, sin build de web. |
| Dos puertos en un proceso | 4400 atiende a los agentes. 4401 atiende las páginas. El túnel solo conoce el 4400, así que el dashboard no puede salir a internet por una regla de rutas mal escrita |
| `html` con escape automático | Es la debilidad de NestJS solo: escapar a mano. Un template tag escapa todo por defecto |
| Cada PDF corre en un proceso hijo con tope | Un PDF de 291 KB subió el proceso a 585 MB y bloqueó el event loop. Con el tope, 5 de 5 se mataron en unos 82 ms, con un pico de 310 a 392 MB, y 5 de 5 PDFs buenos pasaron. |
| Un key por agente, solo hash | Es el modelo de los keys de agente de treg |
| Drizzle estable sobre `better-sqlite3` | Drizzle 0.45 no soporta `node:sqlite`. `better-sqlite3` es nativo, pero trae binarios para Linux y Alpine, así que no compila al instalar |

## Forma de los datos

```ts
type Tool = { id: ToolId; title: string; summary: string; tags: string[]; input: z.ZodObject; example: object; run(input, ctx): Promise<Result> }
type Key  = { id: KeyId; name: string; hash: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
type Pair = { state: 'pending'; code: string; agent: string; expiresAt: number } | { state: 'approved'; agent: string; expiresAt: number }
type File = { id: FileId; name: string; mime: string; bytes: number; expiresAt: number }
type Call = { at: string; keyId: KeyId; tool: ToolId; via: 'rest' | 'mcp'; ms: number; error: ErrorCode | null }
```

Configuración: `OWNER_PASSWORD`, `PUBLIC_URL`, `ADMIN_URL`, `DATA`. El proceso no arranca si falta `OWNER_PASSWORD`, `PUBLIC_URL` o `ADMIN_URL`.

## Orden y dependencias

```
T0 ─┬─ T1 ── T2 ──┐
    └─ T3 ─┬──────┴─ T4 ─┬─ T5 ──────────┐
           └─ T6 ────────┴─ T7 ── T8 ────┴─ T9 ── T10 ── T11
```

| PR | Cambio | Espera a | Puede tocar |
| --- | --- | --- | --- |
| T0 | Base y CI | nada | raíz, `src/main.ts`, `src/config.ts` |
| T1 | Herramientas puras | T0 | `src/tools/` |
| T2 | Proceso aislado | T1 | `src/runner/` |
| T3 | Keys, llamadas y archivos | T0 | `src/store/`, `src/<feature>/repository.ts`, `drizzle/` |
| T4 | API de agentes | T2, T3 | `src/agent/`, `src/main.ts` |
| T5 | MCP | T4 | `src/mcp/`, `src/main.ts` |
| T6 | Dashboard | T3 | `src/admin/`, `src/main.ts` |
| T7 | Conexión con código | T4, T6 | `src/pair/`, `src/admin/`, `src/agent/llms.ts` |
| T8 | Límites y limpieza | T7 | `src/limits/`, `src/store/`, `src/runner/`, `src/main.ts` |
| T9 | Docker | T5, T8 | `Dockerfile`, `compose.yml`, `scripts/` |
| T10 | Despliegue en tu red | T9 | servidor, `README.md` |
| T11 | URL pública y Grok Bot | T10 | túnel, `README.md` |

T1 y T3 son independientes y salen de `main`. T4 y T6 tocan `src/main.ts`: entran uno después del otro.

**Esperan tu revisión antes del merge:** T6 y T7, porque cambian lo que ves y usas.
**Esperan tu aprobación escrita:** T10 y T11. Escribe la acción exacta, por ejemplo "despliega toolshed en `<servidor>`".

## Reglas para todas las fases

- [ ] `npm run check` termina en 0. Corre tipos, lint y tests.
- [ ] Cada caja marcada lleva su evidencia en el PR: el comando y su salida.
- [ ] La base de rendimiento se mide en `main` antes del cambio, con 5 corridas alternadas, mediana y rango. Un número solo falla si la diferencia supera ese rango.
- [ ] Ningún key, código o contraseña aparece en logs, PRs o fixtures.
- [ ] El código del prototipo es referencia. No se copia sin tests.

---

## T0. Base y CI

**Depende de:** nada. **Archivos:** raíz, `src/main.ts`, `src/config.ts`.
**Cambio:** repo, TypeScript estricto, tests, lint, dos puertos con `GET /health` y configuración validada con Zod.
**Resultado:** `npm start` levanta 4400 y 4401.

- [ ] **Unit:** cada variable requerida que falta produce un error que la nombra. La configuración completa arranca.
- [ ] **Live:** `curl localhost:4400/health` y `curl localhost:4401/health` dan 200. Sin `OWNER_PASSWORD` el proceso termina con código distinto de 0.
- [ ] **Live:** un commit con un error de tipos deja el CI en rojo. Al revertirlo queda en verde.
- [ ] **Perf:** memoria anónima en reposo a los 10 s, 5 corridas, con `RssAnon` de `/proc/<pid>/status`. Guarda la base. Falla si la mediana pasa de 100 MB.

## T1. Herramientas puras

**Depende de:** T0. **Archivos:** `src/tools/`.
**Cambio:** registro `TOOLS` y las tres herramientas como funciones sin NestJS.
**Resultado:** un arreglo del que salen REST, MCP, `llms.txt` y la web.

- [ ] **Unit:** unir conserva el orden. Separar `["1-2","5"]` da dos archivos. Los rangos `0`, `3-2`, `9` de 5 páginas y `a` dan `bad_range` o `invalid_input`. Un archivo que no es PDF o está cifrado da `not_a_pdf`.
- [ ] **Unit:** cada `example` de `TOOLS` cumple su propio schema.
- [ ] **Live:** un script genera los archivos. `zbarimg` lee el texto exacto del QR, con acentos y con 2000 caracteres. `pdftotext` lee `A1,A2,B1,B2,B3`. `qpdf --check` termina en 0 en todas las salidas.
- [ ] **Live:** repite con tres PDFs reales públicos, que descarga el agente: un escaneo, uno con formularios y uno de más de 100 páginas. `pdfinfo` da el número de páginas esperado.
- [ ] **Perf:** unir dos PDFs de 10 MB con contenido copiado. La salida pesa más de 19 MB. Falla con mediana mayor a 500 ms.

## T2. Proceso aislado

**Depende de:** T1. **Archivos:** `src/runner/`.
**Cambio:** cada trabajo corre en un proceso hijo que recibe rutas de archivo. El padre lo mata a los 256 MB de RSS o a los 30 s. Corren 2 a la vez y esperan hasta 10 más.
**Resultado:** un PDF malo da un error y el servidor sigue.

- [x] **Unit:** error propio para `too_much_memory`, `timeout`, `busy` y `crashed`. Un trabajo bueno devuelve su resultado.
- [x] **Unit:** si el hijo muere a la mitad, no queda archivo de salida. La salida se escribe en una ruta temporal y luego se renombra.
- [x] **Live:** manda un PDF con un `ObjStm` comprimido que se expande a 300 MB, y otro a 600 MB. Responde `too_much_memory` en menos de 2 s, y `/health`, consultado cada 50 ms, nunca tarda más de 100 ms.
- [x] **Live:** con 13 trabajos lentos a la vez, 12 terminan y 1 recibe `busy`. Al final `pgrep -P <pid>` no muestra hijos.
- [x] **Live:** `kill -9` al padre con un trabajo en curso. No quedan hijos 5 s después.
- [x] **Perf:** unir dos PDFs de 10 MB con el proceso hijo contra la base de T1. Falla si agrega más de 200 ms. El prototipo tardó 124 ms en total, con la generación de los PDFs incluida.

## T3. Keys, llamadas y archivos

**Depende de:** T0. **Archivos:** `src/store/`, `src/<feature>/repository.ts`, `drizzle/`.
**Cambio:** SQLite con Drizzle y migraciones, keys con hash, registro de llamadas, archivos en disco y URLs firmadas.
**Resultado:** módulo de datos sin HTTP.

- [ ] **Unit:** un key creado autentica. Revocado o alterado, no. Revocar dos veces deja el mismo estado.
- [ ] **Unit:** una firma vencida, alterada, con otro `id` o con otro método se rechaza. Una válida pasa.
- [ ] **Unit:** `../`, rutas absolutas y bytes nulos como `file_id` dan `file_not_found`.
- [ ] **Live:** crea un key y busca su texto con `grep -r` en todo `DATA`. Cero resultados. `lastUsedAt` cambia al usarlo.
- [ ] **Live:** `kill -9` 20 veces mientras escribe. `PRAGMA integrity_check` da `ok` y los keys confirmados siguen.
- [ ] **Live:** abre una base de la versión anterior. Migra sin perder filas, y arrancar dos veces no cambia nada.
- [ ] **Perf:** autenticar con 100 keys y 100 000 llamadas guardadas. Falla con p99 mayor a 5 ms.

## T4. API de agentes

**Depende de:** T2, T3. **Archivos:** `src/agent/`, `src/main.ts`.
**Cambio:** en 4400, `/v1/tools`, `/v1/call/:id`, `/v1/uploads`, `/v1/me`, `/f/:id` y `/llms.txt`. Las subidas van directo a disco.
**Resultado:** un agente con key usa las herramientas con `curl`.

- [x] **Unit:** sin key y con key revocado da 401. Entrada inválida da 422 y nombra el campo. Un error interno no muestra su mensaje.
- [x] **Unit:** `llms.txt` lista cada herramienta de `TOOLS` y ninguna más.
- [x] **Live:** con `curl`, sube 2 PDFs, únelos, separa el resultado y descarga. `pdftotext` confirma las páginas.
- [x] **Live:** una subida de 51 MB da 413. Una cortada a la mitad no deja archivo.
- [x] **Live:** las descargas llevan `Content-Disposition: attachment` y `X-Content-Type-Options: nosniff`, también para SVG.
- [x] **Perf:** RSS del padre durante una subida de 50 MB. Falla si crece más de 30 MB.

## T5. MCP

**Depende de:** T4. **Archivos:** `src/mcp/`, `src/main.ts`.
**Cambio:** `/mcp` en 4400 con `@modelcontextprotocol/server` v2, una herramienta MCP por cada `Tool`, y `file_upload`.
**Resultado:** un cliente MCP se conecta con `Authorization: Bearer`.

- [x] **Unit:** la lista de herramientas sale de `TOOLS`. Un error de herramienta llega con `isError` y su código.
- [x] **Live:** el cliente oficial, en 2025-11-25 y en 2026-07-28, sube, une, separa y descarga.
- [x] **Live:** `tools/list` sin el header `MCP-Protocol-Version` da 200. Cubre el error reportado de Grok Bot.
- [x] **Live:** conecta Claude Code con `claude mcp add --transport http` en una configuración temporal. Pide "une estos dos PDFs" y revisa el resultado con `pdftotext`.
- [x] **Live:** el agente repite con los PDFs reales de T1, sin ayuda tuya: con un key de prueba los sube, une, separa y descarga por MCP. `pdfinfo` da las páginas esperadas y `qpdf --check` termina en 0. Al final revoca el key.
- [x] **Perf:** tamaño de `tools/list`. Falla arriba de 600 caracteres por herramienta.

## T6. Dashboard

**Depende de:** T3. **Archivos:** `src/admin/`, `src/main.ts`. **Espera tu revisión.**
**Cambio:** en 4401, login y las páginas Start, Tools, Keys y Activity, con el tag `html`.
**Resultado:** entras, creas un key, lo ves una vez y lo revocas.

- [x] **Unit:** `html` escapa `<script>`, comillas y atributos. Solo un valor marcado como HTML pasa sin escapar.
- [x] **Unit:** la sexta contraseña incorrecta en un minuto da 429. Pasado el minuto, la correcta entra.
- [x] **Live:** en Chromium: login, crear, copiar, recargar y revocar. El key no aparece tras recargar. Responde con `Cache-Control: no-store`.
- [x] **Live:** crea un key llamado `<img src=x onerror=alert(1)>`. Se ve como texto y no se ejecuta.
- [x] **Live:** un POST con otro `Origin`, o sin cookie, no cambia nada.
- [x] **Live:** en 4400, `/`, `/keys`, `/activity` y `/login` dan 404.
- [x] **Live:** capturas de las cuatro páginas a 390 px y 1200 px, sin scroll horizontal, en el PR.
- [x] **Perf:** `/keys` con 20 keys lista en Chromium local, 10 visitas. El prototipo dio 17 ms. Falla arriba de 100 ms.

## T7. Conexión con código

**Depende de:** T4, T6. **Archivos:** `src/pair/`, `src/admin/`, `src/agent/llms.ts`. **Espera tu revisión.**
**Cambio:** `/pair` y `/pair/token` en 4400. Aprobación en 4401, donde escribes el código. El servidor espera hasta 25 s por petición.
**Resultado:** pegas `set up toolshed: <PUBLIC_URL>/llms.txt` y el agente queda conectado.

- [x] **Unit:** pendiente, aprobado, vencido, usado y código incorrecto. Dos reclamos a la vez entregan un solo key.
- [x] **Unit:** el dashboard nunca lista los códigos pendientes.
- [x] **Live:** Claude Code, con solo `curl` permitido, se conecta y crea un QR en 5 de 5 intentos, con una aprobación cada uno y menos de 60 s. El prototipo dio 3 de 3 en 18 a 20 s.
- [ ] **Live:** repite una vez con Codex y una con Cursor. Anota cada paso que el agente hizo mal.
- [x] **Live:** 6 códigos incorrectos en un minuto bloquean el séptimo intento, aunque sea correcto.
- [x] **Perf:** 20 peticiones esperando a la vez. `/health` p99 falla arriba de 50 ms.

## T8. Límites y limpieza

**Depende de:** T7. **Archivos:** `src/limits/`, `src/store/`, `src/runner/`, `src/main.ts`.
**Cambio:** 60 llamadas por minuto por key, 5 `/pair` por minuto por IP, 2000 páginas por PDF, 5 GB en disco, archivos borrados a las 24 h y logs sin secretos. La IP sale de `CF-Connecting-IP` solo en 4400.
**Resultado:** un agente descontrolado no llena el disco.

- [x] **Unit:** la llamada 61 da 429 con `Retry-After`. Otro key sigue funcionando.
- [x] **Unit:** la limpieza borra lo vencido y conserva lo vigente. Correrla dos veces, o tras una caída, deja el mismo estado. También borra archivos sin fila y filas sin archivo.
- [x] **Live:** con el límite de disco en 20 MB, la subida que lo rebasa da 507 y la siguiente funciona después de limpiar.
- [x] **Live:** corre todos los flujos y busca el key, el código y la contraseña en los logs. Cero resultados.
- [x] **Perf:** RSS tras 1000 QR y 100 uniones. Falla si supera en más de 30 MB el valor tras las primeras 100 y 10.

## T9. Docker

**Depende de:** T5, T8. **Archivos:** `Dockerfile`, `compose.yml`, `scripts/`.
**Cambio:** imagen Node 24 Alpine, usuario sin root, sistema de archivos de solo lectura salvo `DATA` y `/tmp`, `mem_limit: 1g` (70 MB en reposo más dos picos de 392 MB), healthcheck y respaldo con `VACUUM INTO`.
**Resultado:** `docker compose up` lo levanta completo.

- [ ] **Unit:** `docker compose config -q` termina en 0. La imagen no contiene `.env` ni archivos de test.
- [ ] **Live:** `scripts/e2e.sh` repite las cajas live de T4 a T7 contra el contenedor.
- [ ] **Live:** Dos PDFs maliciosos a la vez dentro del contenedor. Ambos dan `too_much_memory`, y `RestartCount` sigue en 0.
- [ ] **Live:** `docker compose restart`. Los keys y la sesión siguen. Restaura un respaldo en una carpeta vacía y un key viejo autentica.
- [ ] **Perf:** memoria `anon` en reposo, 5 corridas. El prototipo dio 69 MB [63-71]. Falla arriba de 100 MB. Dos uniones de 20 MB a la vez fallan arriba de 600 MB.

## T10. Despliegue en tu red

**Depende de:** T9. **Espera tu aprobación escrita.**
**Cambio:** stack de Docker Compose en `<servidor>`. El 4401 va por el proxy de la red local en `<ADMIN_URL>`. El 4400 queda en `127.0.0.1`.
**Resultado:** abres el dashboard en tu red o por VPN.

- [ ] **Antes:** RAM, disco y puertos libres en el servidor. Copia de la configuración del proxy antes de editarla.
- [ ] **Unit:** `docker compose config -q` sin variables faltantes. `.env` con permisos 600 y fuera de git.
- [ ] **Live:** `curl` al dashboard da 200 con `ssl_verify=0`. Un `/probe-<hora>` aparece en los logs.
- [ ] **Live:** desde otro equipo de la red, el puerto 4400 no responde.
- [ ] **Live:** reinicio del servidor cuando tú lo decidas. `toolshed` vuelve solo.
- [ ] **Perf:** memoria en reposo y unión de dos PDFs de 10 MB en el servidor. Falla arriba de 120 MB o 2 s.
- [ ] **Vuelta atrás probada:** `docker compose stop` y quitar la ruta. Los demás servicios siguen respondiendo.

## T11. URL pública y Grok Bot

**Depende de:** T10. **Espera tu aprobación escrita.**
**Cambio:** agregas en el túnel `<PUBLIC_URL>` hacia `http://127.0.0.1:4400`. Creas el key "Grok Bot" y agregas el servidor en Grok Bot con Remote HTTPS y el header.
**Resultado:** Grok Bot usa tus herramientas.

- [ ] **Unit:** `llms.txt` público muestra `PUBLIC_URL` en las llamadas y `ADMIN_URL` solo para aprobar.
- [ ] **Live:** desde fuera de tu red, `/llms.txt` da 200, `/mcp` sin key da 401, y `/`, `/keys` y `/login` dan 404.
- [ ] **Live:** en Grok Bot, pide un QR y une dos PDFs de `/workspace`. Activity muestra las llamadas con el key "Grok Bot".
- [ ] **Live:** revoca ese key. La siguiente llamada falla y Claude Code sigue funcionando.
- [ ] **Live:** repite la conexión con código a través del túnel. La espera de 25 s no se corta.
- [ ] **Perf:** subida de 45 MB y 20 `/health` por el túnel. Falla si la subida se corta o el p50 pasa de 500 ms.

**Si Grok Bot rechaza el header:** usa la conexión con código desde su shell. El key pasa por el contexto del bot, así que es la segunda opción. Si tampoco sirve, se abre T12 con OAuth. No se construye antes.

---

## Terminado significa

- [ ] Todas las cajas marcadas, con evidencia.
- [ ] Claude Code y Grok Bot unen y separan PDFs reales durante una semana.
- [ ] En esa semana, `RestartCount` es 0 y ningún archivo vive más de 25 h.

## Lo que este plan no prueba

- Grok Bot real con header. Las fuentes se contradicen. Se sabe en T11.
- La velocidad en `<servidor>`. Los números vienen de un equipo con 24 núcleos.
- PDFs que aprovechen fallas de seguridad de `pdf-lib`. El proceso hijo limita memoria y tiempo, pero no bloquea red ni archivos.
- Los topes de 60 llamadas, 5 GB y 24 h son una propuesta, no una medición.
