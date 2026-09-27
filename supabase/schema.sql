-- Database for The Science of Deduction (Supabase / Postgres).
-- The live project `science-of-deduction` already has all of this. Use this file to rebuild it
-- in a new Supabase project: paste it into SQL Editor, replace every editor@example.com with the
-- editor's email address, then run it.

create table public.docs (
  collection text not null check (collection in ('strangers','tour')),
  id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.docs enable row level security;
create policy "anyone reads" on public.docs for select using (true);
create policy "anyone adds a stranger" on public.docs for insert to anon, authenticated
  with check (collection = 'strangers' and pg_column_size(data) < 20000 and (data ? 'title') and jsonb_typeof(data->'clues') = 'array');
create policy "owner writes the tour" on public.docs for all to authenticated
  using (collection = 'tour' and (auth.jwt()->>'email') = 'editor@example.com')
  with check (collection = 'tour' and (auth.jwt()->>'email') = 'editor@example.com');
create policy "owner removes strangers" on public.docs for delete to authenticated
  using (collection = 'strangers' and (auth.jwt()->>'email') = 'editor@example.com');

-- at most 500 strangers in the shared casebook
create function public.cap_strangers() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.collection = 'strangers' and (select count(*) from public.docs where collection = 'strangers') >= 500 then
    raise exception 'casebook full';
  end if;
  return new;
end $$;
create trigger cap_strangers before insert on public.docs for each row execute function public.cap_strangers();
revoke all on function public.cap_strangers() from public, anon, authenticated;

-- daily cap on AI calls, checked by api/sample.js with a shared secret
create table public.usage_log (id bigserial primary key, ip text not null, at timestamptz not null default now());
alter table public.usage_log enable row level security;
create index usage_log_at on public.usage_log (at);
create table public.app_secret (k text primary key, v text not null);
alter table public.app_secret enable row level security;
insert into public.app_secret values ('quota', encode(extensions.gen_random_bytes(24), 'hex'));

create function public.take_quota(p_secret text, p_ip text, per_ip int, global_cap int) returns json
language plpgsql security definer set search_path = public as $$
declare n_ip int; n_all int;
begin
  if p_secret is distinct from (select v from public.app_secret where k = 'quota') then
    return json_build_object('ok', false, 'reason', 'secret');
  end if;
  select count(*) into n_ip from public.usage_log where ip = p_ip and at > now() - interval '1 day';
  select count(*) into n_all from public.usage_log where at > now() - interval '1 day';
  if n_ip >= per_ip then return json_build_object('ok', false, 'reason', 'ip'); end if;
  if n_all >= global_cap then return json_build_object('ok', false, 'reason', 'global'); end if;
  insert into public.usage_log(ip) values (p_ip);
  delete from public.usage_log where at < now() - interval '3 days';
  return json_build_object('ok', true, 'left_ip', per_ip - n_ip - 1, 'left_all', global_cap - n_all - 1);
end $$;
revoke all on function public.take_quota(text, text, int, int) from public, authenticated;
grant execute on function public.take_quota(text, text, int, int) to anon;

-- photographs for the tour
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tour', 'tour', true, 20971520, array['image/jpeg','image/png','image/webp']);
create policy "owner uploads tour photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'tour' and (auth.jwt()->>'email') = 'editor@example.com');
create policy "owner deletes tour photos" on storage.objects for delete to authenticated
  using (bucket_id = 'tour' and (auth.jwt()->>'email') = 'editor@example.com');

-- after running: get the secret for Vercel's QUOTA_SECRET setting
-- select v from public.app_secret where k = 'quota';
