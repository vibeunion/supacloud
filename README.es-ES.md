# SupaCloud

[Español](#español) | [English](#english) | [中文](#chinese)

---

<a name="español"></a>
## Español

**SupaCloud** es una plataforma PaaS multi-tenant ultrapotente y de próxima generación para el autoalojamiento de Supabase. Construida sobre **Pigsty**, permite ejecutar múltiples proyectos Supabase aislados de forma eficiente en un único servidor.

### Características Clave

- **Arquitectura Multi-tenant**: Ejecuta múltiples proyectos Supabase aislados con infraestructura compartida
- **Management API**: API REST completa (60+ endpoints) para la gestión del ciclo de vida de proyectos
- **Consola Web**: Panel de gestión moderno con SvelteKit y autenticación
- **Flujos de base de datos oficiales de Supabase CLI**: El adaptador de compatibilidad ejecuta flujos directos `--db-url` incluyendo `db push`, `migration list`, `db pull` y `gen types`
- **Herramientas CLI**: `supacloud-cli` para usuarios de proyectos, `supacloud-admin` para operadores de servidores, y opcionalmente `supacloudctl` como el despachador local unificado
- **SupaCloud Pages**: Alojamiento de sitios web estáticos con despliegue automático vía GitHub webhook
- **Potenciado por Pigsty**: PostgreSQL empresarial con monitoreo integrado (Grafana)
- **Instalación con un clic**: Configuración totalmente automatizada mediante `install.sh`
- **Almacenamiento JuiceFS**: Basado en PostgreSQL Large Objects (LO) para metadatos ultraligeros
- **Gateway Caddy**: HTTPS automático, publicación de rutas impulsada por Admin API, limitación de tasa programable, cabeceras de seguridad y CORS
- **Motor de auto-escalado**: Escalado vertical y horizontal basado en reglas y métricas en tiempo real
- **Bun Edge Runtime**: Bun.js + Elysia Worker Pool para Edge Functions, con shim de compatibilidad Deno integrado para código heredado
- **Registros en tiempo real SSE**: Streaming de Server-Sent Events para seguimiento de logs en vivo vía `journalctl --follow`
- **Cola de trabajo nativa**: Trabajador asíncrono puro basado en PostgreSQL LISTEN/NOTIFY de Bun.js para inferencia de IA y eventos MQTT
- **Notificaciones de tareas WebSocket**: Push de progreso de tareas en tiempo real vía WebSocket nativo de Bun
- **Degradación elegante de DB**: Reintento con retroceso exponencial + 503 Service Unavailable en fallos transitorios de BD
- **Plan de control endurecido**: Lecturas de gestión de funciones autenticadas, subidas de uso único firmadas, paginación defensiva y análisis seguro de metadatos de almacenamiento
- **Precalentamiento de Edge Functions**: Cero arranque en frío mediante preimportación de módulos de trabajo al desplegar
- **Proveedor OAuth/OIDC por proyecto**: Migración OAuth 2.1 / OIDC por proyecto con claves de firma ES256, descubrimiento, JWKS, endpoints authorize/token/userinfo y CRUD de clientes OAuth
- **OAuth para China**: Integración de inicio de sesión integrada para WeChat, Alipay y DingTalk
- **Integración CI/CD**: GitHub webhook para despliegues automatizados
- **Pruebas exhaustivas**: 400+ pruebas unitarias, de integración y de regresión estructural

### SupaCloud Lite

**SupaCloud Lite** es la edición nativa de Bun y de un solo proyecto de SupaCloud. Ejecuta cargas de trabajo compatibles con PostgreSQL en proceso con PGlite y expone los protocolos Supabase utilizados por `@supabase/supabase-js`: REST, Auth, Storage, Realtime y Edge Functions. Está pensado para desarrollo local, despliegues pequeños de un solo proyecto y aplicaciones que desean un backend compatible con Supabase sin Docker.

Lite Auth está integrado en el mismo proceso Bun; no instala ni lanza un sidecar GoTrue. Está habilitado por defecto y puede deshabilitarse con `[auth] enabled = false` en `supabase/config.toml`, lo que desactiva `/auth/v1/*`. Utiliza la plataforma completa cuando se requiere un runtime GoTrue independiente o compatibilidad completa con GoTrue.

Utiliza la plataforma completa SupaCloud cuando necesitas multi-tenancy de proyectos, una API de gestión o consola web, infraestructura Pigsty compartida, operaciones de plataforma y gestión del ciclo de vida del frontend alojado. Lite deliberadamente no proporciona un plan de control de multi-proyectos ni Supabase Studio; cada proceso Lite es propietario de un proyecto y su propio directorio de estado.

| Necesidad | Elige |
| --- | --- |
| Runtime local o de un solo proyecto sin Docker | SupaCloud Lite |
| Plataforma multi-tenant, controles de operador o gestión de infraestructura de producción | SupaCloud |

Lite requiere Bun 1.3+ y mantiene su base de datos, almacenamiento y secretos generados por defecto bajo `.supacloud-lite/` en el directorio del proyecto. Inícialo con la estructura de proyecto existente de la CLI de Supabase:

```bash
bun add @supacloud/lite
bunx supacloud-lite start
bunx supacloud-lite keys
```

Luego usa la clave anónima impresa con el cliente estándar:

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)
```

Consulta la [documentación de SupaCloud Lite](./packages/supacloud-lite/README.md) para comandos CLI, configuración de almacenamiento/S3, límites de compatibilidad, guía de migración y límites de despliegue.

Para despliegues persistentes de Lite, actualiza la dependencia `@supacloud/lite` fijada y ejecuta `supacloud-lite upgrade`. El comando crea una instantánea portable de base de datos/almacenamiento/secretos antes de aplicar las migraciones pendientes. También están disponibles `snapshot create` y `snapshot restore` con cierre por defecto para migración de host y preparación de rollback.

### SupaCloud vs Supabase

SupaCloud se entiende mejor como un **plan de control multi-tenant autoalojado para proyectos estilo Supabase**, no como un clon de Supabase Cloud.

Versión corta:

- **SupaCloud**: lo mejor cuando quieres ejecutar muchos proyectos aislados en tus propios servidores con una API de operador integrada, consola web, gestión del ciclo de vida del proyecto, superficie de cola de tareas y alojamiento de frontend.
- **Supabase Cloud**: lo mejor cuando quieres una plataforma totalmente gestionada, copias de seguridad/PITR alojadas, explorador de logs alojado y branching alojado.
- **Supabase Self-Hosted**: lo mejor cuando quieres la pila upstream oficial en tu propia infraestructura y estás cómodo operando Docker/servicios directamente.

Comparación detallada de funciones:

- [docs/supacloud-vs-supabase.md](./docs/supacloud-vs-supabase.md)

### Arquitectura

```text
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│            Bun + Elysia + TypeScript + Auto-scaling          │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ StorageSvc │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ GatewaySvc │  │ ScalingSvc │  │ BackupSvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ RouterSvc  │  │ FrontendSv │  │ DeploySvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                   Shared Infrastructure                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Caddy    │  │  JuiceFS   │            │
│  │  (Pigsty)  │  │  Gateway   │  │  (PG-LO)   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                  ┌────────────┐                             │
│                  │  Grafana   │                             │
│                  │ (Monitor)  │                             │
│                  └────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### Inicio Rápido

#### Requisitos

| Elemento | Mínimo | Recomendado |
|------|---------|-------------|
| CPU | 2 núcleos | 4+ núcleos |
| RAM | 2GB | 4GB+ |
| Disco | 40GB | 100GB+ SSD |
| SO | CentOS 9, Ubuntu 22/24, Debian 12 | CentOS 9 |

#### Puntos de entrada para humanos

**CLI de usuario de proyecto**

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli frontend list --ref <project-ref>
```

`supacloud-cli` es por defecto específico del proyecto y se vincula automáticamente desde el `.env` del espacio de trabajo actual cuando está disponible.
No existe un alias de compatibilidad de CLI de proyecto llamado `supacloud`: ese nombre está reservado para el binario del servidor compilado en `/usr/local/bin/supacloud`. Usa `supacloudctl` solo para el despachador local unificado opcional.

- `SUPABASE_URL` o `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` o `SUPACLOUD_API_TOKEN`

Los agentes de IA deben instalar la Skill de migración-primero enviada con la CLI:

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

**CLI de administrador del servidor**

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project create --name my-app
```

Usa `supacloud-admin` para instalación, actualizaciones, operaciones de runtime de tenant y control del ciclo de vida de proyectos a nivel de plataforma.

#### Instalación del servidor

**Instalación con un clic (Recomendado)**

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
```

El propio bootstrap raíz siempre se obtiene del repositorio oficial. Las descargas de Release/API intentan GitHub directamente primero y usan `SUPACLOUD_GITHUB_PROXY` solo como alternativa explícita:

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**Instalación desde código fuente/entorno de desarrollo (solo artefactos locales)**

Los hosts de producción deben usar el flujo `setup.sh` verificado de un clic mostrado arriba. Una copia del código fuente no tiene artefactos de Release, por lo que debes construir primero todos los componentes requeridos y optar explícitamente al modo de artefacto local:

```bash
# 1. Clonar repositorio
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. Construir Management API, Edge Runtime, pgredis-runtime, Caddy y Web Console
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
bun --cwd packages/pgredis-runtime install
bun --cwd packages/pgredis-runtime run build:linux
bun --cwd packages/web-console install --frozen-lockfile
bun --cwd packages/web-console run build
mkdir -p .local/bin dist
GOBIN="$PWD/.local/bin" go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
PATH="$PWD/.local/bin:$PATH" OUT_DIR="$PWD/dist" bash scripts/build_supacloud_caddy.sh

# 3. Configurar e instalar desde las salidas de construcción local validadas
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 1.2.3.4 --domain api.example.com --s3 juicefs

# 4. Habilitar CLI
source /etc/profile.d/supacloud.sh
```

**Actualizaciones de producción**

Los servidores de producción se actualizan reemplazando el binario Linux publicado en `/usr/local/bin/supacloud`; no necesitan `git pull` el código fuente de la aplicación durante las actualizaciones normales.

```bash
sudo supacloud upgrade --yes
```

Las descargas de instalación y actualización son directas primero. Configura un proxy de confianza solo cuando se requiere una alternativa explícita:

```bash
sudo SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example supacloud upgrade --yes
```

Los artefactos de release requieren verificación SHA256 de la misma release y atestación de procedencia de GitHub build. `SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` es un modo de emergencia break-glass que retiene la verificación SHA256 pero no debe ser una configuración de instalación normal.

Activos de release publicados:

- `supacloud-linux-amd64` y `supacloud-linux-arm64` son los binarios de instalación/actualización de producción.
- `supacloud-macos-amd64` y `supacloud-macos-arm64` se publican para desarrollo local y diagnóstico.

**Docker Compose Autoalojado (PostgreSQL 18)**

```bash
cd docker/self-host
python3 init-env.py --public-url https://api.example.com --studio-url https://studio.example.com --output .env
docker compose up -d --build
```

La pila de compose está aislada bajo [`docker/self-host`](/Volumes/Data/workspace/supacloud/docker/self-host) e incluye una imagen PostgreSQL 18 con extensiones comunes preinstaladas.

Para la verificación de compatibilidad Pigsty 4.4/Supabase específica de Docker y la ruta de actualización con copia de seguridad previa, consulta [`docs/upgrade-postgres-docker-4.4.md`](./docs/upgrade-postgres-docker-4.4.md). No ejecutes el script de actualización nativo de Pigsty contra un volumen de datos Docker.

Para el despliegue de la imagen PostgreSQL publicada en TrueNAS SCALE `Custom App`, consulta [`docker/self-host/TRUENAS.md`](./docker/self-host/TRUENAS.md).

**Opciones de CLI disponibles:**
| Opción | Descripción | Ejemplo |
|--------|-------------|---------|
| `--ip` | IP interna del servidor | `--ip 10.0.0.5` |
| `--domain` | Dominio API/Público | `--domain supa.com` |
| `--studio` | Dominio del panel Studio| `--studio studio.com`|
| `--s3` | Tipo de almacenamiento | `juicefs`, `minio`, o `external` |
| `--password`| Contraseña maestra | `--password mysecret` |

### Gestión

#### CLI de usuario: `supacloud-cli`

El comando `supacloud-cli` es por defecto específico del proyecto y está pensado para flujos de despliegue/construcción/logs/base de datos en torno a un solo proyecto:

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli project tasks
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref <ref> --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref <ref> --dir supabase/migrations --dry_run
supacloud-cli auth list_providers --ref <ref>
supacloud-cli frontend list --ref <ref>
supacloud-cli edge_functions list --ref <ref>
supacloud-cli storage list_buckets --ref <ref>
```

