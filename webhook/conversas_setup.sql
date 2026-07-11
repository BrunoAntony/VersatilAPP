-- ============================================================
--  APP VERSATIL — histórico de conversas guardado no Supabase
-- ------------------------------------------------------------
--  Uma linha por número de telefone (identificador), com o
--  snapshot inteiro da conversa (mensagens, status, tudo) na
--  coluna "dados". Antes disso, as conversas só existiam no
--  localStorage do navegador — agora persistem entre dispositivos
--  e sobrevivem a limpar o cache/trocar de navegador.
--
--  Como rodar: Supabase → seu projeto → SQL Editor → cole tudo
--  abaixo → Run. Pode rodar mais de uma vez sem problema.
-- ============================================================

create table if not exists public.conversas (
  telefone text primary key,
  nome text,
  canal text,
  dados jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.conversas enable row level security;

drop policy if exists "somente_logados" on public.conversas;
create policy "somente_logados" on public.conversas for all to authenticated using (true) with check (true);
