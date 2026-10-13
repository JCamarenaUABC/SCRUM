const API = "";
let token = localStorage.getItem("token") || "";
let user = JSON.parse(localStorage.getItem("user") || "null");
let boards = [];
let boardId = null;
let columns = [];
let tasks = [];
let users = [];
let editingTask = null;
let memberGroup = null;

/* ---------- helpers ---------- */
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401) { logout(); throw new Error("Sesión expirada"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Error en la petición");
  return data;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add("hidden"), 2600);
}

function setRoleUI() {
  const isAdmin = user?.role === "ADMINISTRADOR";
  const canScm = isAdmin || user?.role === "SCRUMMASTER";
  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  $$(".admin-scm-only").forEach((el) => el.classList.toggle("hidden", !canScm));
  $("#role-badge").textContent = user?.role || "";
  $("#user-name").textContent = user?.name || "";
}

/* ---------- auth ---------- */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const form = new FormData(e.target);
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
    });
    token = data.token;
    user = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(user));
    startApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

function logout() {
  token = "";
  user = null;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
}

$("#logout").addEventListener("click", logout);

/* ---------- navegación ---------- */
$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $$("#app-view main > section").forEach((s) => s.classList.add("hidden"));
    $(`#view-${tab.dataset.view}`).classList.remove("hidden");
    if (tab.dataset.view === "groups") loadGroups();
    if (tab.dataset.view === "users") loadUsers();
  })
);

async function startApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  setRoleUI();
  await loadBoards();
}

async function loadBoards() {
  boards = await api("/api/boards");
  const sel = $("#board-select");
  sel.innerHTML = boards.map((b) => `<option value="${b.id}">${b.name} · ${b.task_count} tareas</option>`).join("");
  if (boards.length) {
    boardId = boards[0].id;
    sel.value = boardId;
    await loadBoard();
  } else {
    $("#board").innerHTML = `<p class="muted">Aún no hay tableros. Crea un grupo.</p>`;
  }
}

$("#board-select").addEventListener("change", async (e) => {
  boardId = e.target.value;
  await loadBoard();
});

async function loadBoard() {
  if (!boardId) return;
  const data = await api(`/api/boards/${boardId}`);
  columns = data.columns;
  tasks = data.tasks;
  if (user?.role === "ADMINISTRADOR") {
    users = await api("/api/users");
  }
  renderBoard();
}

/* ---------- render tablero ---------- */
function renderBoard() {
  const board = $("#board");
  if (!columns.length) {
    board.innerHTML = `<p class="muted">Este tablero no tiene columnas.</p>`;
    return;
  }
  board.innerHTML = columns
    .map((col) => {
      const items = tasks.filter((t) => t.column_id === col.id);
      const canDelete = ["ADMINISTRADOR", "SCRUMMASTER"].includes(user?.role);
      return `
      <div class="column" data-column="${col.id}">
        <div class="column-head">
          <span>${col.name} <span class="count">${items.length}</span></span>
          ${canDelete ? `<button class="del" data-del-col="${col.id}" title="Eliminar columna">✕</button>` : ""}
        </div>
        <div class="tasks" data-tasks="${col.id}">
          ${items.map(taskCard).join("")}
        </div>
      </div>`;
    })
    .join("");
  bindDragAndDrop();
  $$("[data-del-col]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta columna y sus tareas?")) return;
      await api(`/api/columns/${b.dataset.delCol}`, { method: "DELETE" });
      toast("Columna eliminada");
      loadBoard();
    })
  );
}