Para SQL complejo, consultas pgvector y bloques de transacción de solicitud única, prefiere `--file` en lugar de SQL en línea escapado por shell.

```sql
BEGIN;
INSERT INTO audit_events(message) VALUES ('started');
INSERT INTO audit_events(message) VALUES ('finished');
COMMIT;
```

SupaCloud admite bloques de transacción dentro de una sola solicitud SQL y envuelve las migraciones en una transacción. No expone sesiones HTTP de transacción de larga duración como `/transaction/begin` y `/transaction/commit`; las transacciones largas del lado de la aplicación deben usar el DSN directo de Postgres con `pg`, `postgres.js` o controladores equivalentes.

Ejemplo de pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX documents_embedding_hnsw_idx
ON documents
USING hnsw (embedding vector_cosine_ops);

SELECT id, content
FROM documents
ORDER BY embedding <=> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

`supacloud-cli` intencionalmente no posee la instalación de la plataforma, actualizaciones, diagnósticos SSH, gestión del runtime de tenant, ni comandos destructivos del ciclo de vida del proyecto.

#### CLI de administrador: `supacloud-admin`

La CLI `supacloud-admin` es para operadores de servidor y plataforma:

```bash
supacloud-admin status
supacloud-admin ssh ping
supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
supacloud-admin ssh diagnose
supacloud-admin project list
supacloud-admin project create --name my-app
supacloud-admin project delete --ref <ref>
supacloud-admin project pause --ref <ref>
supacloud-admin platform metrics
```

#### Management API

La API REST se ejecuta en el puerto 9090 con documentación Swagger en `/swagger`.

```bash
# Crear proyecto
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "region": "local"}'

# Listar proyectos
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# Obtener claves API
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**Endpoints de la API Core:**

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/v1/projects` | Listar todos los proyectos |
| POST | `/v1/projects` | Crear proyecto |
| GET | `/v1/projects/:ref` | Obtener detalles del proyecto |
| PATCH | `/v1/projects/:ref` | Actualizar proyecto |
| DELETE | `/v1/projects/:ref` | Eliminar proyecto (soft) |
| POST | `/v1/projects/:ref/pause` | Pausar proyecto |
| POST | `/v1/projects/:ref/restore` | Restaurar proyecto |
| GET | `/v1/projects/:ref/status` | Obtener estado |
| GET | `/v1/projects/:ref/health` | Obtener salud |
| GET | `/v1/projects/:ref/dashboard/summary` | Resumen del panel con caché |
| POST | `/v1/projects/:ref/restart` | Reiniciar servicios |
| GET | `/v1/projects/:ref/settings` | Obtener configuración |
| PUT | `/v1/projects/:ref/settings` | Actualizar configuración |
| GET | `/v1/projects/:ref/api-keys` | Obtener claves API |
| POST | `/v1/projects/:ref/api-keys/rotate` | Rotar claves API JWT heredadas |
| POST | `/v1/projects/:ref/api-keys/rotate-opaque` | Rotar claves Publishable/Secret sin cambiar sesiones JWT |
| GET | `/v1/projects/:ref/auth/oauth-server` | Obtener estado OAuth/OIDC del proyecto |
| POST | `/v1/projects/:ref/auth/oauth-server/migrate` | Migrar proyecto a claves de firma OIDC |
| GET/POST/PUT/DELETE | `/v1/projects/:ref/auth/oauth-clients*` | CRUD de clientes OAuth para el runtime del proyecto |
| GET | `/v1/projects/:ref/types/typescript` | Generar tipos TS |
| PATCH | `/v1/projects/:ref/config/auth` | Configurar Auth y Proveedores |
| GET | `/v1/projects/:ref/secrets` | Listar Secretos de Edge Functions |
| POST | `/v1/projects/:ref/secrets` | Upsert Secretos |
| DELETE | `/v1/projects/:ref/secrets/:name` | Eliminar Secreto |

Los endpoints de lectura de gestión de funciones bajo `/v1/projects/:ref/functions*` requieren autenticación de service-role del proyecto o admin. Las invocaciones de runtime público permanecen en `/functions/v1/*` y continúan usando el modelo de autenticación estándar de funciones Supabase.

**Endpoints de la API Extendida:**

| Categoría | Endpoints | Descripción |
|----------|-----------|-------------|
| Base de datos | `/v1/projects/:ref/database/*` | Consulta SQL, inspección de esquema, migraciones, paginación defensiva |
| Auth | `/v1/projects/:ref/config/auth`, `/v1/projects/:ref/auth/*` | Proveedores OAuth, migración de proveedor OAuth/OIDC, WeChat/Alipay/DingTalk |
| Frontend | `/v1/projects/:ref/frontend/*` | Alojamiento Pages, despliegues, dominios personalizados |
| Webhook | `/v1/webhooks/github` | GitHub webhook para CI/CD auto-despliegue |
| Almacenamiento | `/v1/storage/*` | Gestión de buckets, subida de archivos, subidas firmadas de un solo uso, migración S3 |
| Extensiones | `/v1/extensions/*` | Marketplace de extensiones PostgreSQL |
| Escalado | `/v1/projects/:ref/scaling/*` | Actualización vertical y réplicas horizontales |
| Copias de seguridad | `/v1/projects/:ref/backups/*` | Copia de seguridad y restauración de BD |
| Monitor | `/v1/monitor/*` | Monitoreo y salud de BD |
| Seguridad | `/v1/security/*` | Reglas de firewall y certificados SSL |
| Despliegue | `/v1/deploy/*` | Despliegue de Edge Functions |
| Tareas | `/v1/projects/:ref/tasks/*` | Monitoreo de tareas en segundo plano, incluyendo modo de lista ligero `summary=true` |
| **Logs SSE** | `GET /v1/projects/:ref/logs/stream` | **Streaming de logs en tiempo real vía Server-Sent Events** |
| **Limitación de tasa** | `GET/PUT /v1/projects/:ref/gateway/rate-limit` | **Limitación de tasa programable por proyecto (política de ruta Caddy)** |
| **Rutas de gateway** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **Rutas Caddy personalizadas controladas (proxy, estático, redirección, cabeceras, CORS, prioridad)** |
| **WebSocket** | `ws://host/ws/tasks` | **Notificaciones de progreso de tareas en tiempo real** |

#### Cambio de Runtime

```bash
# Cambiar modo de despliegue de Edge Runtime
./switch.sh runtime embedded   # Gestionado por supacloud.service
./switch.sh runtime external   # Standalone supacloud-edge-runtime.service

# Cambiar backend de almacenamiento
./switch.sh storage juicefs    # o: minio, external

# Mostrar configuración actual
./switch.sh status
```

**Arquitectura de Edge Runtime:**

```
SupaCloud (:9090)          Edge Runtime (EDGE_RUNTIME_PORT, default :9005)
├── Management API    ←──  supacloud.service manages by default
├── Web Console            ├── Elysia Server
├── SSE Log Stream         ├── Worker Thread Pool (4 threads)
├── WebSocket /ws/tasks    ├── Deno Compat Shim
└── Static Assets (ETag)   ├── URL Import Plugin
                           └── /preheat (zero cold-start)

Edge Runtime parent ── internal capability ──► pgredis-runtime (:9010)
                                             ├── per-tenant PostgreSQL pool
                                             └── bounded L1 + LISTEN/NOTIFY

Caddy Gateway (Admin API-driven):
  Automatic HTTPS, route JSON publishing, security headers, rate limiting, CORS
  /api/*        → :9090
  /functions/*  → :9090 (sdk-proxy, async enqueue + sync relay)
```

SupaCloud nunca edita manualmente un Caddyfile en producción. La Management API mantiene la configuración completa de Caddy como JSON en memoria (`GatewayService`), y en cada cambio de ruta/limitación de tasa/certificado:
1. renderiza la configuración JSON completa de Caddy,
2. la valida con `caddy validate --config <tmp>`,
3. la recarga en caliente vía `POST /load` en la Admin API de Caddy (`CADDY_ADMIN_URL`, por defecto `http://127.0.0.1:2019`),
4. persiste atómicamente el JSON aplicado en `CADDY_CONFIG_PATH` para la hidratación al reiniciar, y deja un `DO-NOT-EDIT.txt` junto a él.

El Caddyfile empaquetado solo habilita el oyente de Admin API y un catch-all mínimo para el arranque; el enrutamiento de tenants, TLS, CORS y limitación de tasa son propiedad del JSON inyectado. `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` y `POST /v1/projects/:ref/gateway/config` son la superficie visible para el usuario que impulsa estas actualizaciones JSON.

El origen de arranque difiere según el modo de despliegue: las instalaciones systemd ejecutan `supacloud-caddy run --config /etc/supacloud/caddy/config.json` (solo JSON, sin Caddyfile, con un JSON inicial sembrado por `install.sh`); las pilas docker `self-host` y `dev` arrancan la imagen oficial `caddy` con un Caddyfile de solo arranque (`admin 0.0.0.0:2019` + `auto_https off` + un marcador de posición `503`), luego la Management API publica la configuración JSON completa vía `POST /load` una vez que está sana, reintentando con retroceso hasta que Caddy sea alcanzable. De cualquier manera, la configuración de enrutamiento en vivo es el JSON inyectado a través de la Admin API.

Además, la Management API ejecuta un `gateway-health.worker` periódico que sondea la Admin API de Caddy; cuando detecta una transición de inalcanzable a alcanzable (por ejemplo, Caddy reiniciado bajo systemd o el contenedor reiniciado bajo docker), dispara `rebuildAllTenantConfigs()` para republicar el JSON de rutas completo, manteniendo la configuración en vivo consistente con el estado en memoria, lo que da a ambos modos de despliegue capacidad de autocuración.

Consulta [docs/gateway-customization.md](docs/gateway-customization.md) para la referencia completa de campos, ejemplos curl (proxy inverso, alojamiento estático, upstream HTTPS), niveles de limitación de tasa, limitación de tasa de ruta personalizada y cómo las rutas personalizadas componen con CORS del tenant.

