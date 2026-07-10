-- ============================================================
--  APP VERSATIL — tabela de login (usuário/senha próprios, sem
--  depender do Supabase Auth)
-- ------------------------------------------------------------
--  Guarda só o HASH da senha (scrypt + salt aleatório), nunca a
--  senha em texto puro. Sem nenhuma política de RLS nesta tabela
--  = ninguém consegue ler/gravar nela pela API pública (nem com a
--  anon key, nem logado) — só a função de login do webhook, que
--  usa a service_role key (ignora RLS), consegue acessar.
--
--  Como rodar: Supabase → seu projeto → SQL Editor → cole tudo
--  abaixo → Run.
-- ============================================================

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz default now()
);

alter table public.app_users enable row level security;
-- de propósito: nenhuma política criada aqui = acesso 100% bloqueado via API pública

-- usuário inicial: bruno / versatil@123 (senha já cifrada abaixo, nunca em texto puro)
insert into public.app_users (username, password_hash, password_salt)
values (
  'bruno',
  '217413ea7be26f4077b5f2a797fafab68b32231c0ed22334a33e15677b938d877ace4c2b4aca164ef3fb208c7a250c3ebdafeafe77aeaa162e47d8eb8bf00819',
  '3db2d8e94854da33fbd0af904a77986f'
)
on conflict (username) do nothing;
