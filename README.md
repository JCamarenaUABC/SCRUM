# Scrumboard — Flask + Postgres (Supabase) + Vercel

Tablero Scrum con usuarios, grupos de trabajo, roles (ADMINISTRADOR, SCRUMMASTER, OPERADOR) y tareas movibles entre columnas (drag & drop).

## Estructura

```
scrumboard/
├── api/index.py        # entrypoint para Vercel
├── app.py              # API Flask
├── schema.sql          # esquema de Postgres (ejecutar en Supabase)
├── requirements.txt
├── vercel.json
└── static/             # frontend (HTML/CSS/JS responsivo)
    ├── index.html
    ├── style.css
    └── app.js
```

## 1. Base de datos (Supabase)

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Ve al **SQL Editor** y ejecuta el contenido de `schema.sql`.
3. En **Project Settings → Database → Connection string → URI**, usa la sesión directa:

```
postgresql://postgres.PROYECTO:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres
```

## 2. Variables de entorno

Locales (archivo `.env` o PowerShell):

```powershell
$env:DB_HOST="aws-0-REGION.pooler.supabase.com"
$env:DB_PORT="5432"
$env:DB_NAME="postgres"
$env:DB_USER="postgres.PROYECTO"
$env:DB_PASSWORD="TU_PASSWORD"
$env:DB_SSLMODE="require"
$env:JWT_SECRET="una-clave-larga-y-aleatoria"
```

En Vercel: **Project → Settings → Environment Variables** con las mismas variables
(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE, JWT_SECRET).

## 3. Deploy en Vercel

```bash
cd scrumboard
vercel --prod
```

Vercel detecta `api/index.py` con `@vercel/python` y `vercel.json` enruta todo al Flask.
El frontend se sirve desde el mismo Flask (`/` → `static/index.html`).

## 4. Uso local

```bash
pip install -r requirements.txt
python api/index.py      # http://localhost:5000
```

Primer ingreso (se crea solo al arrancar por primera vez):

- Email: `admin@scrumboard.local`
- Contraseña: `admin123`

Cámbiala desde la API: `POST /api/auth/password` o crea otro administrador en la pestaña **Usuarios**.

## Roles y permisos

| Acción | ADMINISTRADOR | SCRUMMASTER | OPERADOR |
|---|---|---|---|
| Ver tableros y tareas | ✅ | ✅ | ✅ |
| Crear tareas | ✅ | ✅ | ✅ |
| Mover tareas | ✅ | ✅ | ✅ |
| Editar/eliminar cualquier tarea | ✅ | ✅ | ❌ |
| Crear/eliminar columnas | ✅ | ✅ | ❌ |
| Crear grupos y gestionar miembros | ✅ | ❌ | ❌ |
| Crear/eliminar usuarios y cambiar roles | ✅ | ❌ | ❌ |

## API principal

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/login` | Inicia sesión (devuelve JWT) |
| GET | `/api/auth/me` | Usuario del token |
| POST | `/api/groups` | Crea grupo + tablero + columnas |
| GET | `/api/groups` | Lista grupos con miembros |
| POST | `/api/groups/<id>/members` | Asigna usuario a grupo |
| GET | `/api/boards/<id>` | Tablero completo (columnas + tareas) |
| POST | `/api/boards/<id>/tasks` | Crea tarea |
| PATCH | `/api/tasks/<id>` | Edita o **mueve** tarea (column_id) |
| DELETE | `/api/tasks/<id>` | Elimina tarea |
| GET/POST/PATCH/DELETE | `/api/users` | Gestión de usuarios (admin) |
