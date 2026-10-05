// Статика сборки для разработки и e2e: CORS * на всё (web-MSX грузит start.json и плагин с другого origin), без кэша.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES = {
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
};

function plain(res, status, text, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

async function handle(root, req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "method not allowed\n", { Allow: "GET, HEAD" });

  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return plain(res, 400, "bad request\n");
  }
  let file = resolve(root, `.${path}`);
  if (path.includes("\0") || (file !== root && !file.startsWith(root + sep))) return plain(res, 404, "not found\n");

  let st;
  try {
    st = await stat(file);
    if (st.isDirectory()) {
      // Без завершающего «/» относительный app.js из index.html разрешился бы не в тот каталог.
      if (!path.endsWith("/")) return plain(res, 301, "moved\n", { Location: `${path}/` });
      file = join(file, "index.html");
      st = await stat(file);
    }
  } catch {
    return plain(res, 404, "not found\n");
  }
  if (!st.isFile()) return plain(res, 404, "not found\n");

  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/**
 * @param {{ dir: string; port?: number; host?: string }} opts port 0 (по умолчанию) — случайный свободный
 * @returns {Promise<import("./static-server.d.mts").StaticServer>}
 */
export async function serveStatic({ dir, port = 0, host = "127.0.0.1" }) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    handle(root, req, res).catch(() => res.destroy());
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      ok(undefined);
    });
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`;
  return {
    url,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok(undefined));
      }),
  };
}
