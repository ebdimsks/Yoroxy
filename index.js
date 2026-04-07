import express from 'express';
import http from 'node:http';
import { createBareServer } from '@tomphttp/bare-server-node';
import cors from 'cors';
import path from 'node:path';

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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(rootDir, 'public')));

function isIgnorableNetworkError(err) {
  if (!err) return false;

  const code = String(err.code || '');
  const name = String(err.name || '');
  const message = String(err.message || '');

  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'UND_ERR_SOCKET' ||
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('socket hang up')
  );
}

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing q' });

    const query = encodeURIComponent(q);

    for (const tpl of SEARCH_ENGINES) {
      const url = tpl.replace('%s', query);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      req.on('close', () => controller.abort());

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
        if (!isIgnorableNetworkError(err)) {
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
  if (isIgnorableNetworkError(err)) {
    console.warn('Ignored request-level network error:', {
      code: err?.code,
      name: err?.name,
      message: err?.message,
    });

    if (!res.headersSent) {
      return res.status(499).json({ error: 'client closed request' });
    }
    return;
  }

  console.error('Express error:', err);

  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer((req, res) => {
  req.on('error', (err) => {
    if (!isIgnorableNetworkError(err)) {
      console.warn('Request stream error:', err);
    }
  });

  res.on('error', (err) => {
    if (!isIgnorableNetworkError(err)) {
      console.warn('Response stream error:', err);
    }
  });

  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeRequest(req, res);
    } else {
      app(req, res);
    }
  } catch (err) {
    if (isIgnorableNetworkError(err)) {
      console.warn('Ignored routing abort:', err?.message || err);
      return;
    }

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
  socket.on('error', (err) => {
    if (!isIgnorableNetworkError(err)) {
      console.warn('Socket error during upgrade:', err);
    }
  });

  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  } catch (err) {
    if (isIgnorableNetworkError(err)) {
      console.warn('Ignored upgrade abort:', err?.message || err);
      socket.destroy();
      return;
    }

    console.error('Upgrade routing error:', err);
    socket.destroy();
  }
});

server.on('clientError', (err, socket) => {
  if (isIgnorableNetworkError(err)) {
    socket.destroy();
    return;
  }

  console.warn('clientError:', err);

  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } else {
    socket.destroy();
  }
});

server.on('error', (err) => {
  console.error('HTTP server error:', err);
});

process.on('uncaughtException', (err) => {
  if (isIgnorableNetworkError(err)) {
    console.warn('Ignored uncaught network error:', {
      code: err?.code,
      name: err?.name,
      message: err?.message,
    });
    return;
  }

  console.error('uncaughtException:', err);
  shutdown(1);
});

process.on('unhandledRejection', (reason) => {
  if (isIgnorableNetworkError(reason)) {
    console.warn('Ignored unhandled network rejection:', reason);
    return;
  }

  console.error('unhandledRejection:', reason);
  shutdown(1);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, () => {
  console.log(`Server Listening on ${PORT}`);
});

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Shutting down...');

  const forceExitTimer = setTimeout(() => {
    console.error('Forced exit after shutdown timeout');
    process.exit(exitCode || 1);
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
