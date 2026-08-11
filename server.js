'use strict';
const http = require('node:http');
const { handleRequest } = require('./src/app');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Labour Management System running at http://localhost:${PORT}`);
});
