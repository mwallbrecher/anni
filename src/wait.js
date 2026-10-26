// How long wait_for_save / wait_for_changes block per call. MCP clients built on the standard SDK (and Codex)
// abandon a request after 60 s, so a single wait has to end well before that; the agent simply calls again.
export const WAIT_DEFAULT_S = 45;
export const WAIT_MAX_S = 50;

/** The requested wait in seconds, clamped to 1..WAIT_MAX_S (larger requests are shortened, not rejected). */
export const waitSeconds = (requested) => Math.min(WAIT_MAX_S, Math.max(1, Math.round(requested ?? WAIT_DEFAULT_S)));

export const WAIT_DESCRIPTION = `How long to wait in seconds (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S} – MCP clients drop requests after 60 s; call again to keep waiting)`;
