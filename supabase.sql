-- Music Rater: run this once in Supabase → SQL Editor → New query → Run.
-- One row per album per user. Row Level Security means each person
-- can only ever read or change their own rows.

create table if not exists public.albums (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  album_id   text not null,
  data       jsonb,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false,
  primary key (user_id, album_id)
);

alter table public.albums enable row level security;
grant select, insert, update, delete on public.albums to authenticated;

drop policy if exists "read own albums"   on public.albums;
drop policy if exists "insert own albums" on public.albums;
drop policy if exists "update own albums" on public.albums;
drop policy if exists "delete own albums" on public.albums;

create policy "read own albums"   on public.albums for select using (auth.uid() = user_id);
create policy "insert own albums" on public.albums for insert with check (auth.uid() = user_id);
create policy "update own albums" on public.albums for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own albums" on public.albums for delete using (auth.uid() = user_id);
