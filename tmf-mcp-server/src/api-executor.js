// ============================================
// API Executor
// Generic handler that routes MCP tool calls
// to the correct backend Process API
// ============================================

import fetch from 'node-fetch';

export class ApiExecutor {
  constructor(config) {
    this.processApiClientId = config.processApiClientId;
    this.processApiClientSecret = config.processApiClientSecret;
    this.toolRegistry = new Map(); // toolName → { apiDetails, endpoint }
  }

  // ── Register a tool with its API details and endpoint ──
  registerTool(toolName, apiDetails, endpoint) {
    this.toolRegistry.set(toolName, { apiDetails, endpoint });
    console.log(`[Executor] Registered: ${toolName} → ${apiDetails.method} ${endpoint}${apiDetails.path}`);
  }

  // ── Execute a tool call ──
  async executeTool(toolName, input) {
    const registration = this.toolRegistry.get(toolName);
    
    if (!registration) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const { apiDetails, endpoint } = registration;
    const { method, path, contentType } = apiDetails;

    // Build the final URL
    let finalPath = path;
    const queryParams = {};
    console.log(`path...........: ${path}`);
    
    // Replace path parameters: /customer/{id} → /customer/C001
    for (const [key, value] of Object.entries(input)) {
      if (key === 'body') continue;
      
      if (finalPath.includes(`{${key}}`)) {
        finalPath = finalPath.replace(`{${key}}`, encodeURIComponent(value));
      } else {
        // Assume it's a query parameter
        queryParams[key] = value;
      }
    }

    // Build query string
    const queryString = Object.keys(queryParams).length > 0
      ? '?' + new URLSearchParams(queryParams).toString()
      : '';

    const url = `${endpoint}${finalPath}${queryString}`;

    // Build request options
    const options = {
      method,
      headers: {
        'Accept': 'application/json',
        'client_id': this.processApiClientId,
        'client_secret': this.processApiClientSecret,
      },
    };

    // Add body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(method) && input.body) {
      options.headers['Content-Type'] = contentType || 'application/json';
      options.body = typeof input.body === 'string' 
        ? input.body 
        : JSON.stringify(input.body);
    }

    console.log(`[Executor] Calling: ${method} ${url}`);

    try {
      const response = await fetch(url, options);
      const responseText = await response.text();

      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      if (!response.ok) {
        console.error(`[Executor] API Error ${response.status}: ${responseText}`);
        return {
          success: false,
          status: response.status,
          error: typeof responseData === 'object' 
            ? responseData.message || responseData.error || responseText
            : responseText,
        };
      }

      console.log(`[Executor] Success: ${method} ${url} → ${response.status}`);
      return {
        success: true,
        status: response.status,
        data: responseData,
      };

    } catch (error) {
      console.error(`[Executor] Network error: ${error.message}`);
      return {
        success: false,
        error: `Network error: ${error.message}`,
      };
    }
  }

  // ── Get all registered tools ──
  getRegisteredTools() {
    return Array.from(this.toolRegistry.entries()).map(([name, details]) => ({
      name,
      method: details.apiDetails.method,
      path: details.apiDetails.path,
      endpoint: details.endpoint,
    }));
  }
}
