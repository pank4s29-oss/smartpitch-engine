-- SmartPitch Engine: run in Supabase SQL Editor before connecting the website.
-- Every customer can only access rows with their own user_id.
create extension if not exists pgcrypto;

create table public.domain_profiles (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  domain_tag text not null, audience text not null, price_tier text not null check (price_tier in ('low','high')),
  business_constraints jsonb not null default '[]'::jsonb, created_at timestamptz not null default now()
);
create table public.audience_pain_points (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  domain_profile_id uuid not null references public.domain_profiles(id) on delete cascade,
  surface_problem text not null, deep_desire text not null, source text not null default 'user_input', created_at timestamptz not null default now()
);
create table public.product_solutions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  domain_profile_id uuid not null references public.domain_profiles(id) on delete cascade,
  pain_point_id uuid not null references public.audience_pain_points(id) on delete cascade,
  product_name text not null, core_selling_point text not null, solution_description text not null,
  trust_proof text, created_at timestamptz not null default now()
);
create table public.generation_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  domain_profile_id uuid not null references public.domain_profiles(id) on delete cascade,
  target_platform text not null, product_name text not null, product_description text not null,
  status text not null default 'completed', strategy jsonb, created_at timestamptz not null default now()
);
create table public.generation_params (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null references public.generation_requests(id) on delete cascade,
  length_type text not null, custom_word_count integer, tone text not null, primary_emotion text not null,
  secondary_emotions jsonb not null default '[]'::jsonb, block_order jsonb not null default '[]'::jsonb
);
create table public.copy_variants (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null references public.generation_requests(id) on delete cascade,
  angle_type text not null, title text not null, body text not null, cta text not null,
  platform_format text not null, block_order jsonb not null default '[]'::jsonb,
  review jsonb not null, adopted boolean not null default false, created_at timestamptz not null default now()
);
create table public.copy_blocks (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  copy_variant_id uuid not null references public.copy_variants(id) on delete cascade,
  block_type text not null, block_content text not null, word_count integer not null
);
create table public.swipe_copies (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  raw_content text not null, source_url text, industry_tag text not null, framework_tag text not null,
  emotion_tags jsonb not null default '[]'::jsonb, angle_type text not null,
  block_breakdown jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), edited_at timestamptz
);

alter table public.domain_profiles enable row level security;
alter table public.audience_pain_points enable row level security;
alter table public.product_solutions enable row level security;
alter table public.generation_requests enable row level security;
alter table public.generation_params enable row level security;
alter table public.copy_variants enable row level security;
alter table public.copy_blocks enable row level security;
alter table public.swipe_copies enable row level security;

-- Identical policies are deliberate: own-row isolation for all app records.
grant select, insert, update, delete on all tables in schema public to authenticated;
create policy "own domain profiles" on public.domain_profiles for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own pain points" on public.audience_pain_points for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own solutions" on public.product_solutions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own generation requests" on public.generation_requests for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own generation params" on public.generation_params for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own copy variants" on public.copy_variants for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own copy blocks" on public.copy_blocks for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own swipe copies" on public.swipe_copies for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create index generation_requests_user_created on public.generation_requests(user_id, created_at desc);
create index swipe_copies_user_created on public.swipe_copies(user_id, created_at desc);