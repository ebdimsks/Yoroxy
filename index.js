import express from 'express';
import http from 'node:http';
import { createBareServer } from "@tomphttp/bare-server-node";
import cors from 'cors';
import path from 'node:path';

const server = http.createServer();
const app = express();
const rootDir = process.cwd();
const bareServer = createBareServer('/bare/');
const PORT = Number(process.env.PORT || 8080);

const SEARCH_ENGINES = [
  "https://duckduckgo.com/?q=%s",
  "https://www.startpage.com/sp/search?q=%s",
  "https://search.brave.com/search?q=%s",
  "https://duckduckgo.com/html/?q=%s",
  "https://lite.duckduckgo.com/lite/?q=%s"
];

const FETCH_TIMEOUT_MS = 2000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(rootDir, "public")));

app.get("/api/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "missing q" });

    const query = encodeURIComponent(q);

    for (const tpl of SEARCH_ENGINES) {
      const url = tpl.replace("%s", query);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
          },
          redirect: "follow"
        });

        if (response.ok) {
          return res.json({ url });
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.warn(`Search engine check failed: ${url}`, err);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return res.status(502).json({ error: "no search engine available" });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error("Express error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal error" });
});

server.on('request', (req, res) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on('upgrade', (req, socket, head) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Server Listening on ${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("Shutting down...");

  server.close(() => {
    bareServer.close();
    process.exit(0);
  });
}
