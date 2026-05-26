-- 🏀 HOOPS LIFF 資料表
-- 在 Supabase → SQL Editor 貼上整段、按 Run，即可建立所需資料表。

-- 投票（一個團一筆）
create table if not exists polls (
  id bigint generated always as identity primary key,
  group_id text not null,          -- LINE 群組 ID
  title text not null,             -- 標題
  owner_id text,                   -- 發起人 LINE userId
  owner_name text,                 -- 發起人名字
  slots jsonb not null default '[]',-- 時段陣列 [{id,label}]
  locked boolean not null default false, -- 是否已結束
  created_at timestamptz not null default now()
);

-- 每一票（一人投一個時段 = 一筆）
create table if not exists votes (
  id bigint generated always as identity primary key,
  poll_id bigint not null references polls(id) on delete cascade,
  user_id text not null,           -- 投票者 LINE userId
  name text not null,              -- 投票者名字
  slot_id text not null,           -- 時段 id
  created_at timestamptz not null default now()
);

create index if not exists idx_polls_group on polls(group_id, locked);
create index if not exists idx_votes_poll on votes(poll_id);

-- 開放讀寫（這個專案用 service key 從後端存取，已足夠；如要更嚴謹可另設 RLS）
alter table polls enable row level security;
alter table votes enable row level security;
create policy "allow all polls" on polls for all using (true) with check (true);
create policy "allow all votes" on votes for all using (true) with check (true);
