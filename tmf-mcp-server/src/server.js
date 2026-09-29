// ============================================
// TMF MCP Server - Production Ready
// 
// Transport modes:
// - stdio:  node src/server.js
// - HTTP:   node src/server.js --http
//
// HTTP endpoints:
//   POST /mcp   → Streamable HTTP (Copilot Studio, Claude Desktop)
//   GET  /mcp   → Streamable HTTP SSE notifications
//   DELETE /mcp → Streamable HTTP session termination
//   GET  /sse   → Legacy SSE (VS Code, older clients)
//   POST /messages → Legacy SSE message handler
//   GET  /health → Health check
//   GET  /tools  → Tool list
// ============================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import express from 'express';
import dotenv from 'dotenv';

import { AnypointClient } from './anypoint-client.js';
import { SpecParser } from './spec-parser.js';
import { ApiExecutor } from './api-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const useHttp = process.argv.includes('--http');
const HTTP_PORT = parseInt(process.env.MCP_PORT || '3001');

// ══════════════════════════════════════
// Configuration
// ══════════════════════════════════════

function loadConfig() {
  const domainConfigPath = join(__dirname, '..', 'config', 'domain.json');
  const domainConfig = JSON.parse(readFileSync(domainConfigPath, 'utf-8'));
  console.log(`[Config] Domain: ${domainConfig.domain}`);
  console.log(`[Config] Assets: ${domainConfig.exchangeAssets.map(a => a.assetId).join(', ')}`);
  return {
    domain: domainConfig,
    anypoint: {
      clientId: process.env.ANYPOINT_CLIENT_ID,
      clientSecret: process.env.ANYPOINT_CLIENT_SECRET,
      orgId: process.env.ANYPOINT_ORG_ID,
      envId: process.env.ANYPOINT_ENV_ID,
      region: process.env.ANYPOINT_REGION || 'PROD_US',
    },
    processApi: {
      clientId: process.env.PROCESS_API_CLIENT_ID,
      clientSecret: process.env.PROCESS_API_CLIENT_SECRET,
    },
  };
}

// ══════════════════════════════════════
// Tool Discovery from Anypoint Exchange
// ══════════════════════════════════════

async function discoverTools(config, parser, executor) {
  const client = new AnypointClient(config.anypoint);
  const allTools = [];
  for (const asset of config.domain.exchangeAssets) {
    try {
      console.log(`\n[Discovery] Processing: ${asset.assetId}`);
      let details;
      if (asset.basePathOverride) {
        console.log(`[Discovery] Using basePathOverride: ${asset.basePathOverride}`);
        const specResult = await client.fetchApiSpec(asset.assetId, asset.version, asset.groupId);
        details = { assetId: asset.assetId, version: asset.version, spec: specResult.spec, format: specResult.format, endpoint: asset.basePathOverride };
      } else {
        details = await client.getAssetDetails(asset.assetId, asset.version, asset.groupId);
      }
      if (!details.endpoint) { console.warn(`[Discovery] No endpoint for ${asset.assetId}`); continue; }
      const tools = parser.parse(details.spec, details.format, asset.assetId, asset.displayName || asset.assetId);
      const filteredTools = tools.filter(tool => {
        if (config.domain.excludeOperations?.length > 0 && config.domain.excludeOperations.includes(tool.name)) return false;
        if (config.domain.includeOperations?.length > 0 && !config.domain.includeOperations.includes(tool.name)) return false;
        return true;
      });
      for (const tool of filteredTools) {
        if (config.domain.toolNamePrefix) tool.name = config.domain.toolNamePrefix + tool.name;
        // Override description from domain.json if provided
        if (asset.toolDescriptions && asset.toolDescriptions[tool.name]) {
          tool.description = asset.toolDescriptions[tool.name];
        }
        if (config.domain.toolDescriptionSuffix) tool.description += ' ' + config.domain.toolDescriptionSuffix;
        executor.registerTool(tool.name, tool.apiDetails, asset.basePathOverride || details.endpoint);
        allTools.push(tool);
      }
      console.log(`[Discovery] Registered ${filteredTools.length} tools from ${asset.assetId}`);
    } catch (error) {
      console.error(`[Discovery] Error: ${asset.assetId}: ${error.message}`);
    }
  }
  return allTools;
}

// ══════════════════════════════════════
// MCP Server Factory
// ══════════════════════════════════════

