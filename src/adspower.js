const config = require('./config');

let runtimeApiKey = '';

function setAdspowerApiKey(value = '') {
  runtimeApiKey = String(value || '').trim();
}

function headers() {
  const result = { 'Content-Type': 'application/json' };
  const apiKey = runtimeApiKey || config.adspower.apiKey;
  if (apiKey) {
    result.Authorization = `Bearer ${apiKey}`;
  }
  return result;
}

async function adspowerRequest(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const requestOptions = { ...options };
  delete requestOptions.timeoutMs;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch(`${config.adspower.baseUrl}${path}`, {
      ...requestOptions,
      signal: controller?.signal || requestOptions.signal,
      headers: { ...headers(), ...(requestOptions.headers || {}) }
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error('O AdsPower ainda está preparando o navegador.');
      timeoutError.code = 'ADSPOWER_REQUEST_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`ADSPower HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    error.payload = body;
    throw error;
  }
  if (typeof body.code === 'number' && body.code !== 0) {
    const error = new Error(body.msg || `ADSPower retornou code ${body.code}`);
    error.status = 502;
    error.body = body;
    error.payload = body;
    throw error;
  }
  return body;
}

function resolveProfileId(profileId) {
  const resolved = profileId || config.adspower.profileId;
  if (!resolved) {
    const error = new Error('profileId nÃ£o informado e ADSPOWER_PROFILE_ID nÃ£o configurado');
    error.status = 400;
    throw error;
  }
  return resolved;
}

async function openConfiguredProfile(profileId, options = {}) {
  const resolvedProfileId = resolveProfileId(profileId);
  const launchUrl = String(options.launchUrl || options.startUrl || options.url || '').trim();
  const params = new URLSearchParams({
    user_id: resolvedProfileId,
    open_tabs: launchUrl ? '1' : config.adspower.openTabs,
    ip_tab: config.adspower.ipTab,
    disable_password_filling: config.adspower.disablePasswordFilling,
    enable_password_saving: config.adspower.enablePasswordSaving,
    clear_cache_after_closing: config.adspower.clearCacheAfterClosing
  });
  if (launchUrl) params.set('launch_args', JSON.stringify([launchUrl]));
  return adspowerRequest(`/api/v1/browser/start?${params.toString()}`, { method: 'GET', timeoutMs: 15000 });
}

async function closeConfiguredProfile(profileId) {
  const resolvedProfileId = resolveProfileId(profileId);
  const params = new URLSearchParams({ user_id: resolvedProfileId });
  return adspowerRequest(`/api/v1/browser/stop?${params.toString()}`, { method: 'GET' });
}

async function getBrowserStatus(profileId) {
  const resolvedProfileId = resolveProfileId(profileId);
  const params = new URLSearchParams({ user_id: resolvedProfileId });
  return adspowerRequest(`/api/v1/browser/active?${params.toString()}`, { method: 'GET', timeoutMs: 3000 });
}

async function queryConfiguredProfile() {
  if (!config.adspower.profileId) return null;
  return adspowerRequest('/api/v2/browser-profile/list', {
    method: 'POST',
    body: JSON.stringify({ profile_id: [config.adspower.profileId], page: 1, limit: 1 })
  });
}

async function listAdspowerGroups() {
  return adspowerRequest('/api/v1/group/list?page=1&page_size=200', { method: 'GET' });
}

async function listAdspowerProfiles(groupId = '') {
  const params = new URLSearchParams({ page: '1', page_size: '200' });
  if (groupId) params.set('group_id', groupId);
  return adspowerRequest(`/api/v1/user/list?${params.toString()}`, { method: 'GET' });
}

module.exports = {
  setAdspowerApiKey,
  listAdspowerGroups,
  listAdspowerProfiles,
  openConfiguredProfile,
  closeConfiguredProfile,
  getBrowserStatus,
  queryConfiguredProfile
};

