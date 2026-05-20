/**
 * 2026-05-20 — helper pour parser les query params `at` + `windowSecs`
 * communs aux endpoints vector layers cursor-aware.
 *
 * `at` = timestamp ISO du cursor frontend (ex `2026-05-20T18:30:00Z`).
 * `windowSecs` = taille de la fenêtre [at - windowSecs, at] pour le
 *   filtrage `WHERE ts BETWEEN ...`. Borné [60s, 86400s] côté serveur
 *   pour éviter les requêtes runaway.
 *
 * Si `at` est absent / invalide : mode "live" retourné (at=null) — le
 *  caller doit utiliser la vue existante avec son WHERE now() - INTERVAL.
 */
export interface AtWindow {
  /** Timestamp du cursor, ou null si live mode. */
  at: Date | null;
  /** Borne basse de la fenêtre, ou null si live mode. */
  from: Date | null;
  /** Taille effective de la fenêtre en secondes (clampée). */
  windowSecs: number;
}

export function parseAtWindow(atIso: string | undefined, windowStr: string | undefined, defaultWindowSecs: number): AtWindow {
  let windowSecs = defaultWindowSecs;
  if (windowStr) {
    const parsed = parseInt(windowStr, 10);
    if (!isNaN(parsed)) windowSecs = Math.max(60, Math.min(86400, parsed));
  }

  if (!atIso) return { at: null, from: null, windowSecs };
  const at = new Date(atIso);
  if (isNaN(at.getTime())) return { at: null, from: null, windowSecs };

  const from = new Date(at.getTime() - windowSecs * 1000);
  return { at, from, windowSecs };
}
