import express from 'express';
import http from 'node:http';
import { createBareServer } from '@tomphttp/bare-server-node';
import cors from 'cors';
import path from 'node:path';

const server = http.createServer();
const app = express();
const rootDir = process.cwd();
const bareServer = createBareServer('/bare/');
const PORT = Number(process.env.PORT || 8080);

const SEARCH_ENGINES = [
  'https://duckduckgo.com/?q=%s',
  'https://www.startpage.com/sp/search?q=%s',
  'https://search.brave.com/search?q=%s',
  'https://duckduckgo.com/html/?q=%s',
  'https://lite.duckduckgo.com/lite/?q=%s',
];

const FETCH_TIMEOUT_MS = 2000;

let shuttingDown = false;

app.disable('x-powered-by');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(rootDir, 'public')));

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing q' });

    const query = encodeURIComponent(q);

    for (const tpl of SEARCH_ENGINES) {
      const url = tpl.replace('%s', query);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        });

        if (response.ok) {
          return res.json({ url });
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.warn(`Search engine check failed: ${url}`, err);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return res.status(502).json({ error: 'no search engine available' });
  } catch (err) {
    next(err);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Express error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

server.on('request', (req, res) => {
  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeRequest(req, res);
    } else {
      app(req, res);
    }
  } catch (err) {
    console.error('Request routing error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.destroy();
    }
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  } catch (err) {
    console.error('Upgrade routing error:', err);
    socket.destroy();
  }
});

server.on('error', (err) => {
  console.error('HTTP server error:', err);
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  shutdown(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  shutdown(1);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

server.listen(PORT, () => {
  console.log(`Server Listening on ${PORT}`);
});

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Shutting down...');

  const forceExitTimer = setTimeout(() => {
    console.error('Forced exit after shutdown timeout');
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  try {
    server.close(() => {
      try {
        bareServer.close();
      } catch (err) {
        console.error('bareServer.close error:', err);
      }

      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    });
  } catch (err) {
    console.error('server.close error:', err);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}
