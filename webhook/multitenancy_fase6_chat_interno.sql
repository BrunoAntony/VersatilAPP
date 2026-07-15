-- ============================================================
--  APP VERSATIL — Chat Interno (mensagens entre a equipe, sem WhatsApp)
-- ------------------------------------------------------------
--  Um chat único por empresa (tipo um "geral" de equipe) — todo
--  usuário da empresa (admin ou funcionário) vê e manda mensagem
--  ali, sem envolver o WhatsApp/uazapi.
--
--  PRÉ-REQUISITO: multitenancy_fase0/fase1 já rodados (usa
--  auth_empresa_id() e set_empresa_id()).
--
--  Seguro rodar mais de uma vez (idempotente).
--
--  Como rodar: Supabase → seu projeto → SQL Editor → cole tudo
--  abaixo → Run.
-- ============================================================

create table if not exists public.chat_interno (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id),
  autor_id uuid not null references public.app_users(id),
  autor_nome text not null,
  texto text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_interno enable row level security;

drop trigger if exists trg_set_empresa_id on public.chat_interno;
create trigger trg_set_empresa_id before insert on public.chat_interno
  for each row execute function public.set_empresa_id();

-- leitura: todo mundo da empresa vê todas as mensagens
drop policy if exists "leitura_empresa" on public.chat_interno;
create policy "leitura_empresa" on public.chat_interno for select to authenticated
  using (empresa_id = public.auth_empresa_id());

-- envio: só pode mandar mensagem em nome de si mesmo
drop policy if exists "envio_proprio" on public.chat_interno;
create policy "envio_proprio" on public.chat_interno for insert to authenticated
  with check (empresa_id = public.auth_empresa_id() and autor_id = auth.uid());

-- exclusão: só a própria mensagem
drop policy if exists "excluir_proprio" on public.chat_interno;
create policy "excluir_proprio" on public.chat_interno for delete to authenticated
  using (empresa_id = public.auth_empresa_id() and autor_id = auth.uid());
