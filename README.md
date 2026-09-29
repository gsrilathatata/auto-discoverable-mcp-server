# TMF MCP Server

**Auto-discover APIs as AI tools and execute them — zero manual schema writing.**

A Node.js MCP (Model Context Protocol) server that connects to an API management platform, reads existing API specifications (OAS/RAML), and automatically registers every resource as an AI-callable tool. AI agents discover and invoke enterprise APIs through natural language — no custom connector per API, no hand-coded schema per resource.

## How It Works

```
┌──────────────────┐     Streamable HTTP + SSE      ┌──────────────────────┐
│   AI Agents      │ ──────── JSON-RPC ──────────▶  │   TMF MCP Server     │
│  (Claude, Copilot│     tools/list, tools/call      │  Auto-discovers from │
│   GPT, Gemini)   │ ◀──────────────────────────── │  OAS/RAML specs      │
└──────────────────┘                                 └──────┬───────┬───────┘
                                                           │       │
                                              Fetch specs  │       │ Execute APIs
                                                           ▼       ▼
                                                    ┌────────┐ ┌────────────┐
                                                    │Exchange │ │API Gateway │
                                                    │(Specs)  │ │(Policies)  │
                                                    └────────┘ └─────┬──────┘
                                                                     │
                                                              ┌──────▼──────┐
                                                              │Backend APIs │
                                                              │(Live Data)  │
                                                              └─────────────┘
```

### Startup (Auto-Discovery)

1. Server reads `domain.json` for configured API asset IDs
2. Fetches API specs (OAS preferred over RAML) from the API catalog
3. Parses specs — extracts resource paths, HTTP methods, parameters, and request body schemas
4. Registers each resource as an MCP tool with accurate input schemas
5. Server ready — `tools/list` returns all discovered tools

### Runtime (Tool Execution)

1. AI agent calls `tools/call` with a tool name and arguments
2. Server constructs the HTTP request from the tool's API details
3. Request is forwarded through the API gateway (policy-enforced)
4. Response is returned to the agent, formatted for AI context

## Quick Start

### Prerequisites

- Node.js 18+
- Access to an API management platform with published API specs
- Connected App credentials (client ID and secret)
- API gateway for backend API routing (optional but recommended)

### Installation

```bash
git clone <repo-url>
cd tmf-mcp-server
npm install
```

### Configuration

Create a `.env` file:

```env
ANYPOINT_CLIENT_ID=your-connected-app-client-id
ANYPOINT_CLIENT_SECRET=your-connected-app-client-secret
ANYPOINT_ORG_ID=your-organization-id
ANYPOINT_ENV_ID=your-environment-id
ANYPOINT_REGION=PROD_US
PORT=8081
```

Create `config/domain.json`:

```json
{
  "exchangeAssets": [
    {
      "assetId": "customer-management-api",
      "version": "1.0.0",
      "groupId": "your-group-id",
      "displayName": "Customer Management API"
    },
    {
      "assetId": "billing-api",
      "version": "1.0.0",
      "groupId": "your-group-id",
      "displayName": "Billing API"
    }
  ]
}
```

### Run

```bash
# Development
node src/server.js

# Production (PM2)
pm2 start src/server.js --name "tmf-mcp" -- --http
pm2 save
```

### Verify

```bash
# Health check
curl http://localhost:8081/health

# List discovered tools
curl -X POST http://localhost:8081/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'

curl -X POST http://localhost:8081/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## Connecting AI Clients

### VS Code (GitHub Copilot Chat)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "tmf-mcp": {
      "type": "sse",
      "url": "http://localhost:8081/sse"
    }
  }
}
```

Enable MCP in VS Code settings: `chat.mcp.enabled = true`

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tmf-mcp": {
      "url": "http://localhost:8081/sse"
    }
  }
}
```

### Copilot Studio

Add as a Model Context Protocol connector with Server URL: `http://your-host:8081/mcp`

### Postman

```
POST http://localhost:8081/mcp
Headers:
  Content-Type: application/json
  Accept: application/json, text/event-stream
Body:
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"getCustomerById","arguments":{"id":"123"}}}
```

## Tool Customization

### Override Tool Descriptions

Auto-generated descriptions work out of the box. For AI-friendlier descriptions, add overrides in `domain.json`:

```json
{
  "exchangeAssets": [
    {
      "assetId": "customer-management-api",
      "toolDescriptions": {
        "getCustomerById": "Retrieve a customer profile including name, address, contact details, and account status. Use when the user asks about a specific customer.",
        "updateCustomerById": "Update customer profile details such as name, address, or status."
      }
    }
  ]
}
```

### Override Body Schemas

When auto-parsed body schemas lack detail (common with `$ref`-heavy specs), add explicit schemas:

```json
{
  "exchangeAssets": [
    {
      "assetId": "customer-management-api",
      "toolBodySchemas": {
        "updateCustomerById": {
          "name": { "type": "string", "description": "Customer's full name" },
          "status": { "type": "string", "description": "Customer status: approved, active, inactive" },
          "contactMedium": { "type": "array", "description": "Contact details (email, phone)" }
        }
      }
    }
  ]
}
```

