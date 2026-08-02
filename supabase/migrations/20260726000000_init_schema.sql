-- Initial schema for JapaneseVocab user accounts + per-user data.
-- Run this in the Supabase SQL editor (or via `supabase db push`) on a fresh project.

-- ============================================================
-- profiles
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "select own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- user_preferences
-- ============================================================
create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rows_per_page int not null default 20,
  autoplay_example boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

create policy "select own preferences" on public.user_preferences
  for select using (auth.uid() = user_id);
create policy "insert own preferences" on public.user_preferences
  for insert with check (auth.uid() = user_id);
create policy "update own preferences" on public.user_preferences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own preferences" on public.user_preferences
  for delete using (auth.uid() = user_id);

-- ============================================================
-- custom_vocab (created before user_word_state, which references it in spirit
-- via word_key — no formal FK since word_key is shared with curated words too)
-- ============================================================
create table public.custom_vocab (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  hiragana text not null,
  kanji text,
  english text not null,
  example_furigana text,
  translation text,
  notes_furigana text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.custom_vocab enable row level security;

create policy "select own custom_vocab" on public.custom_vocab
  for select using (auth.uid() = user_id);
create policy "insert own custom_vocab" on public.custom_vocab
  for insert with check (auth.uid() = user_id);
create policy "update own custom_vocab" on public.custom_vocab
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own custom_vocab" on public.custom_vocab
  for delete using (auth.uid() = user_id);

-- ============================================================
-- user_word_state (starring + lightweight progress, curated + custom words)
-- ============================================================
create table public.user_word_state (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  word_type text not null check (word_type in ('verb', 'i-adjective', 'na-adjective', 'custom')),
  word_key text not null,
  is_starred boolean not null default false,
  status text not null default 'new' check (status in ('new', 'learning', 'known')),
  review_count int not null default 0,
  last_reviewed_at timestamptz,
  unique (user_id, word_type, word_key)
);

alter table public.user_word_state enable row level security;

create policy "select own word_state" on public.user_word_state
  for select using (auth.uid() = user_id);
create policy "insert own word_state" on public.user_word_state
  for insert with check (auth.uid() = user_id);
create policy "update own word_state" on public.user_word_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own word_state" on public.user_word_state
  for delete using (auth.uid() = user_id);