Las instalaciones por defecto usan `EDGE_RUNTIME_MODE=embedded`, lo que significa que `supacloud.service` inicia el proceso hijo del Bun Edge Runtime él mismo. Hay un `supacloud-edge-runtime.service` separado disponible para `EDGE_RUNTIME_MODE=external`, pero no deberías ejecutar ambos modos al mismo tiempo.

`pgredis-runtime` es un servicio de plano de datos privado separado. El padre Edge emite una capability de corta duración y específica del proyecto para cada solicitud; los módulos Worker en caché solo ven el facade estable `globalThis.SupaCloud.pgredis` y nunca reciben credenciales PostgreSQL, pools de conexión, estado L1 o el secreto de firma del runtime. El servicio no está enrutado por Caddy y no expone ningún puerto de host/contenedor. Su superficie Edge v1 es solo KV/TTL. Los operadores autenticados usan la Web Console o el proxy de Management API para estado de runtime acotado, operaciones de claves exactas y vaciados confirmados del espacio de nombres del proyecto; los navegadores nunca llaman al puerto `9010` directamente. PGMQ sigue siendo la única cola de la plataforma, mientras que Caddy sigue siendo el limitador de tasa del gateway.

### Enrutamiento de Funciones en Segundo Plano

El tráfico público de Edge Function ahora entra primero a través de la Management API:

- `/functions/v1/*` se enruta a `:9090`
- `sdk-proxy` decide si la llamada debe:
  - encolar una tarea en segundo plano y devolver `202 Accepted`
  - o reenviar sincrónicamente al Bun Edge Runtime
- los llamantes del navegador y `supabase-js` pueden seguir usando la API estándar `functions.invoke()`

Esto le da a SupaCloud un punto de control estable para:

- encola asíncrona
- reintentos/valores por defecto de timeout
- idempotencia
- captura del sobre de solicitud
- política de ruta en segundo plano por función

Para compatibilidad con `supabase-js`, las invocaciones en primer plano siguen usando lo estándar:

```ts
await supabase.functions.invoke("my-function", { body: {...} })
```

La ejecución en segundo plano se activa mediante la configuración de funciones del lado del servidor a través de `background_routes`.

`background_routes` es el modelo de producción preferido para rutas intensivas como:

- `/generate/crop`
- `/generate/matting`
- `/generate/video`

porque no depende de que el navegador reenvíe correctamente las cabeceras personalizadas.

### Enrutamiento y Recuperación de Realtime

El tráfico de Realtime también entra primero a través de la Management API:

- `/realtime/v1/websocket` se enruta a `:9090`
- la Management API es propietaria de la actualización de websocket y proxy el tráfico Realtime aguas arriba
- Caddy no debería apuntar el tráfico websocket del navegador directamente al contenedor Elixir Realtime

Esto evita discrepancias de tenant/ruta como:

- `/realtime/v1/websocket` siendo reescrito en la ruta `/socket` incorrecta aguas arriba
- solicitudes websocket del navegador siendo interpretadas como el tenant equivocado

Si las suscripciones de Realtime fallan después de la instalación o migración, SupaCloud ahora incluye comandos de reconciliación únicos:

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

Úsalos para:

- registrar cualquier tenant de Realtime faltante
- reparar metadatos de conexión de tenant
- otorgar privilegios de esquema `realtime` requeridos en bases de datos de proyecto
- añadir `public.tasks` a la publicación `supabase_realtime` y establecer `REPLICA IDENTITY FULL`

Para nuevas instalaciones, `install.sh` ahora genera un `REALTIME_DB_ENC_KEY` válido, lo que evita el fallo histórico de `Bad key size` durante el registro del tenant.

### Ciclo de Vida de Runtime PostgREST

Cada proyecto mantiene una unidad PostgREST dedicada, pero la Management API ahora la trata como un componente de runtime gestionado con estado deseado explícito:

- `GET /v1/projects/:ref/services/postgrest/status`
- `POST /v1/projects/:ref/services/postgrest/start|stop|restart|pause|resume`

El estado deseado se almacena en columnas de metadatos dedicadas del proyecto (`postgrest_desired`, `postgrest_actual`, `postgrest_health` y marcas de tiempo relacionadas), y el worker de reconciliación de runtime mantiene el estado real de systemd alineado con él. Esta es una gestión de ciclo de vida explícita, no un auto-reducción por inactividad, por lo que el rendimiento de la ruta de solicitud permanece sin cambios.

| Característica | Runtime Bun actual |
|---------|---------------------|
| Memoria (200 funciones) | **~140MB** |
| Arranque en frío | **< 10ms (con precalentamiento: 0ms)** |
| Latencia en caliente | <1ms |
| Compatibilidad de código Deno | ✅ vía compat shim |
| Aislamiento | Worker Thread |

#### Puntos de entrada de CLI

Para operadores humanos, la división de CLI ahora es:

- `@supacloud/cli` / `supacloud-cli`: CLI de usuario específico del proyecto con defectos de auto-enlace desde `.env`
- `supacloudctl cli ...`: punto de entrada local unificado. El despacho normal es solo local y no contacta npm; usa `supacloudctl check-update cli` explícitamente cuando sea necesario.
- `@supacloud/admin` / `supacloud-admin`: CLI de administración de servidor y plataforma
- `supacloudctl admin ...`: punto de entrada local unificado con el mismo comportamiento offline-por-defecto; usa `supacloudctl check-update admin` explícitamente.
- En servidores instalados, `/usr/local/bin/supacloud` sigue siendo el binario del servidor compilado; las actualizaciones del servidor siguen usando `sudo supacloud upgrade --yes`.


### Estructura del Proyecto

```
supacloud/
├── install.sh                  # Guión de despliegue con un clic
├── setup.sh                    # Bootstrap de configuración remota
├── switch.sh                   # Herramienta de cambio de runtime/almacenamiento
├── supacloud                   # Herramienta de gestión CLI (envoltorio shell)
├── config.env                  # Plantilla de valores por defecto solo lectura rastreada
├── packages/
│   ├── management-api/         # Servidor de API REST (Bun + Elysia)
│   │   ├── src/
│   │   │   ├── routes/         # 20 módulos de rutas (projects, auth, frontend, webhook, ws, logs, etc.)
│   │   │   ├── services/       # 20 módulos de servicios
│   │   │   ├── cli/            # Subcomandos CLI (lifecycle, project)
│   │   │   ├── db/             # Capa de base de datos, migraciones, withRetry y degradación elegante
│   │   │   ├── middleware/     # Middleware de autenticación
│   │   │   ├── infra/          # Verificador de salud
│   │   │   ├── install.ts      # Instalador interactivo
│   │   │   ├── upgrade.ts      # Asistente de actualización
│   │   │   └── doctor.ts       # Diagnóstico del sistema
│   │   └── tests/              # Pruebas unitarias (17) e integración
│   ├── cli/                    # CLI de usuario del proyecto
│   │   └── src/
│   ├── admin/                  # CLI de administración del servidor
│   │   └── src/
│   ├── supacloud-lite/          # Runtime Supabase compatible de un solo proyecto Bun + PGlite
│   │   └── README.md            # Guía de uso Lite, migración y compatibilidad
│   ├── edge-runtime/           # Runtime de Funciones Edge Bun
│   │   ├── server.ts           # Servidor Elysia (EDGE_RUNTIME_PORT, por defecto :9005) + endpoint /preheat
│   │   ├── worker-pool.ts      # Pool de hilos Worker de tamaño fijo + preheat()
│   │   ├── worker-executor.ts  # Cargador de funciones + caché LRU + mensaje de precalentamiento
│   │   ├── deno-compat.ts      # Adaptador de compatibilidad de API Deno
│   │   ├── url-import-plugin.ts# Bun Plugin: interceptación de importación URL
│   │   └── shims/              # Reemplazos de la biblioteca estándar Deno
│   └── web-console/            # Panel de gestión SvelteKit
│       └── src/                # Componentes, rutas, recursos
├── scripts/
│   └── lib/                    # Módulos de guiones shell
│       ├── db_manager.sh       # Ciclo de vida de la base de datos
│       ├── gateway provider    # La publicación de rutas Caddy es gestionada internamente por management-api
│       ├── tenant_runtime.sh   # Runtime PostgREST & GoTrue del tenant
│       ├── function_manager.sh # Gestión de funciones edge
│       ├── s3_manager.sh       # Gestión del backend de almacenamiento
│       ├── jwt_manager.sh      # Generación de claves JWT
│       ├── backup_manager.sh   # Operaciones de copia de seguridad
│       ├── ha_manager.sh       # Alta disponibilidad
│       ├── security_manager.sh # Firewall y SSL
│       ├── storage_manager.sh  # Operaciones de almacenamiento
│       ├── extension_manager.sh# Extensiones PostgreSQL
│       ├── global_router.ts    # Lógica de enrutamiento global
│       └── worker_runner.ts    # Trabajador en segundo plano
├── infra/
│   ├── os/                     # Configuraciones a nivel de sistema operativo
│   └── postgres/               # Configuraciones de PostgreSQL
├── docs/                       # 15 archivos de documentación
│   ├── deploy-guide.md         # Guía de despliegue
│   ├── architecture-multi-tenant.md  # Diseño de arquitectura
│   ├── china-oauth-integration.md    # OAuth para China (WeChat, etc.)
│   └── ...                     # Ver docs/README.md para el índice completo
└── .github/
    └── workflows/              # CI/CD (build-studio, management-api, release)
```

### Configuración

`config.env` es una plantilla de valores por defecto solo lectura rastreada. La entrada de instalación propiedad del instalador se persiste en `/etc/supabase/install.env`; el estado de runtime de Management API se mantiene por separado en `/etc/supabase/management-api.env`. No copies el estado de runtime sobre la entrada de instalación.

Configuraciones de instalación clave:

| Variable | Descripción | Por defecto |
|----------|-------------|---------|
| `SUPABASE_PUBLIC_DOMAIN` | Dominio de gateway API global | Requerido en producción; el instalador puede generar automáticamente |
| `SUPABASE_STUDIO_DOMAIN` | Dominio de consola global | Derivado automáticamente del dominio API si está vacío |
| `S3_STORAGE_TYPE` | Backend de almacenamiento | `juicefs` |
| `TUS_MAX_SIZE` | Tamaño máximo de carga reanudable | `524288000` (500 MiB) |
| `TUS_MAX_CHUNK_SIZE` | Tamaño máximo de fragmento de carga reanudable | `16777216` (16 MiB) |
| `EDGE_RUNTIME` | Runtime de funciones | `bun` |
| `PG_VERSION` | Versión de PostgreSQL | `18` |
| `PIGSTY_VERSION` | Versión de Pigsty | `v4.4.0` |
| `SUPACLOUD_LOGS_ENABLED` | Colector integrado + logs de proyecto VictoriaLogs (no usa Logflare) | `true` |
| `SUPACLOUD_PIPELINES_ENABLED` | Runtime ETL fijo de Supabase para BigQuery CDC Pipelines | `true` |

### Documentación

