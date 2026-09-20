/**
 * Single-port gateway for the Docker deployment:
 *
 *   GET /api/**  → proxied to the Express sidecar (127.0.0.1:REXADB_SERVER_PORT)
 *   everything else → static files from the Next.js export (./out)
 *
 * The browser sets `window.__REXADB_API_BASE__ = window.location.origin` via
 * a runtime script injected at container start, so apiFetch() issues
 * same-origin /api calls that this gateway forwards. Run: bun run docker/static-proxy.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const PORT = Number(process.env.REXADB_PROXY_PORT || 7181);
const UPSTREAM = `http://127.0.0.1:${process.env.REXADB_SERVER_PORT || 3867}`;
const OUT_DIR = join(import.meta.dir, "..", "out");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, rawPath: string) {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(rawPath, "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad path");
    return;
  }
  // Never escape the export dir.
  const base = normalize(OUT_DIR);
  let file = normalize(join(base, urlPath));
  if (!file.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }

  // Export uses trailingSlash:true → routes live at <name>/index.html.
  try {
    const s = await stat(file).catch(() => null);
    if (s?.isDirectory()) {
      file = join(file, "index.html");
    } else if (!s) {
      const asIndex = join(file, "index.html");
      const ds = await stat(asIndex).catch(() => null);
      if (ds) file = asIndex;
    }
  } catch {
    // fall through to read attempt
  }

  try {
    const data = await readFile(file);
    const isRuntimeConfig = file.endsWith("runtime-api.js");
    const isHtml = extname(file) === ".html";
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      // Runtime config must NEVER cache — it carries the API base override
      // and a stale copy recreates the empty-connections bug after rebuilds.
      "Cache-Control": isRuntimeConfig || isHtml ? "no-cache, must-revalidate" : "public, max-age=3600",
    });
    res.end(data);
  } catch {
    // SPA-ish fallback for client-navigated routes.
    try {
      const index = await readFile(join(base, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(index);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}

async function proxyApi(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method,
      headers: {
        ...(req.headers.host ? {} : {}),
        "content-type": String(req.headers["content-type"] || "application/json"),
      },
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
  } catch (e: any) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: `sidecar unreachable: ${e?.message || e}` }));
    return;
  }

  const headers: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() !== "transfer-encoding" && k.toLowerCase() !== "content-encoding") headers[k] = v;
  });
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // client went away or upstream broke mid-stream
    }
    res.end();
  } else {
    res.end();
  }
}

const server = createServer((req, res) => {
  const p = req.url || "/";
  let pathname = p;
  try {
    pathname = new URL(p, "http://x").pathname;
  } catch {
    // keep raw
  }

  // Sidecar routes that do NOT live under /api:
  //   /health, /mcp, and /studio/:connectionId/<resource> (bootstrap,
  //   dashboards, tabs, snippets, history, …). Static export pages are
  //   exactly /studio/<id> (one segment) — API paths always have a second
  //   segment, so depth decides.
  const segs = pathname.split("/").filter((s) => s.length > 0);
  // /studio/<id> (1 non-empty segment after /studio) = pre-rendered page;
  // /studio/<id>/<resource> (≥2) = sidecar API.
  const isStudioApi = segs[0] === "studio" && segs.length >= 3;
  const isSidecar =
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    isStudioApi;

  if (isSidecar) {
    void proxyApi(req, res);
  } else {
    void serveStatic(req, res, p);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[rexadb-proxy] listening on 0.0.0.0:${PORT} → api ${UPSTREAM}, static ${OUT_DIR}`);
});
