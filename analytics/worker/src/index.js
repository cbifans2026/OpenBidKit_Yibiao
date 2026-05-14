const DATASET = 'agnet_analytics';
const ALLOWED_EVENTS = new Set(['app_open', 'page_view']);
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function isValidProjectName(projectName) {
  return PROJECT_NAME_PATTERN.test(projectName);
}

function requireAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || '');
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(token) && authorization === `Bearer ${token}`;
}

function safeDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(Math.floor(days), 90));
}

function safeLimit(value) {
  const limit = Number(value || 50);
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function queryAnalytics(env, sql) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    throw new Error('missing analytics api config');
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;
  const response = await fetch(api, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`,
    },
    body: sql,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ code: 0, ok: true });
    }

    if (url.pathname === '/track') {
      return handleTrack(request, env);
    }

    if (url.pathname === '/api/projects') {
      return handleProjects(request, env);
    }

    if (url.pathname === '/api/summary') {
      return handleSummary(request, env, url);
    }

    if (url.pathname === '/api/latest') {
      return handleLatest(request, env, url);
    }

    return json({ code: 404, message: 'not found' }, { status: 404 });
  },
};

async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const projectName = normalizeText(body.projectName || body.project_name, 80);
    const event = normalizeText(body.event, 50);
    const page = normalizeText(body.page, 120);
    const version = normalizeText(body.version, 50);
    const platform = normalizeText(body.platform, 50);
    const arch = normalizeText(body.arch, 50);
    const clientId = normalizeText(body.client_id || body.clientId, 120);

    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }

    if (!ALLOWED_EVENTS.has(event)) {
      return json({ code: 400, message: 'invalid event' }, { status: 400 });
    }

    if (event === 'page_view' && !page) {
      return json({ code: 400, message: 'missing page' }, { status: 400 });
    }

    env.ANALYTICS.writeDataPoint({
      blobs: [projectName, event, page, version, platform, arch, clientId],
      doubles: [1],
      indexes: [projectName],
    });

    return json({ code: 0 });
  } catch {
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}

async function handleProjects(request, env) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const sql = `
    SELECT
      blob1 AS projectName
    FROM ${DATASET}
    WHERE timestamp >= NOW() - INTERVAL '90' DAY
    GROUP BY projectName
    ORDER BY projectName ASC
  `;

  try {
    const result = await queryAnalytics(env, sql);
    return json({
      code: 0,
      projects: (result.data || []).map((item) => item.projectName).filter(Boolean),
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleSummary(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const dailySql = `
    SELECT
      toDate(timestamp) AS date,
      blob2 AS event,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 IN ('app_open', 'page_view')
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY date, event
    ORDER BY date ASC, event ASC
  `;

  const pagesSql = `
    SELECT
      blob3 AS page,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'page_view'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY page
    ORDER BY count DESC
    LIMIT 100
  `;

  const versionsSql = `
    SELECT
      blob4 AS version,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob4 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY version
    ORDER BY count DESC
    LIMIT 50
  `;

  try {
    const [daily, pages, versions] = await Promise.all([
      queryAnalytics(env, dailySql),
      queryAnalytics(env, pagesSql),
      queryAnalytics(env, versionsSql),
    ]);

    return json({
      code: 0,
      projectName,
      days,
      daily: daily.data || [],
      pages: pages.data || [],
      versions: versions.data || [],
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleLatest(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const limit = safeLimit(url.searchParams.get('limit'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const sql = `
    SELECT
      timestamp,
      blob1 AS projectName,
      blob2 AS event,
      blob3 AS page,
      blob4 AS version,
      blob5 AS platform,
      blob6 AS arch,
      blob7 AS clientId
    FROM ${DATASET}
    WHERE blob1 = ${sqlString(projectName)}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;

  try {
    const latest = await queryAnalytics(env, sql);
    return json({
      code: 0,
      events: latest.data || [],
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