- [Índice de Documentación](docs/README.md)
- [Guía de Despliegue](docs/deploy-guide.md)
- [Arquitectura Multi-tenant](docs/architecture-multi-tenant.md)
- [Proveedor OAuth 2.1 / OIDC](docs/oauth-oidc-provider.md)
- [Integración OAuth para China](docs/china-oauth-integration.md)
- [Documentación de Pigsty](https://pigsty.cc/)
- [Autoalojamiento de Supabase](https://supabase.com/docs/guides/self-hosting)

---

<a name="english"></a>
## English

**SupaCloud** is a next-generation, ultra-lightweight multi-tenant PaaS for self-hosting Supabase. Built on **Pigsty**, it enables you to run multiple isolated Supabase projects efficiently on a single server.

### Key Features

- **Multi-Tenant Architecture**: Run multiple isolated Supabase projects with shared infrastructure
- **Management API**: Full REST API (60+ endpoints) for complete project lifecycle management
- **Web Console**: Modern SvelteKit management dashboard with authentication
- **Official Supabase CLI Database Workflows**: The compatibility harness exercises direct `--db-url` flows including `db push`, `migration list`, `db pull`, and `gen types`
- **CLI Tools**: `supacloud-cli` for project users, `supacloud-admin` for server operators, and optional `supacloudctl` as the local unified dispatcher
- **SupaCloud Pages**: Frontend static site hosting with GitHub webhook auto-deploy
- **Pigsty Powered**: Enterprise-grade PostgreSQL with built-in monitoring (Grafana)
- **One-Click Installation**: Fully automated setup via `install.sh`
- **JuiceFS Storage**: Powered by PostgreSQL Large Objects (LO) for ultra-thin metadata
- **Caddy Gateway**: Automatic HTTPS, Admin API-driven route publishing, programmable rate limiting, security headers, and CORS
- **Auto-scaling Engine**: Rule-based vertical and horizontal scaling based on real-time metrics
- **Bun Edge Runtime**: Bun.js + Elysia Worker Pool for Edge Functions, with built-in Deno compatibility shim for legacy user code
- **SSE Real-time Logs**: Server-Sent Events streaming for live log tailing via `journalctl --follow`
- **Native Queue Worker**: Pure Bun.js PostgreSQL LISTEN/NOTIFY based asynchronous worker for AI inference and MQTT events
- **WebSocket Task Notifications**: Real-time task progress push via native Bun WebSocket
- **DB Graceful Degradation**: Exponential backoff retry + 503 Service Unavailable on transient DB failures
- **Hardened Control Plane**: Authenticated function management reads, one-time signed uploads, defensive pagination, and safe storage metadata parsing
- **Edge Function Preheating**: Zero cold-start via worker module pre-import on deploy
- **Project OAuth/OIDC Provider**: Per-project OAuth 2.1 / OIDC migration with ES256 signing keys, discovery, JWKS, authorize/token/userinfo endpoints, and OAuth client CRUD
- **China OAuth**: Built-in WeChat, Alipay, DingTalk login integration
- **CI/CD Integration**: GitHub webhook for automated deployments
- **Comprehensive Tests**: 400+ unit, integration, and structural regression tests

### SupaCloud Lite

**SupaCloud Lite** is the Bun-native, single-project edition of SupaCloud. It runs PostgreSQL-compatible workloads in-process with PGlite and exposes the Supabase protocols used by `@supabase/supabase-js`: REST, Auth, Storage, Realtime, and Edge Functions. It is intended for local development, small single-project deployments, and applications that want a Docker-free Supabase-compatible backend.

Lite Auth is built into the same Bun process; it does not install or launch a GoTrue sidecar. It is enabled by default and can be disabled with `[auth] enabled = false` in `supabase/config.toml`, which turns off `/auth/v1/*`. Use the full platform when an independent GoTrue runtime or full GoTrue compatibility is required.

Use the full SupaCloud platform when you need multi-project tenancy, a management API or web console, shared Pigsty infrastructure, platform operations, and hosted frontend lifecycle management. Lite deliberately does not provide a multi-project control plane or Supabase Studio; each Lite process owns one project and its own state directory.

| Need | Choose |
| --- | --- |
| Local-first or single-project runtime without Docker | SupaCloud Lite |
| Multi-tenant platform, operator controls, or production infrastructure management | SupaCloud |

Lite requires Bun 1.3+ and keeps its default database, storage, and generated secrets under `.supacloud-lite/` in the project directory. Start it with the existing Supabase CLI project layout:

```bash
bun add @supacloud/lite
bunx supacloud-lite start
bunx supacloud-lite keys
```

Then use the printed anonymous key with the standard client:

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)
```

See [SupaCloud Lite documentation](./packages/supacloud-lite/README.md) for CLI commands, storage/S3 configuration, compatibility limits, migration guidance, and deployment boundaries.

For persistent Lite deployments, update the pinned `@supacloud/lite` dependency and run `supacloud-lite upgrade`. The command creates a portable database/storage/secrets snapshot before applying pending migrations. `snapshot create` and fail-closed `snapshot restore` are also available for host migration and rollback preparation.

### SupaCloud vs Supabase

SupaCloud is best understood as a **self-hosted multi-tenant control plane for Supabase-style projects**, not as a clone of Supabase Cloud.

Short version:

- **SupaCloud**: best when you want to run many isolated projects on your own servers with a built-in operator API, web console, project lifecycle management, task queue surface, and frontend hosting.
- **Supabase Cloud**: best when you want a fully managed platform, hosted backups/PITR, hosted logs explorer, and hosted branching.
- **Supabase Self-Hosted**: best when you want the official upstream stack on your own infra and are comfortable operating Docker/services directly.

Detailed feature comparison:

- [docs/supacloud-vs-supabase.md](./docs/supacloud-vs-supabase.md)

### Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│            Bun + Elysia + TypeScript + Auto-scaling          │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ StorageSvc │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ GatewaySvc │  │ ScalingSvc │  │ BackupSvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ RouterSvc  │  │ FrontendSv │  │ DeploySvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                   Shared Infrastructure                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Caddy    │  │  JuiceFS   │            │
│  │  (Pigsty)  │  │  Gateway   │  │  (PG-LO)   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                  ┌────────────┐                             │
│                  │  Grafana   │                             │
│                  │ (Monitor)  │                             │
│                  └────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### Quick Start

#### Requirements

| Item | Minimum | Recommended |
|------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 2GB | 4GB+ |
| Disk | 40GB | 100GB+ SSD |
| OS | CentOS 9, Ubuntu 22/24, Debian 12 | CentOS 9 |

#### Human Entrypoints

**Project user CLI**

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli frontend list --ref <project-ref>
```

`supacloud-cli` defaults to project context and auto-links from the current workspace `.env` when available.
There is no project-CLI compatibility alias named `supacloud`: that name is reserved for the compiled server binary at `/usr/local/bin/supacloud`. Use `supacloudctl` only for the optional local unified dispatcher.

- `SUPABASE_URL` or `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`

AI agents should install the migration-first Skill shipped with the CLI:

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

**Server admin CLI**

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project create --name my-app
```

Use `supacloud-admin` for installation, upgrades, tenant runtime operations, and platform-wide project lifecycle control.

#### Server Installation

**One-Click Installation (Recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
```

The root bootstrap itself is always fetched from the official repository. Release/API downloads try GitHub directly first and use `SUPACLOUD_GITHUB_PROXY` only as an explicit fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**Source/Development Installation (local artifacts only)**

Production hosts should use the verified one-click `setup.sh` flow above. A source checkout has no Release artifacts, so build every required component first and opt into local artifact mode explicitly:

```bash
# 1. Clone repository
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. Build Management API, Edge Runtime, pgredis-runtime, Caddy, and Web Console artifacts
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
bun --cwd packages/pgredis-runtime install
bun --cwd packages/pgredis-runtime run build:linux
bun --cwd packages/web-console install --frozen-lockfile
bun --cwd packages/web-console run build
mkdir -p .local/bin dist
GOBIN="$PWD/.local/bin" go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
PATH="$PWD/.local/bin:$PATH" OUT_DIR="$PWD/dist" bash scripts/build_supacloud_caddy.sh

# 3. Configure and install from the validated local build outputs
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 1.2.3.4 --domain api.example.com --s3 juicefs

# 4. Enable CLI
source /etc/profile.d/supacloud.sh
```

**Production Upgrades**

Production servers upgrade by replacing the released Linux binary at `/usr/local/bin/supacloud`; they do not need to `git pull` application source during normal upgrades.

```bash
sudo supacloud upgrade --yes
```

Install and upgrade downloads are direct-first. Configure a trusted proxy only when an explicit fallback is required:

```bash
sudo SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example supacloud upgrade --yes
```

Release artifacts require same-release SHA256 verification and GitHub build provenance attestation. `SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` is an emergency break-glass mode that retains SHA256 verification but must not be a normal installation setting.

Published release assets:

- `supacloud-linux-amd64` and `supacloud-linux-arm64` are the production install/upgrade binaries.
- `supacloud-macos-amd64` and `supacloud-macos-arm64` are published for local development and diagnostics.

**Docker Compose Self-Host (PostgreSQL 18)**

```bash
cd docker/self-host
python3 init-env.py --public-url https://api.example.com --studio-url https://studio.example.com --output .env
docker compose up -d --build
```

The compose stack is isolated under [`docker/self-host`](/Volumes/Data/workspace/supacloud/docker/self-host) and ships a PostgreSQL 18 image with common extensions preinstalled.

For the Docker-specific Pigsty 4.4/Supabase compatibility check and backup-first upgrade path, see [`docs/upgrade-postgres-docker-4.4.md`](./docs/upgrade-postgres-docker-4.4.md). Do not run the native Pigsty upgrade script against a Docker data volume.

For TrueNAS SCALE `Custom App` deployment of the published PostgreSQL image, see [`docker/self-host/TRUENAS.md`](./docker/self-host/TRUENAS.md).

**Available CLI Options:**
| Option | Description | Example |
|--------|-------------|---------|
| `--ip` | Server Internal IP | `--ip 10.0.0.5` |
| `--domain` | API/Public Domain | `--domain supa.com` |
| `--studio` | Studio Dashboard Domain| `--studio studio.com`|
| `--s3` | Storage Type | `juicefs`, `minio`, or `external` |
| `--password`| Master Password | `--password mysecret` |

### Management

#### User CLI: `supacloud-cli`

The `supacloud-cli` command is project-scoped by default and is intended for deploy/build/log/database workflows around a single project:

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli project tasks
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref <ref> --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref <ref> --dir supabase/migrations --dry_run
supacloud-cli auth list_providers --ref <ref>
supacloud-cli frontend list --ref <ref>
supacloud-cli edge_functions list --ref <ref>
supacloud-cli storage list_buckets --ref <ref>
```

For complex SQL, pgvector queries, and single-request transaction blocks, prefer `--file` instead of shell-escaped inline SQL.

```sql
BEGIN;
INSERT INTO audit_events(message) VALUES ('started');
INSERT INTO audit_events(message) VALUES ('finished');
COMMIT;
```

SupaCloud supports transaction blocks inside one SQL request and wraps migrations in a transaction. It does not expose long-lived HTTP transaction sessions such as `/transaction/begin` and `/transaction/commit`; application-side long transactions should use the direct Postgres DSN with `pg`, `postgres.js`, or equivalent drivers.

pgvector example:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX documents_embedding_hnsw_idx
ON documents
USING hnsw (embedding vector_cosine_ops);

SELECT id, content
FROM documents
ORDER BY embedding <=> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

`supacloud-cli` intentionally does **not** own platform installation, upgrades, SSH diagnostics, tenant runtime management, or destructive project lifecycle commands.

#### Admin CLI: `supacloud-admin`

The `supacloud-admin` CLI is for server and platform operators:

```bash
supacloud-admin status
supacloud-admin ssh ping
supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
supacloud-admin ssh diagnose
supacloud-admin project list
supacloud-admin project create --name my-app
supacloud-admin project delete --ref <ref>
supacloud-admin project pause --ref <ref>
supacloud-admin platform metrics
```

#### Management API

The REST API runs on port 9090 with Swagger documentation at `/swagger`.

```bash
# Create project
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "region": "local"}'

