-- SmartPitch Engine: run in Supabase SQL Editor before connecting the website.
-- Every customer can only access rows with their own user_id.
create extension if not exists pgcrypto;

create table public.domain_profiles (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  domain_tag text not null, audience text not null, price_tier text not null check (price_tier in ('low','high')),
  business_constraints jsonb not null default '[]'::jsonb,
  primary_conversion_event text not null default 'lead',
  workflow_notes text not null default '',
  created_at timestamptz not null default now()
);

-- 報告資料庫：每筆報告保存產出當下的痛點列表與潛在受眾地圖快照，
-- 讓使用者可以依產品／服務與報告性質回顧、編輯、刪除及重新匯出。
create table public.audience_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain_profile_id uuid not null references public.domain_profiles(id) on delete cascade,
  title text not null,
  report_type text not null default '受眾分析',
  description text not null default '',
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
alter table public.audience_reports enable row level security;
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
create policy "own audience reports" on public.audience_reports for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own pain points" on public.audience_pain_points for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own solutions" on public.product_solutions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own generation requests" on public.generation_requests for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own generation params" on public.generation_params for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own copy variants" on public.copy_variants for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own copy blocks" on public.copy_blocks for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own swipe copies" on public.swipe_copies for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create index generation_requests_user_created on public.generation_requests(user_id, created_at desc);
create index audience_reports_user_profile_updated on public.audience_reports(user_id, domain_profile_id, updated_at desc);
create index swipe_copies_user_created on public.swipe_copies(user_id, created_at desc);

-- ============================================================================
-- Migration (2026-09)：競品定位比較模組 ＋ 更精緻的價位帶欄位
-- 商業企劃書 P1 項目。若是既有（已上線）的資料庫，只需要在 Supabase SQL Editor
-- 執行「這個區塊」（從這行註解開始到檔案結尾），不用重跑上面 create table 那些
-- 沒有 IF NOT EXISTS 的舊表——這個區塊本身皆用 IF NOT EXISTS／IF EXISTS／
-- exception when duplicate_object 包住，可重複執行不報錯。
-- ============================================================================

-- 更精緻的價位帶：price_tier（low/high）維持不變，繼續作為既有邏輯（例如文案生成
-- 預設區塊順序 DEFAULT_BLOCK_ORDER）的分類依據，不動舊有行為；這裡新增具體價格
-- 區間與一段可自訂的定位說明，兩者並存、互相補充，而非取代。
alter table public.domain_profiles add column if not exists price_range_min numeric;
alter table public.domain_profiles add column if not exists price_range_max numeric;
alter table public.domain_profiles add column if not exists price_currency text not null default 'TWD';
alter table public.domain_profiles add column if not exists price_position_note text not null default '';

do $$ begin
  alter table public.domain_profiles
    add constraint domain_profiles_price_range_valid
    check (price_range_min is null or price_range_max is null or price_range_min <= price_range_max);
exception when duplicate_object then null;
end $$;

-- 競品定位比較：使用者自行輸入的競品品牌資料，供人工比較與 AI 差異化分析使用。
-- 刻意不做語料爬蟲或自動抓取——競品定位判讀需要人工把關，避免抓到錯誤或過期資訊。
create table if not exists public.competitor_brands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain_profile_id uuid not null references public.domain_profiles(id) on delete cascade,
  brand_name text not null,
  price_range_min numeric,
  price_range_max numeric,
  price_currency text not null default 'TWD',
  target_audience text not null default '',
  positioning_summary text not null default '',
  differentiation_notes text not null default '',
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.competitor_brands
    add constraint competitor_brands_price_range_valid
    check (price_range_min is null or price_range_max is null or price_range_min <= price_range_max);
exception when duplicate_object then null;
end $$;

alter table public.competitor_brands enable row level security;
grant select, insert, update, delete on public.competitor_brands to authenticated;

do $$ begin
  create policy "own competitor brands" on public.competitor_brands for all to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
exception when duplicate_object then null;
end $$;

create index if not exists competitor_brands_user_profile_created
  on public.competitor_brands(user_id, domain_profile_id, created_at desc);