function taskCard(t) {
  return `
  <article class="task" draggable="true" data-task="${t.id}">
    <h5>${escapeHtml(t.title)}</h5>
    ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ""}
    <div class="task-meta">
      <span class="pill ${t.priority}">${t.priority}</span>
      ${t.assignee_name ? `<span class="pill">${escapeHtml(t.assignee_name)}</span>` : ""}
    </div>
  </article>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---------- drag & drop ---------- */
function bindDragAndDrop() {
  $$(".task").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.task);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", () => openTaskModal(card.dataset.task));
  });

  $$(".column").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const taskId = e.dataTransfer.getData("text/plain");
      const columnId = col.dataset.column;
      if (!taskId) return;
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ column_id: columnId })
      });
      toast("Tarea movida");
      loadBoard();
    });
  });
}

/* ---------- modal tarea ---------- */
function openTaskModal(taskId) {
  editingTask = taskId ? tasks.find((t) => t.id === taskId) : null;
  const canDelete = ["ADMINISTRADOR", "SCRUMMASTER"].includes(user?.role);

  $("#task-modal-title").textContent = editingTask ? "Editar tarea" : "Nueva tarea";
  $("#task-title").value = editingTask?.title || "";
  $("#task-desc").value = editingTask?.description || "";
  $("#task-priority").value = editingTask?.priority || "MEDIA";
  $("#task-column").innerHTML = columns.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  $("#task-column").value = editingTask?.column_id || columns[0]?.id;

  const members = users.filter((u) => !boardId || true);
  $("#task-assignee").innerHTML =
    `<option value="">Sin asignar</option>` +
    members.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  $("#task-assignee").value = editingTask?.assigned_to || "";

  const del = $("#task-delete");
  if (del) del.remove();
  if (editingTask && canDelete) {
    const btn = document.createElement("button");
    btn.id = "task-delete";
    btn.className = "btn danger";
    btn.textContent = "Eliminar";
    btn.onclick = async () => {
      if (!confirm("¿Eliminar la tarea?")) return;
      await api(`/api/tasks/${editingTask.id}`, { method: "DELETE" });
      closeTaskModal();
      toast("Tarea eliminada");
      loadBoard();
    };
    $(".modal-actions").prepend(btn);
  }

  $("#task-modal").classList.remove("hidden");
}

function closeTaskModal() {
  $("#task-modal").classList.add("hidden");
  editingTask = null;
}

$("#new-task").addEventListener("click", () => openTaskModal(null));
$("#task-cancel").addEventListener("click", closeTaskModal);
$("#task-modal").addEventListener("click", (e) => {
  if (e.target.id === "task-modal") closeTaskModal();
});

$("#task-save").addEventListener("click", async () => {
  const payload = {
    title: $("#task-title").value.trim(),
    description: $("#task-desc").value.trim() || null,
    column_id: $("#task-column").value,
    priority: $("#task-priority").value,
    assigned_to: $("#task-assignee").value || null
  };
  if (!payload.title) return toast("El título es obligatorio", "err");
  try {
    if (editingTask) {
      await api(`/api/tasks/${editingTask.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      toast("Tarea actualizada");
    } else {
      await api(`/api/boards/${boardId}/tasks`, { method: "POST", body: JSON.stringify(payload) });
      toast("Tarea creada");
    }
    closeTaskModal();
    loadBoard();
  } catch (err) {
    toast(err.message, "err");
  }
});

$("#add-column").addEventListener("click", async () => {
  const name = prompt("Nombre de la nueva columna:");
  if (!name) return;
  await api("/api/columns", { method: "POST", body: JSON.stringify({ board_id: boardId, name }) });
  toast("Columna creada");
  loadBoard();
});

/* ---------- grupos ---------- */
$("#add-group").addEventListener("click", async () => {
  const name = $("#new-group").value.trim();
  if (!name) return toast("Escribe un nombre", "err");
  try {
    await api("/api/groups", { method: "POST", body: JSON.stringify({ name }) });
    $("#new-group").value = "";
    toast("Grupo creado");
    loadGroups();
    loadBoards();
  } catch (err) {
    toast(err.message, "err");
  }
});

async function loadGroups() {
  const groups = await api("/api/groups");
  $("#groups").innerHTML = groups.length
    ? groups
        .map(
          (g) => `
      <div class="gcard">
        <h4>${escapeHtml(g.name)}</h4>
        <div class="members">${
          g.members.length ? g.members.map((m) => escapeHtml(m.name)).join(", ") : "Sin miembros"
        }</div>
        <div class="actions">
          <button class="btn ghost sm" data-members="${g.id}">Miembros (${g.members.length})</button>
          <button class="btn danger sm" data-del-group="${g.id}">Eliminar</button>
        </div>
      </div>`
        )
        .join("")
    : `<p class="muted">No hay grupos todavía.</p>`;

  $$("[data-members]").forEach((b) => b.addEventListener("click", () => openMembers(b.dataset.members)));
  $$("[data-del-group]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar el grupo y su tablero?")) return;
      await api(`/api/groups/${b.dataset.delGroup}`, { method: "DELETE" });
      toast("Grupo eliminado");
      loadGroups();
      loadBoards();
    })
  );
}

