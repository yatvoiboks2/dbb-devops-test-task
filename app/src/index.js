const express = require('express');

const PORT = Number(process.env.PORT) || 8080;
const app = express();

app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});

const shutdown = (signal) => {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
