-- Card Vault database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.

-- 1. The cards table. Each row belongs to one logged-in person.
create table if not exists public.cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  data        jsonb not null default '{}'::jsonb,
  photo_path  text
);

-- 2. Privacy: people can only see and change their own cards.
alter table public.cards enable row level security;

create policy "Own cards: read"   on public.cards for select using (auth.uid() = user_id);
create policy "Own cards: add"    on public.cards for insert with check (auth.uid() = user_id);
create policy "Own cards: change" on public.cards for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Own cards: delete" on public.cards for delete using (auth.uid() = user_id);

-- 3. Private photo storage. Each person's photos live in a folder named after their account id.
insert into storage.buckets (id, name, public)
values ('card-photos', 'card-photos', false)
on conflict (id) do nothing;

create policy "Own photos: read"   on storage.objects for select
  using (bucket_id = 'card-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own photos: add"    on storage.objects for insert
  with check (bucket_id = 'card-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own photos: change" on storage.objects for update
  using (bucket_id = 'card-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own photos: delete" on storage.objects for delete
  using (bucket_id = 'card-photos' and (storage.foldername(name))[1] = auth.uid()::text);