async function openMembers(groupId) {
  memberGroup = groupId;
  const groups = await api("/api/groups");
  const group = groups.find((g) => g.id === groupId);
  const all = await api("/api/users");

  $("#member-modal-title").textContent = `Miembros de ${group.name}`;
  $("#member-list").innerHTML = group.members.length
    ? group.members
        .map(
          (m) => `<div class="member-item"><span>${escapeHtml(m.name)} · ${m.role}</span>
            <button class="btn danger sm" data-rm="${m.id}">Quitar</button></div>`
        )
        .join("")
    : `<p class="muted">Sin miembros asignados.</p>`;

  const free = all.filter((u) => !group.members.some((m) => m.id === u.id) && !u.group_id);
  $("#member-user").innerHTML = free.length
    ? free.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (${u.email})</option>`).join("")
    : `<option value="">No hay usuarios disponibles</option>`;

  $$("[data-rm]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/groups/${groupId}/members/${b.dataset.rm}`, { method: "DELETE" });
      openMembers(groupId);
      loadGroups();
    })
  );
  $("#member-modal").classList.remove("hidden");
}

$("#member-add").addEventListener("click", async () => {
  const userId = $("#member-user").value;
  if (!userId) return;
  await api(`/api/groups/${memberGroup}/members`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
  openMembers(memberGroup);
  loadGroups();
});

$("#member-close").addEventListener("click", () => $("#member-modal").classList.add("hidden"));

/* ---------- usuarios ---------- */
async function loadUsers() {
  users = await api("/api/users");
  const groups = await api("/api/groups");
  $("#users-table").innerHTML = users
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>
        <select class="select" data-role="${u.id}">
          ${["ADMINISTRADOR", "SCRUMMASTER", "OPERADOR"]
            .map((r) => `<option ${u.role === r ? "selected" : ""}>${r}</option>`)
            .join("")}
        </select>
      </td>
      <td>
        <select class="select" data-grp="${u.id}">
          <option value="">— sin grupo —</option>
          ${groups.map((g) => `<option value="${g.id}" ${u.group_id === g.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn danger sm" data-del-user="${u.id}">Eliminar</button></td>
    </tr>`
    )
    .join("");

  $$("[data-role]").forEach((s) =>
    s.addEventListener("change", async () => {
      await api(`/api/users/${s.dataset.role}`, { method: "PATCH", body: JSON.stringify({ role: s.value }) });
      toast("Rol actualizado");
    })
  );
  $$("[data-grp]").forEach((s) =>
    s.addEventListener("change", async () => {
      await api(`/api/users/${s.dataset.grp}`, { method: "PATCH", body: JSON.stringify({ group_id: s.value || null }) });
      toast("Grupo actualizado");
    })
  );
  $$("[data-del-user]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar usuario?")) return;
      await api(`/api/users/${b.dataset.delUser}`, { method: "DELETE" });
      toast("Usuario eliminado");
      loadUsers();
    })
  );
}

$("#add-user").addEventListener("click", async () => {
  const payload = {
    name: $("#new-user-name").value.trim(),
    email: $("#new-user-email").value.trim(),
    password: $("#new-user-pass").value,
    role: $("#new-user-role").value
  };
  if (!payload.email || !payload.password) return toast("Email y contraseña son obligatorios", "err");
  try {
    await api("/api/auth/register", { method: "POST", body: JSON.stringify(payload) });
    ["#new-user-name", "#new-user-email", "#new-user-pass"].forEach((s) => ($(s).value = ""));
    toast("Usuario creado");
    loadUsers();
  } catch (err) {
    toast(err.message, "err");
  }
});

/* ---------- inicio ---------- */
if (token && user) {
  api("/api/auth/me")
    .then((data) => {
      user = data.user;
      localStorage.setItem("user", JSON.stringify(user));
      startApp();
    })
    .catch(() => logout());
}
