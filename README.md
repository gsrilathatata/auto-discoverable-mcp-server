# TMF MCP Server - Dynamic Tool Discovery

Auto-discovers TMF Process APIs from Anypoint Exchange and exposes them as MCP tools for AI agents.

## Architecture

```
Agent (VS Code / Claude)
    ↓ MCP protocol (stdio)
Flex Gateway (OAuth policy)
    ↓
This MCP Server (Node.js)
    ↓ HTTP (client credentials)
TMF Process APIs (CloudHub)
```

## Project Structure

```
tmf-mcp-server/
├── config/
│   ├── domain.json          ← Whitelist of Exchange assets to expose
│   └── vscode-mcp.json      ← VS Code MCP config (copy to your user settings)
├── src/
│   ├── server.js             ← Main MCP server entry point
│   ├── anypoint-client.js    ← Anypoint Platform API client
│   ├── spec-parser.js        ← RAML/OAS spec → tool definition parser
│   └── api-executor.js       ← Generic tool → HTTP request executor
├── .env                      ← Credentials (DO NOT COMMIT)
├── package.json
└── README.md
```

## Setup

### 1. Install dependencies

```bash
cd tmf-mcp-server
npm install
```

### 2. Configure .env

Fill in your credentials in `.env`:

```
ANYPOINT_CLIENT_ID=<from Connected Apps>
ANYPOINT_CLIENT_SECRET=<from Connected Apps>
ANYPOINT_ORG_ID=<from Access Management → Organization>
ANYPOINT_ENV_ID=<from API Manager URL>
PROCESS_API_CLIENT_ID=<credentials for calling backend APIs>
PROCESS_API_CLIENT_SECRET=<credentials for calling backend APIs>
```

### 3. Configure domain.json

Edit `config/domain.json` to whitelist the APIs you want exposed:

```json
{
  "exchangeAssets": [
    {
      "assetId": "tmf-customer-api",
      "displayName": "TMF Customer API",
      "version": "1.0.0"
    }
  ]
}
```

The `assetId` must match the asset ID in Anypoint Exchange exactly.

### 4. Register in VS Code

Copy the `tmf-customer-ops` section from `config/vscode-mcp.json` into your VS Code `mcp.json`:

- **Windows:** `C:\Users\<user>\AppData\Roaming\Code\User\mcp.json`
- **macOS:** `~/Library/Application Support/Code/User/mcp.json`

Update the path in `"args"` to point to your actual `server.js` location.

### 5. Test

Restart VS Code, open Agent mode, and verify the TMF tools appear.

## Adding New APIs

1. Deploy the API to CloudHub
2. Manage it in API Manager (so it has an endpoint URL)
3. Add entry to `config/domain.json`:
   ```json
   {
     "assetId": "tmf-billing-api",
     "displayName": "TMF Billing API",
     "version": "1.0.0"
   }
   ```
4. Restart VS Code — new tools auto-discovered

## Creating Domain-Specific MCP Servers

Copy this project and change `config/domain.json` to create separate servers per domain:

- **Customer Ops MCP:** customer-api, trouble-ticket-api
- **Billing MCP:** customer-bill-api, payment-api, payment-method-api
- **Network MCP:** service-inventory-api, network-api

Each domain gets its own MCP server entry in VS Code's `mcp.json`.
