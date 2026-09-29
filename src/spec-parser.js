// ============================================
// API Spec Parser
// Parses RAML and OAS specs into a normalized
// tool definition format for MCP registration
// ============================================

import yaml from 'js-yaml';

// Custom YAML type to handle !include tags (returns the filename as a string)
const includeType = new yaml.Type('!include', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => `__include__:${data}`,
});

const RAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([includeType]);

export class SpecParser {

  // ── Main entry point ──
  parse(spec, format, assetId, displayName) {
    console.log(`[Parser] Parsing ${format} spec for: ${assetId}`);

    if (format === 'oas' || format === 'fat-oas') {
      return this.parseOAS(spec, assetId, displayName);
    } else if (format === 'raml' || format === 'fat-raml') {
      return this.parseRAML(spec, assetId, displayName);
    } else {
      if (typeof spec === 'object' && (spec.openapi || spec.swagger || spec.paths)) {
        return this.parseOAS(spec, assetId, displayName);
      }
      if (typeof spec === 'string' && spec.includes('#%RAML')) {
        return this.parseRAML(spec, assetId, displayName);
      }
      console.warn(`[Parser] Unsupported format: ${format}, attempting OAS`);
      try { return this.parseOAS(spec, assetId, displayName); } catch { return []; }
    }
  }

  // ── OAS (OpenAPI / Swagger) Parser ──
  parseOAS(spec, assetId, displayName) {
    if (typeof spec === 'string') {
      try { spec = JSON.parse(spec); } catch { spec = yaml.load(spec); }
    }

    const tools = [];
    const paths = spec.paths || {};
    const basePath = spec.basePath || '';

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;
        const tool = this.buildToolFromOAS(path, method, operation, spec, assetId, displayName, basePath);
        if (tool) tools.push(tool);
      }
    }

    console.log(`[Parser] Generated ${tools.length} tools from OAS: ${assetId}`);
    return tools;
  }

  buildToolFromOAS(path, method, operation, spec, assetId, displayName, basePath) {
    const toolName = operation.operationId || this.generateToolName(method, path, assetId);
    const description = this.buildDescription(
      operation.summary || operation.description || `${method.toUpperCase()} ${path}`,
      displayName, method, path
    );
    const parameters = this.extractOASParameters(operation, spec);
    return {
      name: toolName,
      description,
      parameters,
      apiDetails: { assetId, method: method.toUpperCase(), path: basePath + path, contentType: this.getContentType(operation) },
    };
  }

  extractOASParameters(operation, spec) {
    const properties = {};
    const required = [];

    const params = operation.parameters || [];
    for (const param of params) {
      const resolved = param.$ref ? this.resolveRef(param.$ref, spec) : param;
      if (resolved.in === 'path' || resolved.in === 'query') {
        properties[resolved.name] = {
          type: resolved.schema?.type || resolved.type || 'string',
          description: resolved.description || `${resolved.in} parameter: ${resolved.name}`,
        };
        if (resolved.required) required.push(resolved.name);
      }
    }

    // OAS 3.x request body
    if (operation.requestBody) {
      const jsonContent = operation.requestBody.content?.['application/json'];
      if (jsonContent?.schema) {
        const bodySchema = this.resolveSchema(jsonContent.schema, spec);
        properties['body'] = {
          type: 'object',
          description: operation.requestBody.description || 'Request body payload',
          properties: bodySchema.properties || {},
          required: bodySchema.required || [],
        };
        required.push('body');
      }
    }

    // Swagger 2.x body
    const bodyParam = params.find(p => (p.$ref ? this.resolveRef(p.$ref, spec) : p).in === 'body');
    if (bodyParam) {
      const resolved = bodyParam.$ref ? this.resolveRef(bodyParam.$ref, spec) : bodyParam;
      const bodySchema = this.resolveSchema(resolved.schema || {}, spec);
      properties['body'] = {
        type: 'object',
        description: resolved.description || 'Request body payload',
        properties: bodySchema.properties || {},
        required: bodySchema.required || [],
      };
      required.push('body');
    }

    return { type: 'object', properties, required };
  }

  // ── RAML Parser ──
  parseRAML(specText, assetId, displayName) {
    if (typeof specText !== 'string') {
      specText = JSON.stringify(specText);
    }

    const tools = [];

    // Remove the RAML header line
    const cleanedSpec = specText.replace(/^#%RAML\s+[\d.]+\s*\n?/, '');

    try {
      // Parse using custom schema that handles !include tags
      const raml = yaml.load(cleanedSpec, { schema: RAML_SCHEMA });

      if (!raml || typeof raml !== 'object') {
        console.warn('[Parser] RAML parsed but no content found');
        return tools;
      }

      // Extract baseUri for path building
      let basePath = '';
      if (raml.baseUri) {
        // Remove trailing slash
        basePath = typeof raml.baseUri === 'string' ? raml.baseUri.replace(/\/$/, '') : '';
      }

      console.log(`[Parser] RAML title: ${raml.title || 'unknown'}`);
      console.log(`[Parser] RAML baseUri: ${basePath || 'none'}`);

      // Find all resource paths (keys starting with /)
      const resourceKeys = Object.keys(raml).filter(k => k.startsWith('/'));
      console.log(`[Parser] RAML resources found: ${resourceKeys.join(', ') || 'none'}`);

      for (const key of resourceKeys) {
        this.extractRAMLTools(key, raml[key], tools, assetId, displayName, basePath);
      }
    } catch (e) {
      console.error(`[Parser] RAML parsing error: ${e.message}`);

      // Fallback: regex-based extraction for really complex RAML
      console.log('[Parser] Attempting regex-based RAML extraction...');
      this.extractRAMLToolsRegex(specText, tools, assetId, displayName);
    }

    console.log(`[Parser] Generated ${tools.length} tools from RAML: ${assetId}`);
    return tools;
  }

  extractRAMLTools(path, resource, tools, assetId, displayName, basePath, parentPath = '') {
    const fullPath = parentPath + path;
    const methods = ['get', 'post', 'put', 'patch', 'delete'];

    if (!resource || typeof resource !== 'object') return;

    for (const method of methods) {
      if (resource[method]) {
        const operation = resource[method] || {};

        // Handle case where operation is just an !include reference
        if (typeof operation === 'string' && operation.startsWith('__include__:')) {
          // Still create a tool with basic info
          tools.push(this.buildRAMLTool(method, fullPath, {}, resource, assetId, displayName));
          continue;
        }

        if (typeof operation !== 'object') continue;

        tools.push(this.buildRAMLTool(method, fullPath, operation, resource, assetId, displayName));
      }
    }

    // Process nested resources (keys starting with /)
    for (const [key, value] of Object.entries(resource)) {
      if (key.startsWith('/')) {
        this.extractRAMLTools(key, value, tools, assetId, displayName, basePath, fullPath);
      }
    }
  }

  buildRAMLTool(method, fullPath, operation, resource, assetId, displayName) {
    const toolName = this.generateToolName(method, fullPath, assetId);

    // Get description - handle !include references
    let descText = '';
    if (operation.description && typeof operation.description === 'string' && !operation.description.startsWith('__include__:')) {
      descText = operation.description;
    } else {
      descText = `${method.toUpperCase()} ${fullPath}`;
    }

    const description = this.buildDescription(descText, displayName, method, fullPath);

    const properties = {};
    const required = [];

    // URI parameters (from resource level and nested)
    const uriParams = resource.uriParameters || {};
    for (const [name, param] of Object.entries(uriParams)) {
      if (typeof param === 'string' && param.startsWith('__include__:')) {
        properties[name] = { type: 'string', description: `Path parameter: ${name}` };
      } else if (param && typeof param === 'object') {
        properties[name] = {
          type: param.type || 'string',
          description: param.description || `Path parameter: ${name}`,
        };
      } else {
        properties[name] = { type: 'string', description: `Path parameter: ${name}` };
      }
      required.push(name);
    }

    // Also extract path params from the path pattern itself
    const pathParams = fullPath.match(/\{(\w+)\}/g) || [];
    for (const paramMatch of pathParams) {
      const paramName = paramMatch.replace(/[{}]/g, '');
      if (!properties[paramName]) {
        properties[paramName] = { type: 'string', description: `Path parameter: ${paramName}` };
        required.push(paramName);
      }
    }

    // Query parameters
    const queryParams = operation.queryParameters || {};
    for (const [name, param] of Object.entries(queryParams)) {
      if (typeof param === 'string' && param.startsWith('__include__:')) {
        properties[name] = { type: 'string', description: `Query parameter: ${name}` };
      } else if (param && typeof param === 'object') {
        properties[name] = {
          type: param.type || 'string',
          description: param.description || `Query parameter: ${name}`,
        };
        if (param.required) required.push(name);
      }
    }

    // Request body
    if (operation.body) {
      const bodySpec = operation.body['application/json'] || operation.body;
      if (bodySpec && typeof bodySpec !== 'string') {
        properties['body'] = {
          type: 'object',
          description: (bodySpec.description && !bodySpec.description.startsWith('__include__:'))
            ? bodySpec.description : 'Request body payload',
        };
        if (bodySpec.properties) properties['body'].properties = bodySpec.properties;
        required.push('body');
      } else {
        // Body is an include reference — still add it
        properties['body'] = { type: 'object', description: 'Request body payload' };
        required.push('body');
      }
    }

    return {
      name: toolName,
      description,
      parameters: { type: 'object', properties, required },
      apiDetails: { assetId, method: method.toUpperCase(), path: fullPath, contentType: 'application/json' },
    };
  }

  // Fallback: regex-based RAML extraction for specs that can't be YAML-parsed
  extractRAMLToolsRegex(specText, tools, assetId, displayName) {
    const lines = specText.split('\n');
    let currentPath = '';
    let currentMethod = '';
    const pathStack = [];
    const methods = ['get:', 'post:', 'put:', 'patch:', 'delete:'];

    for (const line of lines) {
      const trimmed = line.trimEnd();
      const indent = line.length - line.trimStart().length;

      // Detect resource paths
      const pathMatch = trimmed.match(/^(\s*)(\/[^:]+):/);
      if (pathMatch) {
        const pathIndent = pathMatch[1].length;
        const path = pathMatch[2].trim();

        // Manage path stack based on indentation
        while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= pathIndent) {
          pathStack.pop();
        }
        pathStack.push({ path, indent: pathIndent });
        currentPath = pathStack.map(p => p.path).join('');
      }

      // Detect HTTP methods
      const methodMatch = trimmed.match(/^\s+(get|post|put|patch|delete):/i);
      if (methodMatch && currentPath) {
        currentMethod = methodMatch[1].toLowerCase();
        const toolName = this.generateToolName(currentMethod, currentPath, assetId);
        const description = this.buildDescription(
          `${currentMethod.toUpperCase()} ${currentPath}`, displayName, currentMethod, currentPath
        );

        // Extract path params
        const properties = {};
        const required = [];
        const pathParams = currentPath.match(/\{(\w+)\}/g) || [];
        for (const pm of pathParams) {
          const name = pm.replace(/[{}]/g, '');
          properties[name] = { type: 'string', description: `Path parameter: ${name}` };
          required.push(name);
        }

        // Add body for write methods
        if (['post', 'put', 'patch'].includes(currentMethod)) {
          properties['body'] = { type: 'object', description: 'Request body payload' };
          required.push('body');
        }

        tools.push({
          name: toolName,
          description,
          parameters: { type: 'object', properties, required },
          apiDetails: { assetId, method: currentMethod.toUpperCase(), path: currentPath, contentType: 'application/json' },
        });
      }
    }

    console.log(`[Parser] Regex extraction found ${tools.length} tools`);
  }

  // ── Helpers ──

  generateToolName(method, path, assetId) {
    const methodMap = { get: 'get', post: 'create', put: 'update', patch: 'update', delete: 'delete' };
    const prefix = methodMap[method.toLowerCase()] || method.toLowerCase();

    const pathParts = path
      .split('/')
      .filter(p => p && !p.startsWith('{'))
      .map(p => p.charAt(0).toUpperCase() + p.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

    const hasIdParam = path.match(/\{(\w+)\}$/);
    const suffix = hasIdParam ? 'ById' : '';

    return prefix + pathParts.join('') + suffix;
  }

  buildDescription(summary, displayName, method, path) {
    const methodVerbs = { get: 'Retrieve', post: 'Create', put: 'Update', patch: 'Partially update', delete: 'Delete' };
    const verb = methodVerbs[method.toLowerCase()] || method.toUpperCase();
    let desc = summary;
    if (!desc || desc === `${method.toUpperCase()} ${path}`) {
      desc = `${verb} resource at ${path}`;
    }
    return desc + ` [API: ${displayName}]`;
  }

  resolveRef(ref, spec) {
    if (!ref || !ref.startsWith('#/')) return {};
    const parts = ref.replace('#/', '').split('/');
    let current = spec;
    for (const part of parts) {
      current = current?.[part];
      if (!current) return {};
    }
    return current;
  }

  resolveSchema(schema, spec) {
    if (!schema) return {};
    if (schema.$ref) return this.resolveRef(schema.$ref, spec);
    return schema;
  }

  getContentType(operation) {
    if (operation.requestBody?.content) return Object.keys(operation.requestBody.content)[0] || 'application/json';
    if (operation.consumes) return operation.consumes[0] || 'application/json';
    return 'application/json';
  }
}