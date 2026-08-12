/**
 * auth.svelte.ts — client-side view of the dashboard's auth state.
 *
 * The API became token-gated in 0.5.0, but the client had no notion of it. A
 * browser opening the dashboard without first visiting the `?token=…` URL got
 * the SPA shell (static assets are unauthenticated by design) and then a 401
 * from every request — so the page rendered as a wall of generic "HTTP 401"
 * errors with nothing telling the user a token exists or how to get one. It
 * looked broken rather than locked.
 *
 * Every response goes through `noteResponse`, which flips this flag on the
 * first 401. The root layout renders an explanatory screen instead of the
 * panels while it is set.
 */

const state = $state({
  /** True once any API call has come back 401. */
  unauthenticated: false,
});

/** Reactive auth state; read `authState.unauthenticated` in components. */
export const authState = state;

/**
 * Record an API response. Returns the same response so call sites can chain.
 * Only 401 flips the flag — a 403 means the token was present but rejected
 * for another reason, and a 5xx is not an auth problem.
 */
export function noteResponse(res: Response): Response {
  if (res.status === 401) state.unauthenticated = true;
  else if (res.ok) state.unauthenticated = false;
  return res;
}

/** Clear the flag, e.g. after the user pastes a token. */
export function clearUnauthenticated(): void {
  state.unauthenticated = false;
}

/**
 * Attach a token to the current origin and reload.
 *
 * Navigating to `/?token=…` lets the daemon perform its normal handshake:
 * it validates the token, sets the `SameSite=Strict` cookie and redirects to
 * a clean URL. Doing it this way rather than storing the token in JS keeps a
 * single code path for the exchange.
 */
export function applyToken(token: string): void {
  const clean = token.trim();
  if (!clean) return;
  window.location.href = `/?token=${encodeURIComponent(clean)}`;
}
