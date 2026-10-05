-- טבלת הנתונים של האתר. מריצים פעם אחת ב-Supabase: SQL Editor → New query → Run.
-- RLS פעיל בלי שום policy — רק השרת (עם מפתח service_role) קורא וכותב.
create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.kv enable row level security;
-- דלי הקבצים (course-files, פרטי) נוצר אוטומטית בהעלאה הראשונה.