## Architecture

### Project Structure

```
tmf-mcp-server/
├── src/
│   ├── server.js           # MCP server — tool registration, request handling
│   ├── anypoint-client.js   # API platform client — auth, spec fetching, endpoint discovery
│   └── spec-parser.js       # OAS/RAML parser — converts specs to tool definitions
├── config/
│   └── domain.json          # Asset configuration, tool overrides
├── .env                     # Credentials (not committed)
└── package.json
```

### Spec Parsing

The server supports two specification formats:

**OAS (OpenAPI / Swagger)** — preferred. Self-contained JSON, native `$ref` resolution, no external dependencies.

**RAML** — supported with a three-layer parsing approach:
1. Custom YAML schema that registers `!include` as a known tag (prevents parser crashes)
2. Include-aware tool builder that handles unresolved references gracefully
3. Regex fallback that extracts resources by line-by-line analysis if YAML parsing fails

The server prefers OAS over RAML when both are available (`fat-oas` → `oas` → `fat-raml` → `raml`). Most API catalogs auto-generate OAS from RAML with all schemas inlined, avoiding `!include` issues entirely.

### Zip Extraction Priority

When specs are downloaded as zip archives, the server selects the main spec file using priority-based logic:

1. Root-level `.raml` files
2. Root-level `.yaml` / `.yml` files
3. Known JSON specs (`api.json`, `swagger.json`, `openapi.json`)
4. Root-level `.json` (excluding `exchange.json`)
5. Any spec file not in skip paths (`exchange_modules/`, `examples/`, `common-libraries/`, `docs/`)

### Dual Transport

The server supports two MCP transport protocols simultaneously:

- **Streamable HTTP** (`/mcp`) — stateless JSON-RPC over HTTP POST. Works with Copilot Studio and Postman.
- **SSE** (`/sse`) — Server-Sent Events for persistent connections. Works with VS Code and Claude Desktop.

## Adding a New API

No code changes required:

1. Publish your API spec to the API catalog
2. Add its `assetId` and `groupId` to `config/domain.json`
3. Optionally add tool description overrides
4. Restart the server

The new API's resources are auto-registered as tools.

## Security

### Current Implementation

- Connected App credentials for API catalog authentication (OAuth 2.0 client_credentials)
- Token caching with early refresh (50-minute TTL on 60-minute tokens)
- API gateway enforcement on all backend API calls (rate limiting, auth, audit)
- Environment-based configuration (credentials in `.env`, not in code)

### Recommended for Production

| OWASP MCP Risk | Status | Recommendation |
|---|---|---|
| MCP07: No auth on MCP endpoint | Gap | Add API key or JWT validation on the MCP endpoint itself |
| MCP02: No role-based tool access | Gap | Implement ABAC — filter tools by user role (viewer gets GET only) |
| MCP10: PII in responses | Gap | Add response filtering to mask sensitive fields before returning to agent |
| MCP01: Credentials in .env | Moderate | Use a secrets manager (Vault, cloud KMS) |
| MCP08: No audit trail | Moderate | Add structured logging with request IDs and user attribution |
| MCP05: Input validation | Low risk | Add regex/length constraints on string parameters beyond Zod types |
| MCP03: Tool poisoning | Low risk | Allowlist asset IDs in domain.json; validate spec sources |

### API Gateway Policies

When using an API gateway (e.g., Flex Gateway), the following policies can be applied to the MCP server instance:

- **MCP Schema Validation** — validates each request complies with MCP specification
- **MCP Support** — required policy for gateway-managed MCP server instances
- **Attribute-Based Access Control** — controls access to tools based on user attributes (tier, IP, role)
- **MCP PII Detector** — detects and handles PII in tool responses
- **MCP Tool Mapping** — allows remapping of tool names

## Scaling

### Current Capacity

Single VM handles approximately 500 requests/minute with headroom.

### Horizontal Scaling

```bash
# PM2 cluster mode
pm2 stop tmf-mcp
pm2 start src/server.js --name "tmf-mcp" -i 2 -- --http
pm2 save
```

### For Higher Load

- PM2 cluster mode (2–4 instances per VM)
- Add Redis caching for API specs (refresh hourly)
- Load balancer across multiple VMs (server is stateless)

## Comparison: Auto-Discovery vs Manual Schema Approach

| Aspect | Manual (one app per API) | Auto-Discovery (this server) |
|---|---|---|
| Adding a new API | Build app, define schemas, deploy | Add one line to config, restart |
| Schema accuracy | Hand-written, can drift from spec | Parsed from spec, always current |
| Maintenance | N apps to maintain | One server |
| Time to new tool | Days to weeks | Minutes |
| Code changes | Required per API | None (config only) |

## Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `node-fetch` — HTTP client for API calls
- `zod` — Runtime parameter validation
- `dotenv` — Environment configuration
- `adm-zip` — Spec zip extraction
- `js-yaml` — YAML/RAML parsing
- `express` — HTTP server for dual transport

## License

MIT