# List projects
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# Get API keys
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**Core API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/projects` | List all projects |
| POST | `/v1/projects` | Create project |
| GET | `/v1/projects/:ref` | Get project details |
| PATCH | `/v1/projects/:ref` | Update project |
| DELETE | `/v1/projects/:ref` | Delete project (soft) |
| POST | `/v1/projects/:ref/pause` | Pause project |
| POST | `/v1/projects/:ref/restore` | Restore project |
| GET | `/v1/projects/:ref/status` | Get status |
| GET | `/v1/projects/:ref/health` | Get health |
| GET | `/v1/projects/:ref/dashboard/summary` | Cached dashboard summary |
| POST | `/v1/projects/:ref/restart` | Restart services |
| GET | `/v1/projects/:ref/settings` | Get settings |
| PUT | `/v1/projects/:ref/settings` | Update settings |
| GET | `/v1/projects/:ref/api-keys` | Get API keys |
| POST | `/v1/projects/:ref/api-keys/rotate` | Rotate legacy JWT API keys |
| POST | `/v1/projects/:ref/api-keys/rotate-opaque` | Rotate Publishable/Secret keys without changing JWT sessions |
| GET | `/v1/projects/:ref/auth/oauth-server` | Get project OAuth/OIDC status |
| POST | `/v1/projects/:ref/auth/oauth-server/migrate` | Migrate project to OIDC signing keys |
| GET/POST/PUT/DELETE | `/v1/projects/:ref/auth/oauth-clients*` | OAuth client CRUD for the project runtime |
| GET | `/v1/projects/:ref/types/typescript` | Generate TS types |
| PATCH | `/v1/projects/:ref/config/auth` | Configure Auth & Providers |
| GET | `/v1/projects/:ref/secrets` | List Edge Function Secrets |
| POST | `/v1/projects/:ref/secrets` | Upsert Secrets |
| DELETE | `/v1/projects/:ref/secrets/:name` | Delete Secret |

Function management read endpoints under `/v1/projects/:ref/functions*` require project service-role or admin authentication. Public runtime invokes remain on `/functions/v1/*` and continue to use the normal Supabase function auth model.

**Extended API Endpoints:**

| Category | Endpoints | Description |
|----------|-----------|-------------|
| Database | `/v1/projects/:ref/database/*` | SQL query, schema inspection, migrations, defensive pagination |
| Auth | `/v1/projects/:ref/config/auth`, `/v1/projects/:ref/auth/*` | OAuth providers, OAuth/OIDC Provider migration, WeChat/Alipay/DingTalk |
| Frontend | `/v1/projects/:ref/frontend/*` | Pages hosting, deployments, custom domains |
| Webhook | `/v1/webhooks/github` | GitHub webhook for CI/CD auto-deploy |
| Storage | `/v1/storage/*` | Bucket management, file upload, one-time signed uploads, S3 migration |
| Extensions | `/v1/extensions/*` | PostgreSQL extension marketplace |
| Scaling | `/v1/projects/:ref/scaling/*` | Vertical upgrade & horizontal replicas |
| Backups | `/v1/projects/:ref/backups/*` | Database backup & restore |
| Monitor | `/v1/monitor/*` | Database monitoring & health |
| Security | `/v1/security/*` | Firewall rules & SSL certificates |
| Deploy | `/v1/deploy/*` | Edge Function deployment |
| Tasks | `/v1/projects/:ref/tasks/*` | Background task monitoring, including lightweight `summary=true` list mode |
| **Logs SSE** | `GET /v1/projects/:ref/logs/stream` | **Real-time log streaming via Server-Sent Events** |
| **Rate Limit** | `GET/PUT /v1/projects/:ref/gateway/rate-limit` | **Programmable per-project rate limiting (Caddy route policy)** |
| **Gateway Routes** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **Controlled custom Caddy routes (proxy, static, redirect, headers, CORS, priority)** |
| **WebSocket** | `ws://host/ws/tasks` | **Real-time task progress notifications** |

#### Runtime Switching

```bash
# Switch Edge Runtime deployment mode
./switch.sh runtime embedded   # Managed by supacloud.service
./switch.sh runtime external   # Standalone supacloud-edge-runtime.service

# Switch storage backend
./switch.sh storage juicefs    # or: minio, external

# Show current configuration
./switch.sh status
```

**Edge Runtime Architecture:**

```
SupaCloud (:9090)          Edge Runtime (EDGE_RUNTIME_PORT, default :9005)
├── Management API    ←──  supacloud.service manages by default
├── Web Console            ├── Elysia Server
├── SSE Log Stream         ├── Worker Thread Pool (4 threads)
├── WebSocket /ws/tasks    ├── Deno Compat Shim
└── Static Assets (ETag)   ├── URL Import Plugin
                           └── /preheat (zero cold-start)

Edge Runtime parent ── internal capability ──► pgredis-runtime (:9010)
                                             ├── per-tenant PostgreSQL pool
                                             └── bounded L1 + LISTEN/NOTIFY

Caddy Gateway (Admin API-driven):
  Automatic HTTPS, route JSON publishing, security headers, rate limiting, CORS
  /api/*        → :9090
  /functions/*  → :9090 (sdk-proxy, async enqueue + sync relay)
```

SupaCloud never hand-edits a Caddyfile in production. The Management API keeps the full Caddy config as JSON in memory (`GatewayService`), and on every route / rate-limit / cert change it:
1. renders the complete Caddy JSON config,
2. validates it with `caddy validate --config <tmp>`,
3. hot-loads it via `POST /load` on the Caddy Admin API (`CADDY_ADMIN_URL`, default `http://127.0.0.1:2019`),
4. atomically persists the applied JSON to `CADDY_CONFIG_PATH` for reboot-time hydration, and drops a `DO-NOT-EDIT.txt` next to it.

The packaged Caddyfile only enables the Admin API listener and a minimal catch-all for bootstrap; tenant routing, TLS, CORS and rate limiting are all owned by the injected JSON. `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` and `POST /v1/projects/:ref/gateway/config` are the user-facing surface that drives these JSON updates.

Startup source differs by deployment mode: systemd installs run `supacloud-caddy run --config /etc/supacloud/caddy/config.json` (JSON only, no Caddyfile, with an initial JSON seeded by `install.sh`); the docker `self-host` and `dev` stacks boot the official `caddy` image with a bootstrap-only Caddyfile (`admin 0.0.0.0:2019` + `auto_https off` + a `503` placeholder), then the Management API publishes the full JSON config via `POST /load` once it is healthy, retrying with backoff until Caddy is reachable. Either way the live routing config is the JSON injected through the Admin API.

Additionally, the Management API runs a periodic `gateway-health.worker` that polls the Caddy Admin API; when it detects a transition from unreachable back to reachable (e.g. Caddy restarted under systemd or the container restarted under docker), it triggers `rebuildAllTenantConfigs()` to re-publish the full route JSON so the live config stays consistent with the in-memory state, giving both deployment modes self-healing.

See [docs/gateway-customization.md](docs/gateway-customization.md) for the full field reference, curl examples (reverse proxy, static hosting, HTTPS upstream), rate-limit tiers, custom path rate limits, and how custom routes compose with tenant CORS.

Default installs use `EDGE_RUNTIME_MODE=embedded`, meaning `supacloud.service` starts the Bun Edge Runtime child process itself. A separate `supacloud-edge-runtime.service` is available for `EDGE_RUNTIME_MODE=external`, but you should not run both modes at the same time.

`pgredis-runtime` is a separate private data-plane service. The Edge parent mints a short-lived, project-scoped capability for each request; cached Worker modules only see the stable `globalThis.SupaCloud.pgredis` facade and never receive PostgreSQL credentials, connection pools, L1 state, or the runtime signing secret. The service is not routed by Caddy and exposes no host/container port. Its Edge v1 surface is KV/TTL only. Authenticated operators use the Web Console or Management API proxy for bounded runtime status, exact-key operations, and confirmed project-namespace flushes; browsers never call port `9010` directly. PGMQ remains the only platform queue, while Caddy remains the gateway rate limiter.

### Background Function Routing

Public Edge Function traffic now enters through the Management API first:

- `/functions/v1/*` is routed to `:9090`
- `sdk-proxy` decides whether the call should:
  - enqueue a background task and return `202 Accepted`
  - or relay synchronously to the Bun Edge Runtime
- browser and `supabase-js` callers can keep using the stock `functions.invoke()` API

This gives SupaCloud a stable control point for:

- async enqueue
- retries / timeout defaults
- idempotency
- request envelope capture
- per-function background route policy

For `supabase-js` compatibility, foreground invokes still use the standard:

```ts
await supabase.functions.invoke("my-function", { body: {...} })
```

Background execution is activated through server-side function config via `background_routes`.

`background_routes` is the preferred production model for heavy paths like:

- `/generate/crop`
- `/generate/matting`
- `/generate/video`

because it does not depend on the browser successfully forwarding custom headers.

### Realtime Routing And Recovery

Realtime traffic also enters through the Management API first:

- `/realtime/v1/websocket` is routed to `:9090`
- the Management API owns the websocket upgrade and proxies upstream Realtime traffic
- Caddy should not point browser websocket traffic directly at the Elixir Realtime container

This avoids tenant/path mismatches such as:

- `/realtime/v1/websocket` being rewritten into the wrong upstream `/socket` path
- browser websocket requests being interpreted as the wrong tenant

If Realtime subscriptions fail after installation or migration, SupaCloud now includes one-off reconciliation commands:

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

Use them to:

- register any missing Realtime tenants
- repair tenant connection metadata
- grant required `realtime` schema privileges in project databases
- add `public.tasks` to the `supabase_realtime` publication and set `REPLICA IDENTITY FULL`

For new installs, `install.sh` now generates a valid `REALTIME_DB_ENC_KEY`, which prevents the historical `Bad key size` failure during tenant registration.

### PostgREST Runtime Lifecycle

Each project keeps a dedicated PostgREST unit, but Management API now treats it as a managed runtime component with explicit desired state:

- `GET /v1/projects/:ref/services/postgrest/status`
- `POST /v1/projects/:ref/services/postgrest/start|stop|restart|pause|resume`

The desired state is stored in dedicated project metadata columns (`postgrest_desired`, `postgrest_actual`, `postgrest_health`, and related timestamps), and the runtime reconcile worker keeps actual systemd state aligned with it. This is explicit lifecycle management, not idle auto-shrinking, so request-path performance stays unchanged.

| Feature | Current Bun Runtime |
|---------|---------------------|
| Memory (200 functions) | **~140MB** |
| Cold start | **< 10ms (with preheat: 0ms)** |
| Warm latency | <1ms |
| Deno code compat | ✅ via shim |
| Isolation | Worker Thread |

#### CLI Entry Points

For human operators, the CLI split is now:

- `@supacloud/cli` / `supacloud-cli`: project-scoped user CLI with `.env` auto-link defaults
- `supacloudctl cli ...`: unified local entrypoint. Normal dispatch is local-only and does not contact npm; use `supacloudctl check-update cli` explicitly when needed.
- `@supacloud/admin` / `supacloud-admin`: server and platform administration CLI
- `supacloudctl admin ...`: unified local entrypoint with the same offline-by-default behavior; use `supacloudctl check-update admin` explicitly.
- On installed servers, `/usr/local/bin/supacloud` remains the compiled server binary; server upgrades still use `sudo supacloud upgrade --yes`.


### Project Structure

```
supacloud/
├── install.sh                  # One-click deployment script
├── setup.sh                    # Remote setup bootstrap
├── switch.sh                   # Runtime/storage switching tool
├── supacloud                   # CLI management tool (shell wrapper)
├── config.env                  # Read-only tracked defaults template
├── packages/
│   ├── management-api/         # REST API server (Bun + Elysia)
│   │   ├── src/
│   │   │   ├── routes/         # 20 route modules (projects, auth, frontend, webhook, ws, logs, etc.)
│   │   │   ├── services/       # 20 service modules
│   │   │   ├── cli/            # CLI subcommands (lifecycle, project)
│   │   │   ├── db/             # Database layer, migrations, withRetry & graceful degradation
│   │   │   ├── middleware/     # Auth middleware
│   │   │   ├── infra/          # Health checker
│   │   │   ├── install.ts      # Interactive installer
│   │   │   ├── upgrade.ts      # Upgrade wizard
│   │   │   └── doctor.ts       # System diagnostics
│   │   └── tests/              # Unit (17) & integration tests
│   ├── cli/                    # Project user CLI
│   │   └── src/
│   ├── admin/                  # Platform admin CLI
│   │   └── src/
│   ├── supacloud-lite/          # Bun + PGlite single-project Supabase-compatible runtime
│   │   └── README.md            # Lite usage, migration, and compatibility guide
│   ├── edge-runtime/           # Bun Edge Functions runtime
│   │   ├── server.ts           # Elysia server (EDGE_RUNTIME_PORT, default :9005) + /preheat endpoint
│   │   ├── worker-pool.ts      # Fixed-size Worker Thread Pool + preheat()
│   │   ├── worker-executor.ts  # Function loader + LRU cache + preheat msg
│   │   ├── deno-compat.ts      # Deno API compatibility shim
│   │   ├── url-import-plugin.ts# Bun Plugin: URL import interception
│   │   └── shims/              # Deno std library replacements
│   └── web-console/            # SvelteKit management dashboard
│       └── src/                # Components, routes, assets
├── scripts/
│   └── lib/                    # Shell script modules
│       ├── db_manager.sh       # Database lifecycle
│       ├── gateway provider    # Caddy route publishing is managed in management-api
│       ├── tenant_runtime.sh   # Tenant PostgREST & GoTrue runtime
│       ├── function_manager.sh # Edge Functions management
│       ├── s3_manager.sh       # Storage backend management
│       ├── jwt_manager.sh      # JWT key generation
│       ├── backup_manager.sh   # Backup operations
│       ├── ha_manager.sh       # High availability
│       ├── security_manager.sh # Firewall & SSL
│       ├── storage_manager.sh  # Storage operations
│       ├── extension_manager.sh# PostgreSQL extensions
│       ├── global_router.ts    # Global routing logic
│       └── worker_runner.ts    # Background worker
├── infra/
│   ├── os/                     # OS-level configurations
│   └── postgres/               # PostgreSQL configurations
├── docs/                       # 15 documentation files
│   ├── deploy-guide.md         # Deployment guide
│   ├── architecture-multi-tenant.md  # Architecture design
│   ├── china-oauth-integration.md    # China OAuth (WeChat, etc.)
│   └── ...                     # See docs/README.md for full index
└── .github/
    └── workflows/              # CI/CD (build-studio, management-api, release)
```

### Configuration

`config.env` is a read-only tracked defaults template. Installer-owned input is persisted at `/etc/supabase/install.env`; Management API runtime state is kept separately at `/etc/supabase/management-api.env`. Do not copy runtime state over the installation input.

Key installation settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_PUBLIC_DOMAIN` | Global API gateway domain | Production required; installer can auto-generate |
| `SUPABASE_STUDIO_DOMAIN` | Global console domain | Auto-derived from API domain if empty |
| `S3_STORAGE_TYPE` | Storage backend | `juicefs` |
| `TUS_MAX_SIZE` | Resumable upload maximum size | `524288000` (500 MiB) |
| `TUS_MAX_CHUNK_SIZE` | Resumable upload chunk maximum size | `16777216` (16 MiB) |
| `EDGE_RUNTIME` | Functions runtime | `bun` |
| `PG_VERSION` | PostgreSQL version | `18` |
| `PIGSTY_VERSION` | Pigsty version | `v4.4.0` |
| `SUPACLOUD_LOGS_ENABLED` | 内置采集器 + VictoriaLogs 项目日志（不使用 Logflare） | `true` |
| `SUPACLOUD_PIPELINES_ENABLED` | Pinned Supabase ETL runtime for BigQuery CDC Pipelines | `true` |

### Documentation

- [Documentation Index](docs/README.md)
- [Deployment Guide](docs/deploy-guide.md)
- [Multi-Tenant Architecture](docs/architecture-multi-tenant.md)
- [OAuth 2.1 / OIDC Provider](docs/oauth-oidc-provider.md)
- [China OAuth Integration](docs/china-oauth-integration.md)
- [Pigsty Documentation](https://pigsty.cc/)
- [Supabase Self-Hosting](https://supabase.com/docs/guides/self-hosting)

---

<a name="chinese"></a>
## 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级多租户 PaaS 平台。基于 **Pigsty** 构建，可在单台服务器上高效运行多个隔离的 Supabase 项目。

### 核心特性

- **多租户架构**: 共享基础设施，运行多个隔离的 Supabase 项目
- **Management API**: 完整的 REST API（60+ 个端点）管理项目及周边配置生命周期
- **Web 管理面板**: 现代 SvelteKit 管理面板，内置登录认证
- **Supabase 官方 CLI 数据库工作流**: 兼容性脚本会执行 `db push`、`migration list`、`db pull` 和 `gen types` 等直连 `--db-url` 流程
- **CLI 工具**: `supacloud-cli` 面向项目使用者，`supacloud-admin` 面向服务器管理员；可选用 `supacloudctl` 作为本地统一分发入口
- **SupaCloud Pages**: 前端静态站点托管，支持 GitHub Webhook 自动部署
- **Pigsty 驱动**: 企业级 PostgreSQL，内置 Grafana 监控
- **一键部署**: 通过 `install.sh` 全自动安装
- **JuiceFS 存储**: 基于 PostgreSQL Large Objects (LO) 后端，极致轻量
- **Caddy 网关**: Automatic HTTPS、Admin API 驱动的动态路由发布、安全响应头与编程式限流
- **自动扩缩容**: 基于负载指标的垂直提升与水平副本扩展
- **Bun Edge Runtime**: 基于 Bun.js + Elysia Worker Pool，内置 Deno 兼容层以兼容旧函数代码
- **SSE 实时日志**: 基于 Server-Sent Events 的实时日志流，`journalctl --follow` 推送
- **原生异步队列**: 基于 PostgreSQL LISTEN/NOTIFY 的零依赖高并发调度底座，支持 AI 大模型任务与 MQTT 消息队列
- **WebSocket 任务通知**: 基于 Bun 原生 WebSocket 的实时任务进度推送
- **DB 优雅降级**: 指数退避重试 + 503 Service Unavailable，PostgreSQL 短暂不可用时不丢请求
- **控制平面加固**: 函数管理读接口鉴权、一次性 signed upload、防御性分页和安全的存储元数据解析
- **Edge Function 预热**: 部署后自动预导入模块，消除首次请求冷启动
- **项目级 OAuth/OIDC Provider**: 支持项目迁移到 ES256 OIDC signing keys、授权端点、JWKS 和 OAuth client 管理
- **国内 OAuth**: 内置微信、支付宝、钉钉登录集成
- **CI/CD 集成**: GitHub Webhook 自动化部署
- **完善测试**: 400+ 单元、集成和结构回归测试

### SupaCloud Lite

**SupaCloud Lite** 是 SupaCloud 的 Bun 原生单项目版本：它使用 PGlite 在进程内运行兼容 PostgreSQL 的工作负载，并实现 `@supabase/supabase-js` 所需的 REST、Auth、Storage、Realtime 与 Edge Functions 协议。它适合本地开发、小型单项目部署，以及希望获得 Supabase 兼容后端但不想引入 Docker 的应用。

Lite 的 Auth 内置在同一个 Bun 进程中，不会安装或启动 GoTrue sidecar。它默认启用；在 `supabase/config.toml` 设置 `[auth] enabled = false` 可关闭 `/auth/v1/*`。需要独立 GoTrue 运行时或完整 GoTrue 兼容性时，应使用完整平台。

需要多项目租户、Management API 或 Web 管理面板、共享 Pigsty 基础设施、平台运维或前端托管生命周期时，应使用完整的 SupaCloud 平台。Lite 有意不提供多项目控制面和 Supabase Studio；每个 Lite 进程只负责一个项目及其独立状态目录。

| 需求 | 选择 |
| --- | --- |
| 无 Docker 的本地优先或单项目运行时 | SupaCloud Lite |
| 多租户平台、运维控制面或生产基础设施管理 | SupaCloud |

Lite 需要 Bun 1.3+，默认会把数据库、对象存储和生成的密钥保存在项目目录下的 `.supacloud-lite/`。可直接使用现有 Supabase CLI 项目结构启动：

```bash
bun add @supacloud/lite
bunx supacloud-lite start
bunx supacloud-lite keys
```

将输出的匿名 key 直接交给标准客户端：

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)
```

CLI 命令、存储/S3 配置、兼容性边界、迁移方式和部署注意事项请参阅 [SupaCloud Lite 完整文档](./packages/supacloud-lite/README.md)。

持久化部署升级时，先更新项目锁定的 `@supacloud/lite` 依赖，再运行 `supacloud-lite upgrade`。该命令会在执行待应用 migration 前自动创建包含数据库、对象存储和密钥的可移植快照；跨机器迁移还可以直接使用 `snapshot create` 和默认拒绝覆盖的 `snapshot restore`。

### SupaCloud 与 Supabase 的区别

SupaCloud 更准确的定位是：**面向自托管场景的多租户 Supabase 控制平面**，而不是 Supabase Cloud 的镜像复刻。

简版结论：

- **SupaCloud**: 适合你在自有服务器上托管多个隔离项目，并需要内置控制台、项目生命周期 API、任务队列能力和前端托管能力。
- **Supabase Cloud**: 适合你直接购买托管平台，需要托管备份/PITR、托管日志和官方 Branching。
- **Supabase Self-Hosted**: 适合你要官方原生自托管栈，并愿意自己承担 Docker 与基础设施运维。

详细功能对比：

- [docs/supacloud-vs-supabase.md](./docs/supacloud-vs-supabase.md)

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│            Bun + Elysia + TypeScript + 自动扩缩容            │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ StorageSvc │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ GatewaySvc │  │ ScalingSvc │  │ BackupSvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ RouterSvc  │  │ FrontendSv │  │ DeploySvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                       共享基础设施                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Caddy    │  │  JuiceFS   │            │
│  │  (Pigsty)  │  │    网关    │  │  (PG-LO)   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                  ┌────────────┐                             │
│                  │  Grafana   │                             │
│                  │  (监控)    │                             │
│                  └────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### 快速开始

#### 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | CentOS 9, Ubuntu 22/24, Debian 12 | CentOS 9 |

#### 人类入口

**项目使用者 CLI**

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli frontend list --ref <project-ref>
```

`supacloud-cli` 默认是项目级 CLI，会优先从当前目录 `.env` 自动绑定项目。
项目 CLI 不再提供名为 `supacloud` 的兼容别名：该名称只保留给 `/usr/local/bin/supacloud` 服务端二进制。本地统一分发入口必须明确使用 `supacloudctl`。

- `SUPABASE_URL` 或 `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPACLOUD_API_TOKEN`

AI Agent 应安装 CLI 随包提供的 migration-first Skill：

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

**服务器管理员 CLI**

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project create --name my-app
```

安装、升级、SSH 诊断、tenant 运维、平台级项目管理都应放在 `supacloud-admin`。

#### 安装部署

**一键安装（推荐）**

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
```

Root 引导脚本始终从官方仓库获取。Release/API 下载默认先直连 GitHub，仅在明确配置时回退到可信代理：

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**源码/开发环境手动安装（仅本地产物）**

生产服务器应使用上方经过校验的 `setup.sh` 一键安装链路。源码仓库不包含 Release 产物，因此必须先构建全部组件，并显式启用本地产物模式：

```bash
# 1. 从官方仓库下载代码
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. 构建 Management API、Edge Runtime、pgredis-runtime、Caddy 与 Web Console
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
bun --cwd packages/pgredis-runtime install
bun --cwd packages/pgredis-runtime run build:linux
bun --cwd packages/web-console install --frozen-lockfile
bun --cwd packages/web-console run build
mkdir -p .local/bin dist
GOBIN="$PWD/.local/bin" go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
PATH="$PWD/.local/bin:$PATH" OUT_DIR="$PWD/dist" bash scripts/build_supacloud_caddy.sh

# 3. 显式使用本地产物安装（参数会持久化到 /etc/supabase/install.env）
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 1.2.3.4 --domain api.example.com --s3 juicefs

# 4. 启用命令行工具
source /etc/profile.d/supacloud.sh
```

**生产环境升级**

生产服务器升级时直接替换 `/usr/local/bin/supacloud` 中的 Linux Release 二进制文件，常规升级不需要在服务器上 `git pull` 源码。

```bash
sudo supacloud upgrade --yes
```

安装和升级下载默认先直连 GitHub。只有需要明确回退时才配置可信代理：

```bash
sudo SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example supacloud upgrade --yes
```

Release 产物必须同时通过同一 Release 的 SHA256 和 GitHub build provenance attestation。`SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` 仅用于紧急 break-glass，仍会校验 SHA256，不应作为常规安装配置。

发布产物约定：

- `supacloud-linux-amd64` 和 `supacloud-linux-arm64` 用于生产安装和升级。
- `supacloud-macos-amd64` 和 `supacloud-macos-arm64` 仅用于本地开发、诊断和验证。

**命令行参数详解:**
| 参数 | 说明 | 示例 |
|--------|-------------|---------| 
| `--ip` | 指定内网 IP | `--ip 10.0.0.5` |
| `--domain` | 指定 API 域名 | `--domain supa.com` |
| `--studio` | 指定 Studio 域名| `--studio studio.com`|
| `--s3` | 指定存储类型 | `juicefs`、`minio` 或 `external` |
| `--password`| 统一设置初始密码 | `--password mysecret` |

### 项目管理

#### 用户 CLI：`supacloud-cli`

`supacloud-cli` 默认是项目级 CLI，用于围绕单个项目的部署、日志、数据库与资源管理：

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli project tasks
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref <ref> --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref <ref> --dir supabase/migrations --dry_run
supacloud-cli auth list_providers --ref <ref>
supacloud-cli frontend list --ref <ref>
supacloud-cli edge_functions list --ref <ref>
supacloud-cli storage list_buckets --ref <ref>
```

复杂 SQL、pgvector 查询、单请求事务块建议使用 `--file`，不要依赖 shell 字符串转义。

```sql
BEGIN;
INSERT INTO audit_events(message) VALUES ('started');
INSERT INTO audit_events(message) VALUES ('finished');
COMMIT;
```

SupaCloud 支持单个 SQL 请求内的事务块，也会在 migration endpoint 内部使用事务；不建议提供 `/transaction/begin`、`/transaction/query`、`/transaction/commit` 这类长连接 HTTP 事务 API。应用侧长事务请使用 Postgres 直连 DSN 配合 `pg`、`postgres.js` 等驱动。

pgvector 示例：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX documents_embedding_hnsw_idx
ON documents
USING hnsw (embedding vector_cosine_ops);

SELECT id, content
FROM documents
ORDER BY embedding <=> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

`supacloud-cli` 有意不承载平台安装、升级、SSH 诊断、tenant runtime 管理，以及项目创建/删除/暂停这类平台级命令。

#### 管理员 CLI：`supacloud-admin`

```bash
supacloud-admin status
supacloud-admin ssh ping
supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
supacloud-admin ssh diagnose
supacloud-admin project list
supacloud-admin project create --name my-app
supacloud-admin project delete --ref <ref>
supacloud-admin project pause --ref <ref>
supacloud-admin platform metrics
```

#### Management API

REST API 运行在 9090 端口，Swagger 文档地址：`/swagger`

```bash
# 创建项目
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "我的项目", "region": "local"}'

# 列出项目
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# 获取 API 密钥
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**核心 API 端点：**

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/v1/projects` | 获取项目列表 |
| POST | `/v1/projects` | 创建项目 |
| GET | `/v1/projects/:ref` | 获取项目详情 |
| PATCH | `/v1/projects/:ref` | 更新项目 |
| DELETE | `/v1/projects/:ref` | 删除项目（软删除） |
| POST | `/v1/projects/:ref/pause` | 暂停项目 |
| POST | `/v1/projects/:ref/restore` | 恢复项目 |
| GET | `/v1/projects/:ref/status` | 获取状态 |
| GET | `/v1/projects/:ref/health` | 获取健康状态 |
| GET | `/v1/projects/:ref/dashboard/summary` | 获取带缓存的控制台汇总数据 |
| POST | `/v1/projects/:ref/restart` | 重启服务 |
| GET | `/v1/projects/:ref/settings` | 获取配置 |
| PUT | `/v1/projects/:ref/settings` | 更新配置 |
| GET | `/v1/projects/:ref/api-keys` | 获取 API 密钥 |
| POST | `/v1/projects/:ref/api-keys/rotate` | 轮换旧版 JWT API 密钥 |
| POST | `/v1/projects/:ref/api-keys/rotate-opaque` | 独立轮换 Publishable/Secret Key，不影响 JWT 会话 |
| GET | `/v1/projects/:ref/auth/oauth-server` | 获取项目 OAuth/OIDC 状态 |
| POST | `/v1/projects/:ref/auth/oauth-server/migrate` | 将项目迁移到 OIDC 签名密钥 |
| GET/POST/PUT/DELETE | `/v1/projects/:ref/auth/oauth-clients*` | 项目运行时的 OAuth 客户端管理 |
| GET | `/v1/projects/:ref/types/typescript` | 自动生成 TypeScript 类型 |
| PATCH | `/v1/projects/:ref/config/auth` | 自定义鉴权及三方 OAuth |
| GET | `/v1/projects/:ref/secrets` | 管理 Edge Functions Secrets |

`/v1/projects/:ref/functions*` 下的函数管理读取接口需要 project service role 或 admin 鉴权。公开函数调用仍走 `/functions/v1/*`，继续使用标准 Supabase 函数鉴权模型。

**扩展 API 端点：**

| 分类 | 端点 | 说明 |
|------|------|------|
| 数据库 | `/v1/projects/:ref/database/*` | SQL 查询、Schema 检查、数据迁移、防御性分页 |
| 鉴权 | `/v1/projects/:ref/config/auth`, `/v1/projects/:ref/auth/*` | OAuth 登录、OAuth/OIDC Provider 迁移、微信/支付宝/钉钉 |
| 前端托管 | `/v1/projects/:ref/frontend/*` | Pages 托管、自动部署、自定义域名 |
| Webhook | `/v1/webhooks/github` | GitHub Webhook CI/CD 自动部署 |
| 存储 | `/v1/storage/*` | Bucket 管理、文件上传、一次性 signed upload、S3 迁移 |
| 扩展 | `/v1/extensions/*` | PostgreSQL 扩展市场 |
| 扩缩容 | `/v1/projects/:ref/scaling/*` | 垂直升级与水平副本 |
| 备份 | `/v1/projects/:ref/backups/*` | 数据库备份与恢复 |
| 监控 | `/v1/monitor/*` | 数据库监控与健康检查 |
| 安全 | `/v1/security/*` | 防火墙规则与 SSL 证书 |
| 部署 | `/v1/deploy/*` | Edge Function 部署 |
| 任务 | `/v1/projects/:ref/tasks/*` | 后台 AI/通用异步任务生命周期观测与监控，支持 `summary=true` 轻量列表 |
| **日志 SSE** | `GET /v1/projects/:ref/logs/stream` | **实时日志流（Server-Sent Events）** |
| **限流** | `GET/PUT /v1/projects/:ref/gateway/rate-limit` 及 `custom-rate-limits` | **编程式架构与客户端路由自定限流（Caddy 路由策略）** |
| **网关路由** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **受控自定义 Caddy 路由（反代、静态、重定向、请求头、CORS、优先级）** |
| **WebSocket** | `ws://host/ws/tasks` | **实时任务进度推送** |

#### 运行时切换

```bash
# 切换 Edge Runtime 部署模式
./switch.sh runtime embedded   # 由 supacloud.service 管理
./switch.sh runtime external   # 独立 supacloud-edge-runtime.service

# 切换存储后端
./switch.sh storage juicefs    # 或: minio, external

# 查看当前配置
./switch.sh status
```

**Edge Runtime 架构 (Bun 模式):**

```
SupaCloud (:9090)          Edge Runtime（EDGE_RUNTIME_PORT，默认 :9005）
├── Management API    ←──  默认由 supacloud.service 管理
├── Web Console            ├── Elysia Server
├── SSE 日志流              ├── Worker 线程池 (4 线程，固定)
├── WebSocket /ws/tasks    ├── Deno 兼容层
└── 静态资源 (ETag/304)    ├── URL Import 插件
                           └── /preheat (零冷启动预热)

Edge Runtime 父进程 ── 内部 capability ──► pgredis-runtime (:9010)
                                         ├── 每租户 PostgreSQL 连接池
                                         └── 有界 L1 + LISTEN/NOTIFY

Caddy 网关 (Admin API 驱动):
  Automatic HTTPS、动态路由 JSON 发布、安全响应头、限流、CORS
  /api/*        → :9090 (管理 API)
  /functions/*  → :9090 (sdk-proxy，异步入队 + 同步转发)
```

生产环境从不手改 Caddyfile。Management API 将完整的 Caddy 配置以 JSON 形式保存在内存中（`GatewayService`），每次路由 / 限流 / 证书变更都会：
1. 渲染出完整的 Caddy JSON 配置；
2. 用 `caddy validate --config <tmp>` 校验；
3. 通过 Caddy Admin API 的 `POST /load`（`CADDY_ADMIN_URL`，默认 `http://127.0.0.1:2019`）热加载；
4. 将已应用的 JSON 原子写入 `CADDY_CONFIG_PATH`，用于重启后 hydrate 恢复，并在同目录写入 `DO-NOT-EDIT.txt`。

打包的 Caddyfile 只负责开启 Admin API 监听和最小 catch-all 引导；租户路由、TLS、CORS 与限流全部由注入的 JSON 接管。`GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` 和 `POST /v1/projects/:ref/gateway/config` 就是驱动这些 JSON 更新的用户侧接口。

启动来源因部署模式而异：systemd 安装用 `supacloud-caddy run --config /etc/supacloud/caddy/config.json`（纯 JSON，无 Caddyfile，初始 JSON 由 `install.sh` 预置）；docker 的 `self-host` 和 `dev` 栈以官方 `caddy` 镜像 + 纯引导 Caddyfile（`admin 0.0.0.0:2019` + `auto_https off` + `503` 占位）启动，Management API 健康（监听 `:9090`）后通过 `POST /load` 发布完整 JSON 配置，并带退避重试直到 Caddy 可达。无论哪种模式，真正生效的路由配置都是经 Admin API 注入的 JSON。

此外，Management API 运行周期性 `gateway-health.worker` 轮询 Caddy Admin API；一旦检测到"从不可达恢复可达"（如 systemd 下 caddy 重启或 docker 下容器重启），即触发 `rebuildAllTenantConfigs()` 重新发布完整路由 JSON，保持生效配置与内存态一致，两种部署模式都具备自愈能力。

完整字段说明、curl 示例（反代、静态托管、HTTPS 上游）、限流 tier、单路径自定义限流，以及自定义路由与租户 CORS 的组合行为，见 [docs/gateway-customization.md](docs/gateway-customization.md)。

默认安装使用 `EDGE_RUNTIME_MODE=embedded`，也就是由 `supacloud.service` 直接拉起 Bun Edge Runtime 子进程。`EDGE_RUNTIME_MODE=external` 时可以改用独立的 `supacloud-edge-runtime.service`，但两种模式不能同时运行，否则会争抢 `EDGE_RUNTIME_PORT`（默认 `9005`）。

`pgredis-runtime` 是独立、仅内部可达的数据面服务。Edge 父进程为每次请求签发短时、项目级 capability；被模块缓存的 Worker 代码只看到稳定的 `globalThis.SupaCloud.pgredis` facade，不会拿到 PostgreSQL 凭据、连接池、L1 状态或 runtime 签名密钥。该服务不经过 Caddy，也不映射宿主机/容器端口；Edge v1 只提供 KV/TTL。已认证运维人员通过 Web Console 或 Management API 代理查看有界运行状态、执行精确键操作及二次确认后的项目命名空间清空，浏览器不会直连 `9010`。平台队列仍唯一使用 PGMQ，网关限流仍唯一由 Caddy 负责。

| 特性 | 当前 Bun Runtime |
|------|------------------|
| 内存 (200 函数) | **~140MB** |
| 冷启动 | **< 10ms (预热后: 0ms)** |
| 预热延迟 | <1ms |
| Deno 代码兼容 | ✅ 兼容层 |
| 隔离级别 | Worker 线程 |
| 用户函数改动 | **零改动** |

### 后台函数路由

公开 Edge Function 流量先进入 Management API：

- `/functions/v1/*` 路由到 `:9090`
- `sdk-proxy` 根据函数配置决定异步入队并返回 `202 Accepted`，或同步转发到 Bun Edge Runtime
- 浏览器和 `supabase-js` 调用方继续使用标准 `functions.invoke()`

后台执行通过服务端函数配置 `background_routes` 开启。对 `/generate/crop`、`/generate/matting`、`/generate/video` 这类耗时路径，推荐使用 `background_routes`，避免依赖浏览器自定义请求头。

### Realtime 路由与恢复

Realtime 流量也先进入 Management API：

- `/realtime/v1/websocket` 路由到 `:9090`
- Management API 负责 websocket upgrade 并代理到上游 Realtime
- Caddy 不应把浏览器 websocket 流量直接指向 Elixir Realtime 容器

安装或迁移后如果 Realtime 订阅异常，可以运行：

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

### PostgREST 运行时生命周期

每个项目仍然使用独立的 PostgREST 进程，但 Management API 现在把它当成受控运行时组件管理，支持显式 desired state：

- `GET /v1/projects/:ref/services/postgrest/status`
- `POST /v1/projects/:ref/services/postgrest/start|stop|restart|pause|resume`

desired state 保存在项目专用元数据列里（`postgrest_desired`、`postgrest_actual`、`postgrest_health` 及相关时间戳），runtime reconcile worker 会把实际 systemd 状态对齐到它。这里是显式生命周期管理，不做空闲自动收缩，所以请求路径性能不变。

#### CLI 入口

面向真人操作者的命令行现已拆分为：

- `@supacloud/cli` / `supacloud-cli`：项目使用者 CLI，默认从当前目录 `.env` 自动绑定项目
- `supacloudctl cli ...`：统一本地入口，普通分发默认离线且不访问 npm；需要时显式运行 `supacloudctl check-update cli`
- `@supacloud/admin` / `supacloud-admin`：服务器管理员 CLI，处理 SSH、安装、升级、tenant 运维
- `supacloudctl admin ...`：统一本地入口，同样默认离线；需要时显式运行 `supacloudctl check-update admin`
- 已安装服务器上的 `/usr/local/bin/supacloud` 仍是编译后的服务端二进制，服务端升级继续使用 `sudo supacloud upgrade --yes`


### 项目结构

```
supacloud/
├── install.sh                  # 一键部署脚本
├── setup.sh                    # 远程安装引导
├── switch.sh                   # 运行时/存储切换工具
├── supacloud                   # CLI 管理工具 (Shell 入口)
├── config.env                  # 只读、受 Git 跟踪的默认模板
├── packages/
│   ├── management-api/         # REST API 服务 (Bun + Elysia)
│   │   ├── src/
│   │   │   ├── routes/         # 20 个路由模块 (projects, auth, frontend, webhook, ws, logs 等)
│   │   │   ├── services/       # 20 个服务模块
│   │   │   ├── cli/            # CLI 子命令 (lifecycle, project)
│   │   │   ├── db/             # 数据库层、迁移、withRetry 优雅降级
│   │   │   ├── middleware/     # 认证中间件
│   │   │   ├── infra/          # 健康检查器
│   │   │   ├── install.ts      # 交互式安装器
│   │   │   ├── upgrade.ts      # 升级向导
│   │   │   └── doctor.ts       # 系统诊断
│   │   └── tests/              # 单元测试 (17) & 集成测试
│   ├── cli/                    # 项目使用者 CLI
│   │   └── src/
│   ├── admin/                  # 服务器管理员 CLI
│   │   └── src/
│   ├── supacloud-lite/          # Bun + PGlite 单项目 Supabase 兼容运行时
│   │   └── README.md            # Lite 使用、迁移与兼容性说明
│   ├── edge-runtime/           # Bun 云函数运行时
│   │   ├── server.ts           # Elysia 服务（EDGE_RUNTIME_PORT，默认 :9005）+ /preheat 预热端点
│   │   ├── worker-pool.ts      # 固定大小 Worker 线程池 + preheat()
│   │   ├── worker-executor.ts  # 函数加载器 + LRU 缓存 + 预热消息
│   │   ├── deno-compat.ts      # Deno API 兼容层
│   │   ├── url-import-plugin.ts# Bun Plugin: URL import 拦截
│   │   └── shims/              # Deno 标准库替代实现
│   └── web-console/            # SvelteKit 管理面板
│       └── src/                # 组件, 路由, 资源
├── scripts/
│   └── lib/                    # Shell 脚本模块
│       ├── db_manager.sh       # 数据库生命周期
│       ├── gateway provider    # Caddy 路由发布由 management-api 内部管理
│       ├── tenant_runtime.sh   # 租户 PostgREST & GoTrue 运行时
│       ├── function_manager.sh # 云函数管理
│       ├── s3_manager.sh       # 存储后端管理
│       ├── jwt_manager.sh      # JWT 密钥生成
│       ├── backup_manager.sh   # 备份操作
│       ├── ha_manager.sh       # 高可用
│       ├── security_manager.sh # 防火墙 & SSL
│       ├── storage_manager.sh  # 存储操作
│       ├── extension_manager.sh# PostgreSQL 扩展
│       ├── global_router.ts    # 全局路由逻辑
│       └── worker_runner.ts    # 后台 Worker
├── infra/
│   ├── os/                     # 操作系统配置
│   └── postgres/               # PostgreSQL 配置
├── docs/                       # 15 篇技术文档
│   ├── deploy-guide.md         # 部署指南
│   ├── architecture-multi-tenant.md  # 架构设计
│   ├── china-oauth-integration.md    # 国内 OAuth 集成
│   └── ...                     # 详见 docs/README.md 完整索引
└── .github/
    └── workflows/              # CI/CD (build-studio, management-api, release)
```

### 配置说明

`config.env` 仅是只读默认模板。安装输入持久化在 `/etc/supabase/install.env`，Management API 运行时配置独立保存在 `/etc/supabase/management-api.env`；禁止用运行时配置覆盖安装输入。

关键安装配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SUPABASE_PUBLIC_DOMAIN` | 全局 API 网关域名 | 生产必填；安装器可自动生成 |
| `SUPABASE_STUDIO_DOMAIN` | 全局控制台域名 | 可留空，默认从 API 域名派生 |
| `S3_STORAGE_TYPE` | 存储后端 | `juicefs` |
| `TUS_MAX_SIZE` | 断点续传上传最大大小 | `524288000` (500 MiB) |
| `TUS_MAX_CHUNK_SIZE` | 断点续传分片最大大小 | `16777216` (16 MiB) |
| `EDGE_RUNTIME` | 云函数运行时 | `bun` |
| `PG_VERSION` | PostgreSQL 版本 | `18` |
| `PIGSTY_VERSION` | Pigsty 版本 | `v4.4.0` |
| `SUPACLOUD_LOGS_ENABLED` | 内置采集器 + VictoriaLogs 项目日志（不使用 Logflare） | `true` |
| `SUPACLOUD_PIPELINES_ENABLED` | 用于 BigQuery CDC Pipelines 的固定版本 Supabase ETL 运行时 | `true` |

### 参考文档

- [文档索引](docs/README.md)
- [部署指南](docs/deploy-guide.md)
- [多租户架构设计](docs/architecture-multi-tenant.md)
- [OAuth 2.1 / OIDC Provider](docs/oauth-oidc-provider.md)
- [国内 OAuth 集成](docs/china-oauth-integration.md)
- [Pigsty 官方文档](https://pigsty.cc/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
