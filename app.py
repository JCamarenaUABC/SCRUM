import os
from datetime import datetime, timedelta

import bcrypt
import jwt
import psycopg2
import psycopg2.extras
from flask import Flask, jsonify, request, send_from_directory
from psycopg2 import pool

app = Flask(__name__, static_folder="static", static_url_path="")

JWT_SECRET = os.environ.get("JWT_SECRET", "cambia-este-secreto-en-vercel")
JWT_ALGO = "HS256"
TOKEN_HOURS = 12

DEFAULT_COLUMNS = ["Por hacer", "En progreso", "En revisión", "Terminado"]


class Database:
    def __init__(self):
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            host=os.environ.get("DB_HOST", "localhost"),
            port=os.environ.get("DB_PORT", "5432"),
            dbname=os.environ.get("DB_NAME", "postgres"),
            user=os.environ.get("DB_USER", "postgres"),
            password=os.environ.get("DB_PASSWORD", ""),
            sslmode=os.environ.get("DB_SSLMODE", "prefer"),
        )

    def connection(self):
        return self.pool.getconn()

    def release(self, conn):
        self.pool.putconn(conn)


db = Database()


def query(sql, params=None, fetch="all"):
    conn = db.connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or ())
            if fetch == "all":
                return [dict(r) for r in cur.fetchall()]
            if fetch == "one":
                row = cur.fetchone()
                return dict(row) if row else None
            if fetch == "val":
                row = cur.fetchone()
                return row[0] if row else None
            return None
    finally:
        db.release(conn)


def execute(sql, params=None, returning="id"):
    conn = db.connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or ())
            row = dict(cur.fetchone()) if returning else None
        conn.commit()
        return row
    finally:
        db.release(conn)


