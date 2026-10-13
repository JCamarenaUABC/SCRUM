create extension if not exists pgcrypto;

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamp with time zone default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  name text not null,
  role text not null check (role in ('ADMINISTRADOR','SCRUMMASTER','OPERADOR')),
  group_id uuid references groups(id) on delete set null,
  created_at timestamp with time zone default now()
);

create table if not exists boards (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Scrumboard',
  group_id uuid references groups(id) on delete cascade,
  created_at timestamp with time zone default now()
);

create table if not exists columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references boards(id) on delete cascade not null,
  name text not null,
  position integer not null,
  created_at timestamp with time zone default now(),
  unique(board_id, position)
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  column_id uuid references columns(id) on delete cascade not null,
  board_id uuid references boards(id) on delete cascade not null,
  title text not null,
  description text,
  assigned_to uuid references users(id) on delete set null,
  priority text check (priority in ('BAJA','MEDIA','ALTA')) default 'MEDIA',
  position integer not null default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_tasks_column on tasks(column_id, position);
create index if not exists idx_tasks_board on tasks(board_id);

create or replace function update_tasks_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tasks_updated_at on tasks;
create trigger trg_tasks_updated_at
before update on tasks
for each row execute function update_tasks_updated_at();

-- El usuario administrador inicial se crea solo en el primer arranque de la app
-- (ver api/index.py -> bootstrap_admin). Credenciales: admin@scrumboard.local / admin123
-- Cambia la contraseña después del primer ingreso.