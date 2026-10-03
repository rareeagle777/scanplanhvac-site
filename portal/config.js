// Supabase connection for the web portal. These are the same public values the iOS app ships in
// SupabaseConfig.swift: the anon / publishable key is meant for clients, and row-level security on
// the server keeps each account's data private. Never put the service-role key here.
export const SUPABASE_URL = "https://cozjsfjpqldoemjjlsyc.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_qQmidDUId1KpOkAqNc5e9g_MpyCtUsO";

// Storage layout shared with the app (see docs/CloudSync/README.md).
export const PROJECTS_TABLE = "projects";
export const REPORTS_BUCKET = "reports";
export const WEATHER_BUCKET = "weather";
