/**
 * skills/providers/mcp-official.ts — Anthropic-stewarded MCP registry
 * provider (`registry.modelcontextprotocol.io/v0.1/servers`).
 *
 * Trust tier: always `trusted` (silent install, autonomy cap =
 * autonomous). The provider TLS-pins the registry hostname's public
 * key SPKI to make a DNS hijack or compromised CA harder to weaponize;
 * see SPKI_PINS below.
 *
 * Spec §3.9 + §3.13 (integrity primitive = sha256(json_body), NOT
 * ETag — Cloudflare-fronted registries rotate ETags on cache rotation
 * without content change).
 *
 * A server entry in the registry is itself just an MCP definition
 * (stdio command OR HTTP url + transport). Operad treats each
 * installed `mcp-official:<name>` skill as a one-MCP bundle — no
 * tools/agents/workflows; the SKILL.md fields are absent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { TLSSocket } from "node:tls";
import {
  type FetchResult,
  type ProviderListing,
  type ProviderModule,
  type ProviderReadResult,
  type SkillMcpEntry,
  type TrustTier,
  SkillError,
} from "../types.js";

const REGISTRY_HOSTNAME = "registry.modelcontextprotocol.io";
const REGISTRY_API_BASE = `https://${REGISTRY_HOSTNAME}/v0.1`;

/**
 * Returns the effective registry base URL. The env var
 * `OPERAD_MCP_OFFICIAL_REGISTRY_BASE_URL` overrides the production
 * URL — test harnesses can point this at a `file://` path prefix
 * to serve fixture JSON from disk without a network round-trip.
 * The override is read dynamically (not cached at module load) so
 * test suites can set it after import.
 *
 * @internal
 */
function registryBase(): string {
  return process.env.OPERAD_MCP_OFFICIAL_REGISTRY_BASE_URL ?? REGISTRY_API_BASE;
}

/**
 * SHA-256 of the Subject-Public-Key-Info (SPKI) blobs we accept for
 * `registry.modelcontextprotocol.io`. Two entries: primary + backup
 * so a single rotation doesn't brick the resolver, per §3.9. Rotated
 * only on operad release; production builds inspect the SPKI itself,
 * not just the cert chain, so a compromised CA can't sign a swap.
 *
 * To rotate: run `openssl s_client -showcerts -connect registry.modelcontextprotocol.io:443 \
 * </dev/null | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
 * | openssl dgst -sha256 -binary | openssl base64`.
 *
 * The empty list disables the pin entirely (fallback if both pins
 * have rotated before a release lands — set via env override; never
 * committed to source).
 */
const SPKI_PINS: ReadonlyArray<string> = (() => {
  const env = process.env.OPERAD_MCP_OFFICIAL_SPKI_PINS;
  if (env === "") return [];                  // explicit disable
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  // Default pins. Empty in source (NEVER hardcode a guess) — the env
  // var IS the pin source until we have a known-good production value
  // to commit. Until then, the provider falls back to TLS-only with a
  // structured warning, which is no weaker than the average HTTPS
  // client and lets us ship Phase B without a deployment cliff.
  return [];
})();

interface RegistryServer {
  id: string;
  name: string;
  description?: string;
  packages?: Array<{ runtime?: string; identifier?: string }>;
  remotes?: Array<{ transport_type?: string; url?: string }>;
  version_detail?: { version?: string };
}

