// ============================================================
// Creative Note REST -- Shared Application Script
// All protected pages load this file via one script tag
// ============================================================

// ------------------------------------------------------------
// Supabase client initialisation
// ------------------------------------------------------------
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://xaayekfrlphyyxenhcjl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhhYXlla2ZybHBoeXl4ZW5oY2psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTYwMjAsImV4cCI6MjA4OTA5MjAyMH0.dNSck8DCC3p-qarBO4afSl4jJnHyv3DKT04AFg67Tgw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------
// Series branding config
// Add one entry per series slug when new series are onboarded
// ------------------------------------------------------------
export const SERIES_BRANDING = {
  wunderkeys: {
    name: 'WunderKeys',
    accentColor: '#f47c20',
    accentHover: '#de6e18',
    accentSoft: '#fff3e8',
    fontDisplay: 'Georgia, "Times New Roman", serif',
    fontBody: 'Inter, Arial, Helvetica, sans-serif',
  }
};

// ------------------------------------------------------------
// showError(elementId, message)
// Displays an error message in a named element on the page
// ------------------------------------------------------------
export function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

export function clearError(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = '';
    el.style.display = 'none';
  }
}

// ------------------------------------------------------------
// requireAuth()
// Call at the top of every protected page.
// Checks for a valid Supabase session.
// Redirects to the series login page if not authenticated.
// Returns the session object if authenticated.
// ------------------------------------------------------------
export async function requireAuth() {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session) {
    const seriesSlug = sessionStorage.getItem('series_slug') || 'wunderkeys';
    window.location.href = '/' + seriesSlug + '/';
    return null;
  }

  return session;
}

// ------------------------------------------------------------
// applyBranding()
// Reads series_slug from sessionStorage and applies CSS variables
// Call on any shared page that needs series branding
// ------------------------------------------------------------
export function applyBranding() {
  const slug = sessionStorage.getItem('series_slug') || 'wunderkeys';
  const branding = SERIES_BRANDING[slug] || SERIES_BRANDING['wunderkeys'];

  document.documentElement.style.setProperty('--color-accent', branding.accentColor);
  document.documentElement.style.setProperty('--color-accent-hover', branding.accentHover);
  document.documentElement.style.setProperty('--color-accent-soft', branding.accentSoft);
}