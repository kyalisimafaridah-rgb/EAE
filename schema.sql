-- Safe to re-run: tables, indexes, policies, functions and the trigger are all idempotent.
-- gen_random_uuid() is built into Postgres 13+ (all current Supabase projects),
-- so the uuid-ossp extension is not needed.

-- 1. COMPANIES / TENANTS
create table if not exists tenants (
    id uuid default gen_random_uuid() primary key,
    company_name text not null,
    created_at timestamptz default now() not null
);

-- 2. WORKFLOWS
create table if not exists workflows (
    id uuid default gen_random_uuid() primary key,
    tenant_id uuid references tenants(id) on delete cascade not null,
    workflow_name text not null,
    trigger_type text not null, -- e.g. 'whatsapp_incoming', 'email_received'
    status text default 'active' not null,
    created_at timestamptz default now() not null
);

-- Shared secret the webhook sender must send as the x-webhook-secret header.
-- Separate ALTER so it is also added to a workflows table created by an older version of this script
-- (existing rows each get their own random secret).
alter table workflows
    add column if not exists webhook_secret text not null
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

-- 3. LOGISTICS DATA INGESTION
-- processed_status: pending | completed | needs_review | dispatch_failed
create table if not exists logistics_records (
    id uuid default gen_random_uuid() primary key,
    tenant_id uuid references tenants(id) on delete cascade not null,
    workflow_id uuid references workflows(id) on delete set null,
    tracking_number text,
    cargo_weight numeric, -- always kilograms
    client_phone text,
    raw_payload jsonb,
    processed_status text default 'pending' not null,
    created_at timestamptz default now() not null
);

-- 4. COST TRACKER & GUARDRAIL (one row per tenant)
create table if not exists token_spend_guard (
    id uuid default gen_random_uuid() primary key,
    tenant_id uuid references tenants(id) on delete cascade not null,
    credits_remaining numeric(10,2) default 50000.00 not null,
    last_spend numeric(10,4) default 0.0000 not null,
    updated_at timestamptz default now() not null
);

create unique index if not exists token_spend_guard_tenant_id_key on token_spend_guard (tenant_id);
create index if not exists workflows_tenant_id_idx on workflows (tenant_id);
create index if not exists logistics_records_tenant_status_idx on logistics_records (tenant_id, processed_status);
create index if not exists logistics_records_workflow_id_idx on logistics_records (workflow_id);
-- Used by the per-workflow rate limit in webhook-ingest (counts recent records for one workflow).
create index if not exists logistics_records_workflow_created_idx on logistics_records (workflow_id, created_at desc);

-- 5. ROW LEVEL SECURITY
alter table tenants enable row level security;
alter table workflows enable row level security;
alter table logistics_records enable row level security;
alter table token_spend_guard enable row level security;

-- The tenant id lives in app_metadata (only the server can write it;
-- user_metadata is user-editable and must never be used for authorization).
-- Set it with:
--   update auth.users
--   set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('tenant_id', '<tenant uuid>')
--   where id = '<user uuid>';
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
    select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$$;

-- 6. POLICIES
-- tenants and token_spend_guard are read-only for tenant users: a tenant must
-- not be able to edit its own credit balance. The service role bypasses RLS.
drop policy if exists "Tenants can view their own tenant row" on tenants;
create policy "Tenants can view their own tenant row"
    on tenants for select
    using (id = (select public.current_tenant_id()));

drop policy if exists "Tenants can only see their own workflows" on workflows;
create policy "Tenants can only see their own workflows"
    on workflows for all
    using (tenant_id = (select public.current_tenant_id()))
    with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists "Tenants can only see their own logistics records" on logistics_records;
create policy "Tenants can only see their own logistics records"
    on logistics_records for all
    using (tenant_id = (select public.current_tenant_id()))
    with check (tenant_id = (select public.current_tenant_id()));

drop policy if exists "Tenants can only view their own spend guards" on token_spend_guard;
create policy "Tenants can only view their own spend guards"
    on token_spend_guard for select
    using (tenant_id = (select public.current_tenant_id()));

-- 7. BALANCE GUARDRAIL
create or replace function deduct_tenant_credits(
    target_tenant_id uuid,
    cost_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    remaining numeric;
begin
    update token_spend_guard
    set credits_remaining = credits_remaining - cost_amount,
        last_spend = cost_amount,
        updated_at = now()
    where tenant_id = target_tenant_id
    returning credits_remaining into remaining;

    if remaining is null then
        raise exception 'No spend guard found for tenant %', target_tenant_id;
    end if;

    if remaining <= 0 then
        update workflows
        set status = 'paused'
        where tenant_id = target_tenant_id and status <> 'paused';
    end if;
end;
$$;

-- security definer + public schema = callable by anyone through /rest/v1/rpc.
-- Only the backend (service role) may call it.
revoke execute on function deduct_tenant_credits(uuid, numeric) from public, anon, authenticated;
grant execute on function deduct_tenant_credits(uuid, numeric) to service_role;

-- 8. AUTOMATIC TENANT ONBOARDING
create or replace function handle_new_tenant_setup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into token_spend_guard (tenant_id) values (new.id);
    return new;
end;
$$;

-- Trigger function: only the trigger itself may run it, never the public API (/rest/v1/rpc).
revoke execute on function handle_new_tenant_setup() from public, anon, authenticated;

drop trigger if exists on_tenant_created on tenants;
create trigger on_tenant_created
    after insert on tenants
    for each row execute procedure handle_new_tenant_setup();
