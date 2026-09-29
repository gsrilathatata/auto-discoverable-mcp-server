// ============================================
// Anypoint Platform Client
// Handles authentication and API calls to:
//   - Exchange (fetch API specs)
//   - API Manager (fetch deployed endpoint URLs)
// ============================================

import fetch from 'node-fetch';

const REGION_URLS = {
  PROD_US: 'https://anypoint.mulesoft.com',
  PROD_EU: 'https://eu1.anypoint.mulesoft.com',
  PROD_CA: 'https://ca.anypoint.mulesoft.com',
  PROD_JP: 'https://jp.anypoint.mulesoft.com',
};

export class AnypointClient {
  constructor(config) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.orgId = config.orgId;
    this.envId = config.envId;
    this.baseUrl = REGION_URLS[config.region] || REGION_URLS.PROD_US;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async authenticate() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    console.log('[Anypoint] Authenticating...');
    const response = await fetch(this.baseUrl + '/accounts/api/v2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }),
    });
    if (!response.ok) throw new Error('[Anypoint] Auth failed: ' + response.status);
    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + 50 * 60 * 1000;
    console.log('[Anypoint] Authenticated');
    return this.accessToken;
  }

  // Smart spec file finder for zip archives
  findSpecInZip(entries) {
    const isRootLevel = (name) => !name.includes('/');
    const isSkipPath = (name) =>
      name === 'exchange.json' ||
      name.startsWith('exchange_modules/') ||
      name.startsWith('examples/') ||
      name.includes('/examples/') ||
      name.startsWith('common-libraries/') ||
      name.startsWith('docs/');

    const specEntries = entries.filter(e => !e.isDirectory && (
      e.entryName.endsWith('.raml') || e.entryName.endsWith('.yaml') ||
      e.entryName.endsWith('.yml') || e.entryName.endsWith('.json')
    ));

    // Priority 1: Root-level .raml
    let found = specEntries.find(e => isRootLevel(e.entryName) && e.entryName.endsWith('.raml'));
    if (found) return found;
    // Priority 2: Root-level .yaml/.yml
    found = specEntries.find(e => isRootLevel(e.entryName) && (e.entryName.endsWith('.yaml') || e.entryName.endsWith('.yml')));
    if (found) return found;
    // Priority 3: Root-level known JSON specs
    found = specEntries.find(e => isRootLevel(e.entryName) && ['api.json','swagger.json','openapi.json'].includes(e.entryName));
    if (found) return found;
    // Priority 4: Root-level .json (not exchange.json)
    found = specEntries.find(e => isRootLevel(e.entryName) && e.entryName.endsWith('.json') && e.entryName !== 'exchange.json');
    if (found) return found;
    // Priority 5: Any .raml not in skip paths
    found = specEntries.find(e => e.entryName.endsWith('.raml') && !isSkipPath(e.entryName));
    if (found) return found;
    // Priority 6: Any .yaml/.yml not in skip paths
    found = specEntries.find(e => (e.entryName.endsWith('.yaml') || e.entryName.endsWith('.yml')) && !isSkipPath(e.entryName));
    if (found) return found;
    // Priority 7: Fallback
    found = specEntries.find(e => !isSkipPath(e.entryName));
    return found || null;
  }

  async fetchApiSpec(assetId, version, groupId) {
    const token = await this.authenticate();
    const gId = groupId || process.env.ANYPOINT_GROUP_ID || this.orgId;
    console.log('[Exchange] Fetching spec for: ' + assetId + ' v' + version + ' (group: ' + gId + ')');

    // Search for exact version
    const searchUrl = this.baseUrl + '/exchange/api/v2/assets?search=' + assetId + '&organizationId=' + gId;
    console.log('[Exchange] Searching: ' + searchUrl);
    const searchResponse = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    let exactVersion = version;
    if (searchResponse.ok) {
      const results = await searchResponse.json();
      const match = results.find(a => a.assetId === assetId);
      if (match) { exactVersion = match.version; console.log('[Exchange] Exact version: ' + exactVersion); }
      else console.warn('[Exchange] Asset ' + assetId + ' not found in search');
    }

    // Fetch asset details
    const assetUrl = this.baseUrl + '/exchange/api/v2/assets/' + gId + '/' + assetId + '/' + exactVersion;
    console.log('[Exchange] Fetching: ' + assetUrl);
    const assetResponse = await fetch(assetUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!assetResponse.ok) {
      console.error('[Exchange] Asset fetch failed: ' + assetResponse.status);
      return await this.fetchSpecDirect(assetId, exactVersion, token, gId);
    }

    const asset = await assetResponse.json();
    console.log('[Exchange] Asset found: ' + (asset.name || assetId));

    // Prefer fat-raml/fat-oas (includes all dependencies)
    const specFile = asset.files?.find(f => f.classifier === 'fat-raml' || f.classifier === 'fat-oas')
      || asset.files?.find(f => f.classifier === 'oas' || f.classifier === 'raml' || f.mainFile);

    if (!specFile) {
      console.log('[Exchange] No spec file in metadata, trying direct');
      return await this.fetchSpecDirect(assetId, exactVersion, token, gId);
    }

    console.log('[Exchange] Spec classifier: ' + specFile.classifier);
    const specUrl = specFile.externalLink || (assetUrl + '/files/' + specFile.classifier + '/' + specFile.packaging);
    const isExternal = specUrl.includes('s3.amazonaws.com') || specUrl.includes('cloudfront');
    const specHeaders = isExternal ? {} : { 'Authorization': 'Bearer ' + token };

    try {
      const specResponse = await fetch(specUrl, { headers: specHeaders });
      if (!specResponse.ok) return await this.fetchSpecDirect(assetId, exactVersion, token, gId);

      const contentType = specResponse.headers.get('content-type') || '';
      const contentDisposition = specResponse.headers.get('content-disposition') || '';

      if (contentType.includes('zip') || contentDisposition.includes('.zip') || specUrl.includes('.zip')) {
        console.log('[Exchange] Extracting zip...');
        const { default: AdmZip } = await import('adm-zip');
        const buffer = Buffer.from(await specResponse.arrayBuffer());
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        console.log('[Exchange] Zip files: ' + entries.filter(e => !e.isDirectory).map(e => e.entryName).join(', '));

        const specEntry = this.findSpecInZip(entries);
        if (!specEntry) throw new Error('No spec file found in zip');

        console.log('[Exchange] Selected: ' + specEntry.entryName);
        const specText = specEntry.getData().toString('utf8');

        // Detect format
        let format;
        if (specEntry.entryName.endsWith('.raml') || specText.trimStart().startsWith('#%RAML')) {
          format = 'raml';
        } else {
          try { const p = JSON.parse(specText); format = (p.openapi || p.swagger) ? 'oas' : 'unknown'; }
          catch { format = specText.includes('openapi') ? 'oas' : 'unknown'; }
        }

        const spec = format === 'raml' ? specText : (() => { try { return JSON.parse(specText); } catch { return specText; } })();
        console.log('[Exchange] Success: ' + assetId + ' (format: ' + format + ', file: ' + specEntry.entryName + ')');
        return { spec, format };
      }

      // Non-zip
      const spec = contentType.includes('json') ? await specResponse.json() : await specResponse.text();
      const format = specFile.classifier || this.detectFormat(spec);
      console.log('[Exchange] Success: ' + assetId + ' (format: ' + format + ')');
      return { spec, format };

    } catch (err) {
      console.error('[Exchange] Download error: ' + err.message);
      return await this.fetchSpecDirect(assetId, exactVersion, token, gId);
    }
  }

  async fetchSpecDirect(assetId, version, token, groupId) {
    const gId = groupId || process.env.ANYPOINT_GROUP_ID || this.orgId;
    const formats = [
      { path: '/exchange/api/v2/assets/' + gId + '/' + assetId + '/' + version + '/oas/json', format: 'oas' },
      { path: '/exchange/api/v2/assets/' + gId + '/' + assetId + '/' + version + '/raml', format: 'raml' },
    ];
    for (const { path, format } of formats) {
      try {
        const response = await fetch(this.baseUrl + path, { headers: { 'Authorization': 'Bearer ' + token } });
        if (response.ok) {
          const spec = format === 'oas' ? await response.json() : await response.text();
          console.log('[Exchange] Direct fetch success (' + format + '): ' + assetId);
          return { spec, format };
        }
      } catch (e) { /* try next */ }
    }
    throw new Error('[Exchange] Could not fetch spec for ' + assetId);
  }

  detectFormat(spec) {
    if (typeof spec === 'object') return (spec.openapi || spec.swagger) ? 'oas' : 'unknown';
    if (typeof spec === 'string') {
      if (spec.includes('#%RAML')) return 'raml';
      if (spec.includes('openapi') || spec.includes('swagger')) return 'oas';
    }
    return 'unknown';
  }

  async fetchApiEndpoint(assetId) {
    const token = await this.authenticate();
    console.log('[API Manager] Fetching endpoint for: ' + assetId);
    const url = this.baseUrl + '/apimanager/api/v1/organizations/' + this.orgId + '/environments/' + this.envId + '/apis?assetId=' + assetId;
    const response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!response.ok) throw new Error('[API Manager] Failed: ' + response.status);
    const data = await response.json();
    const apis = data.assets || [];
    if (apis.length === 0) { console.warn('[API Manager] No instance for: ' + assetId); return null; }
    const apiInstance = apis[0]?.apis?.[0];
    if (!apiInstance) { console.warn('[API Manager] No API instance for: ' + assetId); return null; }
    const endpoint = apiInstance.endpointUri || apiInstance.endpoint?.uri || apiInstance.endpoint?.proxyUri;
    console.log('[API Manager] Endpoint: ' + endpoint);
    return endpoint;
  }

  async getAssetDetails(assetId, version, groupId) {
    const [specResult, endpoint] = await Promise.all([
      this.fetchApiSpec(assetId, version, groupId),
      this.fetchApiEndpoint(assetId),
    ]);
    return { assetId, version, spec: specResult.spec, format: specResult.format, endpoint };
  }
}