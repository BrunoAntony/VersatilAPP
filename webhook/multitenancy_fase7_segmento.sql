-- ============================================================
--  APP VERSATIL — Segmento da empresa (ex: "geral", "imobiliaria")
-- ------------------------------------------------------------
--  Cada empresa passa a ter um "segmento" que define quais itens
--  de menu aparecem no app pra ela (ex: empresa "imobiliaria" não
--  vê Estoque/Produtos, que só fazem sentido pra quem vende
--  produto físico com controle de quantidade).
--
--  Seguro rodar mais de uma vez (idempotente).
--
--  Como rodar: Supabase → seu projeto → SQL Editor → cole tudo
--  abaixo → Run.
-- ============================================================

alter table public.empresas add column if not exists segmento text not null default 'geral';

alter table public.empresas drop constraint if exists empresas_segmento_check;
alter table public.empresas add constraint empresas_segmento_check check (segmento in ('geral', 'imobiliaria'));
