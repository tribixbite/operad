/**
 * env.svelte.ts — host facts served by the daemon.
 *
 * The dashboard used to hardcode `/data/data/com.termux/files/home/` in five
 * places. On Linux, WSL, macOS and Windows that meant every path rendered in
 * full instead of `~/…`, and — worse — the "new skill" form wrote to a Termux
 * path that does not exist on those hosts.
 *
 * The daemon is the only component that knows its own home directory and path
 * separator, so it reports them via GET /api/env and everything else reads
 * from here.
 */

interface HostEnv {
  home: string;
  platform: string;
  pathSep: string;
}

/**
 * Populated by {@link loadEnv}. The empty default is deliberate: an unset
 * `home` makes {@link shortenHomePath} a no-op rather than mangling paths with
 * a wrong prefix, which is the failure mode the hardcoded constant had.
 */
const env = $state<HostEnv>({ home: "", platform: "", pathSep: "/" });

let loaded = false;
let inflight: Promise<void> | null = null;

/**
 * Fetch host facts once per page load. Safe to call from many components —
 * concurrent callers share the in-flight request.
 */
export async function loadEnv(): Promise<void> {
  if (loaded) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/env");
      if (!res.ok) return;
      const data = (await res.json()) as Partial<HostEnv> & { path_sep?: string };
      if (typeof data.home === "string") env.home = data.home;
      if (typeof data.platform === "string") env.platform = data.platform;
      if (typeof data.path_sep === "string") env.pathSep = data.path_sep;
      loaded = true;
    } catch {
      // Leave the defaults; display degrades to full paths rather than wrong ones.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Reactive host facts. Read `hostEnv.home` etc. inside components. */
export const hostEnv = env;

/**
 * Render a filesystem path with the host's home directory collapsed to `~/`.
 * Returns the input unchanged when the home directory is not known yet or the
 * path lies outside it.
 */
export function shortenHomePath(p: string): string {
  if (!p || !env.home) return p;
  const home = env.home.replace(/[/\\]+$/, "");
  if (p === home) return "~";
  for (const sep of ["/", "\\"]) {
    if (p.startsWith(home + sep)) return "~" + sep + p.slice(home.length + 1);
  }
  return p;
}

/**
 * Join path segments with the host's separator. Used when the dashboard has to
 * construct a path the daemon will write to, e.g. a new skill file.
 */
export function hostJoin(...parts: string[]): string {
  const sep = env.pathSep || "/";
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[/\\]+$/, "") : p.replace(/^[/\\]+|[/\\]+$/g, "")))
    .join(sep);
}