def hash_password(raw):
    return bcrypt.hashpw(raw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def check_password(raw, hashed):
    return bcrypt.checkpw(raw.encode("utf-8"), hashed.encode("utf-8"))


def make_token(user):
    payload = {
        "sub": str(user["id"]),
        "email": user["email"],
        "role": user["role"],
        "exp": datetime.utcnow() + timedelta(hours=TOKEN_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def auth_required(*roles):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            header = request.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return jsonify(error="No autenticado"), 401
            try:
                claims = jwt.decode(header[7:], JWT_SECRET, algorithms=[JWT_ALGO])
            except jwt.ExpiredSignatureError:
                return jsonify(error="Sesión expirada"), 401
            except jwt.InvalidTokenError:
                return jsonify(error="Token inválido"), 401
            if roles and claims.get("role") not in roles:
                return jsonify(error="No tienes permisos para esta acción"), 403
            return fn(claims, *args, **kwargs)

        wrapper.__name__ = fn.__name__
        return wrapper

    return decorator


def body():
    return request.get_json(silent=True) or {}


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/health")
def health():
    return jsonify(status="ok", service="scrumboard")


# ---------- AUTH ----------

@app.post("/api/auth/register")
def register():
    data = body()
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""
    role = data.get("role") or "OPERADOR"

    if not email or "@" not in email:
        return jsonify(error="Email inválido"), 400
    if len(password) < 6:
        return jsonify(error="La contraseña debe tener al menos 6 caracteres"), 400
    if role not in ("ADMINISTRADOR", "SCRUMMASTER", "OPERADOR"):
        return jsonify(error="Rol inválido"), 400
    if query("select id from users where email = %s", (email,), "one"):
        return jsonify(error="Ese email ya está registrado"), 409

    user = execute(
        """insert into users (email, password_hash, name, role)
           values (%s, %s, %s, %s) returning id, email, name, role""",
        (email, hash_password(password), name or email.split("@")[0], role),
    )
    return jsonify(user=user, token=make_token(user)), 201


@app.post("/api/auth/login")
def login():
    data = body()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = query("select * from users where email = %s", (email,), "one")
    if not user or not check_password(password, user["password_hash"]):
        return jsonify(error="Credenciales inválidas"), 401

    public = {k: user[k] for k in ("id", "email", "name", "role", "group_id")}
    return jsonify(user=public, token=make_token(public))


@app.get("/api/auth/me")
@auth_required()
def me(claims):
    user = query(
        "select id, email, name, role, group_id from users where id = %s",
        (claims["sub"],),
        "one",
    )
    if not user:
        return jsonify(error="Usuario no encontrado"), 404
    return jsonify(user=user)


@app.post("/api/auth/password")
@auth_required()
def change_password(claims):
    data = body()
    new_password = data.get("new_password") or ""
    if len(new_password) < 6:
        return jsonify(error="La contraseña debe tener al menos 6 caracteres"), 400
    execute("update users set password_hash = %s where id = %s",
            (hash_password(new_password), claims["sub"]))
    return jsonify(ok=True)


# ---------- GRUPOS ----------

@app.get("/api/groups")
@auth_required()
def list_groups():
    groups = query("select * from groups order by name")
    for g in groups:
        g["members"] = query(
            """select u.id, u.name, u.email, u.role
               from users u where u.group_id = %s order by u.name""",
            (g["id"],),
        )
    return jsonify(groups)


@app.post("/api/groups")
@auth_required("ADMINISTRADOR")
def create_group():
    data = body()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify(error="El nombre del grupo es obligatorio"), 400
    if query("select id from groups where name = %s", (name,), "one"):
        return jsonify(error="Ese grupo ya existe"), 409

    group = execute("insert into groups (name) values (%s) returning *", (name,))
    board = execute("insert into boards (name, group_id) values (%s, %s) returning *",
                    ("Scrumboard", group["id"]))
    for i, col in enumerate(DEFAULT_COLUMNS):
        execute("insert into columns (board_id, name, position) values (%s, %s, %s)",
                (board["id"], col, i))
    return jsonify(group=group, board=board), 201


@app.delete("/api/groups/<gid>")
@auth_required("ADMINISTRADOR")
def delete_group(gid):
    if not query("select id from groups where id = %s", (gid,), "one"):
        return jsonify(error="Grupo no encontrado"), 404
    execute("update users set group_id = null where group_id = %s", (gid,))
    execute("delete from groups where id = %s", (gid,))
    return jsonify(ok=True)


@app.post("/api/groups/<gid>/members")
@auth_required("ADMINISTRADOR")
def add_member(gid):
    user_id = body().get("user_id")
    if not user_id:
        return jsonify(error="user_id es obligatorio"), 400
    if not query("select id from users where id = %s", (user_id,), "one"):
        return jsonify(error="Usuario no encontrado"), 404
    if not query("select id from groups where id = %s", (gid,), "one"):
        return jsonify(error="Grupo no encontrado"), 404
    execute("update users set group_id = %s where id = %s", (gid, user_id))
    return jsonify(ok=True)


@app.delete("/api/groups/<gid>/members/<uid>")
@auth_required("ADMINISTRADOR")
def remove_member(gid, uid):
    execute("update users set group_id = null where id = %s and group_id = %s", (uid, gid))
    return jsonify(ok=True)


# ---------- USUARIOS ----------

@app.get("/api/users")
@auth_required("ADMINISTRADOR")
def list_users():
    users = query(
        """select u.id, u.email, u.name, u.role, u.group_id, g.name as group_name
           from users u left join groups g on g.id = u.group_id order by u.name"""
    )
    return jsonify(users)


@app.patch("/api/users/<uid>")
@auth_required("ADMINISTRADOR")
def update_user(uid):
    data = body()
    fields, values = [], []
    if "name" in data:
        fields.append("name = %s")
        values.append(data["name"])
    if "role" in data:
        if data["role"] not in ("ADMINISTRADOR", "SCRUMMASTER", "OPERADOR"):
            return jsonify(error="Rol inválido"), 400
        fields.append("role = %s")
        values.append(data["role"])
    if "group_id" in data:
        fields.append("group_id = %s")
        values.append(data["group_id"])
    if not fields:
        return jsonify(error="Nada que actualizar"), 400
    values.append(uid)
    user = execute(
        f"update users set {', '.join(fields)} where id = %s returning id, email, name, role, group_id",
        values,
    )
    return jsonify(user=user)


@app.delete("/api/users/<uid>")
@auth_required("ADMINISTRADOR")
def delete_user(uid):
    execute("delete from users where id = %s", (uid,))
    return jsonify(ok=True)


# ---------- TABLERO Y TAREAS ----------

@app.get("/api/boards")
@auth_required()
def list_boards():
    boards = query(
        """select b.*, g.name as group_name,
                  (select count(*) from tasks t where t.board_id = b.id) as task_count
           from boards b left join groups g on g.id = b.group_id order by b.created_at"""
    )
    return jsonify(boards)


@app.get("/api/boards/<bid>")
@auth_required()
def get_board(bid):
    board = query("select * from boards where id = %s", (bid,), "one")
    if not board:
        return jsonify(error="Tablero no encontrado"), 404
    columns = query("select * from columns where board_id = %s order by position", (bid,))
    tasks = query("select * from tasks where board_id = %s order by position, created_at", (bid,))
    return jsonify(board=board, columns=columns, tasks=tasks)


@app.get("/api/boards/<bid>/tasks")
@auth_required()
def list_tasks(bid):
    tasks = query(
        """select t.*, u.name as assignee_name
           from tasks t left join users u on u.id = t.assigned_to
           where t.board_id = %s order by t.position, t.created_at""",
        (bid,),
    )
    return jsonify(tasks)


@app.post("/api/boards/<bid>/tasks")
@auth_required("ADMINISTRADOR", "SCRUMMASTER", "OPERADOR")
def create_task(bid):
    data = body()
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify(error="El título es obligatorio"), 400

    column_id = data.get("column_id")
    if not column_id:
        column_id = query(
            "select id from columns where board_id = %s order by position limit 1", (bid,), "val"
        )
    if not column_id:
        return jsonify(error="El tablero no tiene columnas"), 400

    position = query(
        "select coalesce(max(position), -1) + 1 from tasks where column_id = %s", (column_id,), "val"
    )
    task = execute(
        """insert into tasks (board_id, column_id, title, description, assigned_to, priority, position)
           values (%s, %s, %s, %s, %s, %s, %s)
           returning id, board_id, column_id, title, description, assigned_to, priority, position""",
        (
            bid,
            column_id,
            title,
            data.get("description"),
            data.get("assigned_to"),
            data.get("priority") or "MEDIA",
            position,
        ),
    )
    return jsonify(task=task), 201


@app.patch("/api/tasks/<tid>")
@auth_required("ADMINISTRADOR", "SCRUMMASTER", "OPERADOR")
def update_task(tid):
    data = body()
    current = query("select * from tasks where id = %s", (tid,), "one")
    if not current:
        return jsonify(error="Tarea no encontrada"), 404

    target_column = data.get("column_id", current["column_id"])
    if "column_id" in data and data["column_id"] != current["column_id"]:
        position = query(
            "select coalesce(max(position), -1) + 1 from tasks where column_id = %s",
            (data["column_id"],),
            "val",
        )
    else:
        position = data.get("position", current["position"])

    task = execute(
        """update tasks set
             column_id = %s,
             title = %s,
             description = %s,
             assigned_to = %s,
             priority = %s,
             position = %s
           where id = %s
           returning id, board_id, column_id, title, description, assigned_to, priority, position""",
        (
            target_column,
            data.get("title", current["title"]),
            data.get("description", current["description"]),
            data.get("assigned_to", current["assigned_to"]),
            data.get("priority", current["priority"]),
            position,
            tid,
        ),
    )
    return jsonify(task=task)


@app.delete("/api/tasks/<tid>")
@auth_required("ADMINISTRADOR", "SCRUMMASTER")
def delete_task(tid):
    if not query("select id from tasks where id = %s", (tid,), "one"):
        return jsonify(error="Tarea no encontrada"), 404
    execute("delete from tasks where id = %s", (tid,))
    return jsonify(ok=True)


@app.post("/api/columns")
@auth_required("ADMINISTRADOR", "SCRUMMASTER")
def create_column():
    data = body()
    name = (data.get("name") or "").strip()
    board_id = data.get("board_id")
    if not name or not board_id:
        return jsonify(error="name y board_id son obligatorios"), 400
    position = query(
        "select coalesce(max(position), -1) + 1 from columns where board_id = %s", (board_id,), "val"
    )
    column = execute(
        "insert into columns (board_id, name, position) values (%s, %s, %s) returning *",
        (board_id, name, position),
    )
    return jsonify(column=column), 201


@app.delete("/api/columns/<cid>")
@auth_required("ADMINISTRADOR", "SCRUMMASTER")
def delete_column(cid):
    if not query("select id from columns where id = %s", (cid,), "one"):
        return jsonify(error="Columna no encontrada"), 404
    execute("delete from columns where id = %s", (cid,))
    return jsonify(ok=True)


def bootstrap_admin():
    try:
        if query("select id from users limit 1", fetch="one"):
            return
        execute(
            """insert into users (email, password_hash, name, role)
               values (%s, %s, %s, 'ADMINISTRADOR')""",
            ("admin@scrumboard.local", hash_password("admin123"), "Administrador"),
        )
        app.logger.info("Usuario administrador inicial creado")
    except Exception as exc:  # noqa: BLE001
        app.logger.warning("Bootstrap omitido: %s", exc)


@app.before_request
def prepare():
    if request.path == "/health":
        return
    if not hasattr(app, "_bootstrapped"):
        app._bootstrapped = True
        bootstrap_admin()


if __name__ == "__main__":
    bootstrap_admin()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