function createMCPServer(config, tools, executor) {
  const server = new Server(
    { name: config.domain.domain || 'tmf-mcp-server', version: config.domain.version || '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`\n[Tool Call] ${name}`, JSON.stringify(args, null, 2));
    try {
      const result = await executor.executeTool(name, args || {});
      if (result.success) {
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }
      return { content: [{ type: 'text', text: `API Error (${result.status}): ${result.error}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });
  return server;
}

// ══════════════════════════════════════
// Transport: stdio (local)
// ══════════════════════════════════════

async function startStdio(config, tools, executor) {
  const server = createMCPServer(config, tools, executor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('[Server] Running in stdio mode');
}

// ══════════════════════════════════════
// Transport: HTTP (Streamable + SSE)
// ══════════════════════════════════════

async function startHttp(config, tools, executor) {
  const app = express();
  app.use(express.json());

  // ── CORS ──
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, mcp-session-id, client_id, client_secret');
    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, mcp-session-id');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ── Accept header fix: some clients don't send required Accept header ──
  app.use('/mcp', (req, res, next) => {
    if (req.method === 'POST') {
      const accept = req.headers['accept'] || '';
      if (!accept.includes('text/event-stream') || !accept.includes('application/json')) {
        req.headers['accept'] = 'application/json, text/event-stream';
      }
    }
    next();
  });

  // ══════════════════════════════════════
  // Streamable HTTP: /mcp
  // Used by: Copilot Studio, Claude Desktop, modern MCP clients
  // Pattern: Stateless — each request gets fresh transport
  // This is the simplest, most reliable approach per MCP docs
  // ══════════════════════════════════════

  app.post('/mcp', async (req, res) => {
    try {
      console.log(`[MCP] POST /mcp method=${req.body?.method || 'batch'}`);

      // Create a new transport for every request (stateless)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,  // Stateless: no session tracking
      });

      // Create a new server, connect, handle, cleanup
      const server = createMCPServer(config, tools, executor);
      await server.connect(transport);

      // Cleanup when response finishes
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (error.message?.includes('aborted')) {
        console.log('[MCP] Request aborted by client');
        return;
      }
      console.error(`[MCP] Error: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32000, message: error.message }, id: null });
      }
    }
  });

  // GET /mcp — not needed for stateless mode but handle gracefully
  app.get('/mcp', (req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST for Streamable HTTP.' },
      id: null,
    }));
  });

  // DELETE /mcp — not needed for stateless mode
  app.delete('/mcp', (req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session management not supported in stateless mode.' },
      id: null,
    }));
  });

  // ══════════════════════════════════════
  // Legacy SSE: /sse + /messages
  // Used by: VS Code, older MCP clients
  // ══════════════════════════════════════

  const sseTransports = new Map();

  app.get('/sse', async (req, res) => {
    try {
      console.log('[SSE] New connection from:', req.headers['x-forwarded-for'] || req.ip);

      // SSE-specific settings
      req.socket.setKeepAlive(true, 10000);
      req.socket.setTimeout(0);
      res.setTimeout(0);
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      sseTransports.set(sessionId, transport);
      console.log(`[SSE] Session: ${sessionId} (active: ${sseTransports.size})`);

      const server = createMCPServer(config, tools, executor);

      // Keepalive ping every 15 seconds
      const keepalive = setInterval(() => {
        try {
          if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
          else clearInterval(keepalive);
        } catch { clearInterval(keepalive); }
      }, 15000);

      // Cleanup
      const cleanup = () => {
        clearInterval(keepalive);
        sseTransports.delete(sessionId);
        server.close().catch(() => {});
        console.log(`[SSE] Closed: ${sessionId} (active: ${sseTransports.size})`);
      };
      res.on('close', cleanup);
      req.on('error', cleanup);

      await server.connect(transport);
    } catch (error) {
      console.error(`[SSE] Error: ${error.message}`);
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.post('/messages', async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      const transport = sseTransports.get(sessionId);
      if (!transport) return res.status(404).json({ error: `Session not found: ${sessionId}` });
      await transport.handlePostMessage(req, res);
    } catch (error) {
      if (error.message?.includes('aborted')) return;
      console.error(`[SSE Messages] Error: ${error.message}`);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });

  // ══════════════════════════════════════
  // Utility endpoints
  // ══════════════════════════════════════

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      domain: config.domain.domain,
      toolCount: tools.length,
      tools: tools.map(t => t.name),
      sseSessions: sseTransports.size,
      uptime: Math.round(process.uptime()),
    });
  });

  app.get('/tools', (req, res) => {
    res.json(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
  });

  // Catch-all 404
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', endpoints: ['/mcp', '/sse', '/messages', '/health', '/tools'] });
  });

  // ── Start HTTP server ──
  const httpServer = app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('  TMF MCP Server — HTTP mode');
    console.log('========================================');
    console.log(`  Streamable HTTP : http://0.0.0.0:${HTTP_PORT}/mcp`);
    console.log(`  Legacy SSE      : http://0.0.0.0:${HTTP_PORT}/sse`);
    console.log(`  Health          : http://0.0.0.0:${HTTP_PORT}/health`);
    console.log(`  Tools           : http://0.0.0.0:${HTTP_PORT}/tools`);
    console.log('========================================\n');
  });

  // Server-level timeouts for long-lived SSE connections
  httpServer.keepAliveTimeout = 120000;
  httpServer.headersTimeout = 125000;
  httpServer.requestTimeout = 0;
  httpServer.timeout = 0;
}

// ══════════════════════════════════════
// Main
// ══════════════════════════════════════

async function main() {
  console.log('========================================');
  console.log('  TMF MCP Server — Starting');
  console.log(`  Transport: ${useHttp ? 'HTTP' : 'stdio'}`);
  console.log('========================================\n');

  const config = loadConfig();
  if (!config.anypoint.clientId || config.anypoint.clientId === 'your-client-id-here') {
    console.error('[Error] ANYPOINT_CLIENT_ID not set'); process.exit(1);
  }

  const parser = new SpecParser();
  const executor = new ApiExecutor({
    processApiClientId: config.processApi.clientId,
    processApiClientSecret: config.processApi.clientSecret,
  });

  let tools = [];
  try {
    tools = await discoverTools(config, parser, executor);
  } catch (error) {
    console.error(`[Error] Discovery failed: ${error.message}`);
  }

  console.log(`\n[Server] ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

  if (useHttp) {
    await startHttp(config, tools, executor);
  } else {
    await startStdio(config, tools, executor);
  }
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });