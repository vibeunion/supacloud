# SupaCloud

[English](README.md) | [简体中文](README.zh-CN.md) | [Español](README.es-ES.md)

---

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
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh | sudo bash
```

El propio bootstrap raíz siempre se obtiene del repositorio oficial. Las descargas de Release/API intentan GitHub directamente primero y usan `SUPACLOUD_GITHUB_PROXY` solo como alternativa explícita:

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**Instalación desde código fuente/entorno de desarrollo (solo artefactos locales)**

Los hosts de producción deben usar el flujo `setup.sh` verificado de un clic mostrado arriba. Una copia del código fuente no tiene artefactos de Release, por lo que debes construir primero todos los componentes requeridos y optar explícitamente al modo de artefacto local:

```bash
# 1. Clonar repositorio
git clone https://github.com/vibeunion/supacloud.git
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

Usa la CLI de administración para una actualización de producción verificada de
varios componentes. Fija versiones exactas de Management y Edge Runtime para
verificar y activar Management, Web Console y un Edge Runtime externo como una
transacción con capacidad de reversión:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.50.27 \
  --edge_runtime_version 0.16.7 \
  --github_proxy direct
```

La transacción requiere `EDGE_RUNTIME_MODE=external` persistido; el modo
embedded se rechaza antes de modificar artefactos de release o servicios.
Conserva la ruta del ejecutable systemd, el puerto, el modo y el estado enabled
de Edge Runtime, y verifica cada componente con su propio SHA256 y attestation
de GitHub. Caddy y GoTrue quedan fuera de esta transacción y no se reemplazan.

Omite `--edge_runtime_version` solo cuando quieras actualizar Management y Web
Console sin cambiar Edge Runtime; la CLI de administración informa ese límite.

Para actualizar solo Management/Web Console, usa el transporte remoto de Admin
y omite `--edge_runtime_version`. El runner es el binario Management objetivo
verificado, no la versión anterior instalada en el servidor.

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.60.1 \
  --artifact_transport remote \
  --github_proxy direct
```

Las descargas de instalación y actualización son directas primero. Configura un proxy de confianza solo cuando se requiere una alternativa explícita:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.60.1 \
  --artifact_transport remote \
  --github_proxy https://your-trusted-proxy.example
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
- Usa `npx @supacloud/admin ssh upgrade --version <management-version> --edge_runtime_version <edge-version>` para la transacción verificada de Management, Web Console y Edge Runtime externo.
- `/usr/local/bin/supacloud` sigue siendo el binario activo del servidor, pero todas las actualizaciones compatibles usan Admin. Las actualizaciones offline protegidas usan el transporte local verificado de Admin, que ejecuta el runner objetivo autenticado; no ejecutes el bundle runner manualmente ni permitas que la versión anterior instalada ejecute una transacción específica de la versión objetivo.


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
