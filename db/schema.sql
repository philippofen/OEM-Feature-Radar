-- =============================================================================
-- OEM Feature Radar DE – Supabase / Postgres Schema
-- =============================================================================
-- Lauffähig in einem Supabase SQL-Editor-Run oder via `supabase db push`.
-- Idempotent: verwendet IF NOT EXISTS / DROP-Guards, wo sinnvoll.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";     -- gen_random_uuid()
create extension if not exists "vector";       -- pgvector

-- -----------------------------------------------------------------------------
-- Enums (als Text + CHECK, damit Supabase-Editor-freundlich)
-- -----------------------------------------------------------------------------
-- product_area:   'configurator' | 'new_sales' | 'used_sales'
-- page_type:      'configurator_entry' | 'config_step' | 'listing' | 'detail'
--                 | 'finance' | 'contact' | 'landing'
-- candidate_type: 'new_interactive_component' | 'new_flow_step'
--                 | 'new_section_with_form' | 'new_cta_category'
--                 | 'new_module_class' | 'removed_flow_step'
--                 | 'removed_interactive_component'
-- verdict:        'feature' | 'removal' | 'irrelevant' | 'uncertain' | 'pending'
-- run_status:     'running' | 'success' | 'partial_failure' | 'failed'

-- -----------------------------------------------------------------------------
-- Tabelle: oems
-- -----------------------------------------------------------------------------
create table if not exists oems (
    id          uuid primary key default gen_random_uuid(),
    slug        text not null unique,
    name        text not null,
    base_url    text not null,
    created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Tabelle: watched_urls
-- -----------------------------------------------------------------------------
create table if not exists watched_urls (
    id            uuid primary key default gen_random_uuid(),
    oem_id        uuid not null references oems(id) on delete cascade,
    url           text not null,
    product_area  text not null check (product_area in ('configurator','new_sales','used_sales')),
    page_type     text not null check (page_type in (
                    'configurator_entry','config_step','listing','detail',
                    'finance','contact','landing')),
    is_active     boolean not null default true,
    notes         text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    unique (oem_id, url)
);

create index if not exists watched_urls_active_idx
    on watched_urls (is_active) where is_active = true;

-- -----------------------------------------------------------------------------
-- Tabelle: crawl_runs
-- -----------------------------------------------------------------------------
create table if not exists crawl_runs (
    id           uuid primary key default gen_random_uuid(),
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    status       text not null default 'running'
                 check (status in ('running','success','partial_failure','failed')),
    trigger      text not null default 'cron'
                 check (trigger in ('cron','manual','backfill')),
    stats        jsonb not null default '{}'::jsonb
);

create index if not exists crawl_runs_started_idx
    on crawl_runs (started_at desc);

-- -----------------------------------------------------------------------------
-- Tabelle: snapshots
-- -----------------------------------------------------------------------------
create table if not exists snapshots (
    id               uuid primary key default gen_random_uuid(),
    crawl_run_id     uuid not null references crawl_runs(id) on delete cascade,
    watched_url_id   uuid not null references watched_urls(id) on delete cascade,
    captured_at      timestamptz not null default now(),
    dom_html_path    text,
    screenshot_path  text,
    text_extract     text,
    inventory        jsonb not null default '{}'::jsonb,
    http_status      int,
    load_time_ms     int,
    error            text
);

-- Schnellzugriff: letzter Snapshot pro URL
create index if not exists snapshots_url_time_idx
    on snapshots (watched_url_id, captured_at desc);

create index if not exists snapshots_run_idx
    on snapshots (crawl_run_id);

-- -----------------------------------------------------------------------------
-- Tabelle: feature_posts (zuerst angelegt, wird von change_candidates referenziert)
-- -----------------------------------------------------------------------------
create table if not exists feature_posts (
    id                    uuid primary key default gen_random_uuid(),
    slug                  text not null unique,
    oem_id                uuid not null references oems(id) on delete restrict,
    product_area          text not null check (product_area in ('configurator','new_sales','used_sales')),
    title                 text not null,
    short_description     text not null,
    url_to_feature        text not null,
    old_snapshot_id       uuid references snapshots(id) on delete set null,
    new_snapshot_id       uuid references snapshots(id) on delete set null,
    old_vs_new            jsonb not null default '{}'::jsonb,
    screenshot_public_url text,
    confidence            float not null check (confidence >= 0 and confidence <= 1),
    detected_at           timestamptz not null default now(),
    published_at          timestamptz not null default now(),
    is_visible            boolean not null default true,
    embedding             vector(1536),
    evidence              jsonb not null default '{}'::jsonb
);

create index if not exists feature_posts_published_idx
    on feature_posts (published_at desc) where is_visible = true;

create index if not exists feature_posts_oem_area_idx
    on feature_posts (oem_id, product_area, published_at desc);

-- pgvector: IVFFlat Cosine-Index für Ähnlichkeitssuche in Dedup
-- NOTE: IVFFlat benötigt mind. ~50 Rows für ein sinnvolles Training.
-- Vor dem Launch reicht es, Full-Scan zu akzeptieren; Index trotzdem anlegen.
create index if not exists feature_posts_embedding_idx
    on feature_posts using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- -----------------------------------------------------------------------------
-- Tabelle: change_candidates
-- -----------------------------------------------------------------------------
create table if not exists change_candidates (
    id                      uuid primary key default gen_random_uuid(),
    snapshot_from_id        uuid references snapshots(id) on delete set null,
    snapshot_to_id          uuid not null references snapshots(id) on delete cascade,
    watched_url_id          uuid not null references watched_urls(id) on delete cascade,
    candidate_type          text not null check (candidate_type in (
                              'new_interactive_component','new_flow_step',
                              'new_section_with_form','new_cta_category',
                              'new_module_class','removed_flow_step',
                              'removed_interactive_component')),
    raw_diff                jsonb not null default '{}'::jsonb,
    classifier_verdict      text not null default 'pending'
                            check (classifier_verdict in (
                              'pending','feature','removal','irrelevant','uncertain')),
    classifier_reasoning    text,
    classifier_confidence   float check (classifier_confidence is null
                              or (classifier_confidence >= 0 and classifier_confidence <= 1)),
    classifier_version      text,
    validator_verdict       text check (validator_verdict is null
                              or validator_verdict in ('feature','removal','irrelevant','uncertain')),
    validator_reasoning     text,
    dedup_decision          text check (dedup_decision is null
                              or dedup_decision in ('unique','duplicate','grey_zone_duplicate')),
    dedup_target_post_id    uuid references feature_posts(id) on delete set null,
    is_published            boolean not null default false,
    published_post_id       uuid references feature_posts(id) on delete set null,
    rejection_reason        text,
    created_at              timestamptz not null default now()
);

create index if not exists change_candidates_status_idx
    on change_candidates (classifier_verdict, created_at desc);

create index if not exists change_candidates_unpublished_idx
    on change_candidates (is_published, created_at desc) where is_published = false;

-- -----------------------------------------------------------------------------
-- Tabelle: tags
-- -----------------------------------------------------------------------------
create table if not exists tags (
    id        uuid primary key default gen_random_uuid(),
    slug      text not null unique,
    label     text not null,
    "group"   text not null check ("group" in ('product_area','feature_type','flow','other'))
);

-- -----------------------------------------------------------------------------
-- Tabelle: post_tags (M:N)
-- -----------------------------------------------------------------------------
create table if not exists post_tags (
    post_id  uuid not null references feature_posts(id) on delete cascade,
    tag_id   uuid not null references tags(id) on delete cascade,
    primary key (post_id, tag_id)
);

create index if not exists post_tags_tag_idx on post_tags (tag_id);

-- -----------------------------------------------------------------------------
-- Tabelle: newsletter_subscribers
-- -----------------------------------------------------------------------------
create table if not exists newsletter_subscribers (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,
    created_at    timestamptz not null default now(),
    is_confirmed  boolean not null default false,
    confirm_token text
);

-- -----------------------------------------------------------------------------
-- Trigger: updated_at für watched_urls
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists watched_urls_updated_at on watched_urls;
create trigger watched_urls_updated_at
    before update on watched_urls
    for each row execute procedure set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: im MVP alles über Service-Key (Backend). Public-Reads für Frontend:
-- feature_posts (is_visible=true) und tags lesbar machen.
-- -----------------------------------------------------------------------------
alter table feature_posts             enable row level security;
alter table tags                      enable row level security;
alter table post_tags                 enable row level security;
alter table newsletter_subscribers    enable row level security;

drop policy if exists "public read visible posts" on feature_posts;
create policy "public read visible posts" on feature_posts
    for select using (is_visible = true);

drop policy if exists "public read tags" on tags;
create policy "public read tags" on tags for select using (true);

drop policy if exists "public read post_tags" on post_tags;
create policy "public read post_tags" on post_tags for select using (true);

-- Newsletter: anonymer insert erlaubt, kein read
drop policy if exists "public insert newsletter" on newsletter_subscribers;
create policy "public insert newsletter" on newsletter_subscribers
    for insert with check (true);

-- Alle anderen Tabellen ausschließlich über Service-Role (kein RLS-Policy nötig,
-- solange RLS aus bleibt — sie sind Backend-only).

-- =============================================================================
-- Fertig.
-- =============================================================================