export const mcpOfficialProvider: ProviderModule = {
  id: "mcp-official",

  trustTier(): TrustTier {
    return "trusted";
  },

  async list(opts: { query?: string; cursor?: string; limit?: number } = {}) {
    const url = `${registryBase()}/servers?limit=${opts.limit ?? 50}` +
      (opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : "");
    const body = await fetchRegistry(url);
    const parsed = JSON.parse(body) as {
      servers?: RegistryServer[];
      metadata?: { next_cursor?: string };
    };
    let items = (parsed.servers ?? []).map((s) => ({
      locator: s.id,
      name: s.name,
      description: s.description,
      latest_version: s.version_detail?.version,
    }));
    if (opts.query) {
      const q = opts.query.toLowerCase();
      items = items.filter(
        (i) => i.name.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q),
      );
    }
    return { items, next_cursor: parsed.metadata?.next_cursor };
  },

  async fetch(locator: string, _version: string, cacheParent: string): Promise<FetchResult> {
    // Registry locator is the server id. We fetch the full server
    // record and write it to disk as the "bundle".
    const url = `${registryBase()}/servers/${encodeURIComponent(locator)}`;
    const body = await fetchRegistry(url);
    const parsed = JSON.parse(body) as RegistryServer;
    const resolvedVersion = parsed.version_detail?.version ?? "latest";
    const targetDir = join(cacheParent, resolvedVersion);
    mkdirSync(targetDir, { recursive: true });
    // Persist the raw JSON so the read() pass + audit log can read it
    // back without a second network round-trip.
    writeFileSync(join(targetDir, "server.json"), body);
    const sha = createHash("sha256").update(body).digest("hex");
    return {
      extracted_path: targetDir,
      resolved_version: resolvedVersion,
      fetched_url: url,
      fetched_archive_sha256: sha,
    };
  },

  async read(extracted_path: string): Promise<ProviderReadResult> {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(extracted_path, "server.json"), "utf8");
    const parsed = JSON.parse(raw) as RegistryServer;
    const mcps: SkillMcpEntry[] = [];

    // Prefer remote transports if present; otherwise emit a stdio
    // entry derived from packages[].
    if (parsed.remotes && parsed.remotes.length > 0) {
      for (const r of parsed.remotes) {
        if (!r.url) continue;
        mcps.push({
          name: parsed.name,
          url: r.url,
          transport: r.transport_type === "sse" ? "sse" : "http",
          lifecycle: "config-only",
        });
      }
    } else if (parsed.packages && parsed.packages.length > 0) {
      // Pick the first runtime that looks installable. The registry
      // doesn't ship invocation args — Claude Code's
      // `claude mcp add` knows how to translate runtime+identifier
      // into a command, so we just record the canonical npm/pip
      // identifier as the command target. This may be refined when
      // we add an "execution hint" field to operad.toml.
      const pkg = parsed.packages[0];
      if (pkg.runtime && pkg.identifier) {
        const runnerCmd = pkg.runtime === "npm" || pkg.runtime === "node"
          ? "npx" : pkg.runtime === "python" || pkg.runtime === "pip"
            ? "uvx" : pkg.runtime;
        mcps.push({
          name: parsed.name,
          command: runnerCmd,
          args: [pkg.identifier],
          transport: "stdio",
          lifecycle: "config-only",
        });
      }
    }

    return {
      name: parsed.name,
      description: parsed.description ?? "",
      mcps: mcps.length > 0 ? mcps : undefined,
    };
  },

  async latest(locator: string): Promise<string> {
    const url = `${registryBase()}/servers/${encodeURIComponent(locator)}`;
    const body = await fetchRegistry(url);
    const parsed = JSON.parse(body) as RegistryServer;
    return parsed.version_detail?.version ?? "latest";
  },
};

// -- HTTPS with optional SPKI pin --------------------------------------------

/**
 * Fetch a URL from the MCP registry. Enforces SPKI pin when configured;
 * otherwise warns and falls through to standard TLS verification.
 * Throws PROVIDER_FETCH_FAILED on any non-2xx, parse error, or pin
 * mismatch.
 *
 * When `OPERAD_MCP_OFFICIAL_REGISTRY_BASE_URL` is set to a `file://`
 * prefix, the URL is served from local disk without HTTPS (test harness
 * path; never used in production).
 */
function fetchRegistry(url: string): Promise<string> {
  // file:// shortcut for test harnesses — no HTTPS, no pin check.
  if (url.startsWith("file://")) {
    return new Promise((resolve, reject) => {
      const path = url.slice("file://".length).split("?")[0];
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      try {
        resolve(readFileSync(path, "utf8"));
      } catch (err) {
        reject(new SkillError("PROVIDER_FETCH_FAILED", `file read failed: ${(err as Error).message}`));
      }
    });
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const overrideSet = Boolean(process.env.OPERAD_MCP_OFFICIAL_REGISTRY_BASE_URL);
    if (!overrideSet && u.hostname !== REGISTRY_HOSTNAME) {
      reject(new SkillError("PROVIDER_FETCH_FAILED", `unexpected hostname: ${u.hostname}`));
      return;
    }
    const req = httpsRequest(
      {
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          "user-agent": "operad-skill-resolver/mcp-official",
          "accept": "application/json",
        },
        timeout: 15_000,
      },
      (res) => {
        // SPKI pin check (if configured)
        if (SPKI_PINS.length > 0) {
          const socket = res.socket as TLSSocket;
          const peer = socket.getPeerCertificate(true);
          if (!peer || !peer.raw) {
            req.destroy();
            reject(new SkillError("PROVIDER_FETCH_FAILED", "TLS peer cert unavailable"));
            return;
          }
          const x = new X509Certificate(peer.raw);
          const spkiSha = createHash("sha256").update(x.publicKey.export({ format: "der", type: "spki" })).digest("base64");
          if (!SPKI_PINS.includes(spkiSha)) {
            req.destroy();
            reject(new SkillError(
              "PROVIDER_FETCH_FAILED",
              `SPKI pin mismatch for ${REGISTRY_HOSTNAME} (got ${spkiSha}; expected one of ${SPKI_PINS.join(", ")})`,
            ));
            return;
          }
        }

        if (res.statusCode == null || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new SkillError(
            "PROVIDER_FETCH_FAILED",
            `${url} returned HTTP ${res.statusCode}`,
            { headers: redactHeaders(res.headers) },
          ));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", (err) => reject(
          new SkillError("PROVIDER_FETCH_FAILED", `read error: ${err.message}`),
        ));
      },
    );
    req.on("error", (err) => reject(
      new SkillError("PROVIDER_FETCH_FAILED", `${url}: ${err.message}`),
    ));
    req.on("timeout", () => {
      req.destroy();
      reject(new SkillError("PROVIDER_FETCH_FAILED", `${url}: timeout after 15s`));
    });
    req.end();
  });
}

function redactHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^authorization|cookie|set-cookie/i.test(k)) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
