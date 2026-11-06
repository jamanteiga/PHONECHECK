// Proxy Cloudflare Worker para Phone Check ES
// POST { provider: "hlrlookup" | "twilio", number: "+34XXXXXXXXX" }
// Cabecera: Authorization: Bearer <PROXY_TOKEN>
// Devuelve { provider, normalized: {...}, raw: {...} }

const E164_ES = /^\+34[67]\d{8}$/;

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : (allowed[0] || 'null'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    if (origin && !allowed.includes(origin)) return reply({ error: 'origin_not_allowed' }, 403);

    // Autenticación del cliente (tu PWA) contra el proxy
    const auth = request.headers.get('Authorization') || '';
    if (!env.PROXY_TOKEN || !safeEqual(auth, 'Bearer ' + env.PROXY_TOKEN)) {
      return reply({ error: 'unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); } catch { return reply({ error: 'bad_json' }, 400); }
    const { provider, number } = body || {};
    if (typeof number !== 'string' || !E164_ES.test(number)) {
      return reply({ error: 'bad_number', detail: 'Se espera un móvil español en formato +34XXXXXXXXX' }, 400);
    }

    try {
      if (provider === 'hlrlookup') return reply(await hlrlookup(number, env));
      if (provider === 'twilio') return reply(await twilio(number, env));
      return reply({ error: 'bad_provider', detail: 'Usa "hlrlookup" o "twilio"' }, 400);
    } catch (e) {
      return reply({ error: 'upstream', detail: String(e.message || e).slice(0, 400) }, 502);
    }
  },
};

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- HLRLookup.com (API v2) ----------
const HLR_ESTADO = {
  LIVE: ['Activa: usada recientemente y operativa.', true],
  DEAD: ['Sin asignar: el número no está asociado a ninguna SIM.', false],
  ABSENT_SUBSCRIBER: ['Asignada a una SIM, pero apagada, sin cobertura o sin registrar.', null],
  NO_TELESERVICE_PROVISIONED: ['Activa en la red, pero no puede recibir SMS.', true],
  NOT_AVAILABLE_NETWORK_ONLY: ['La red no facilita el estado; solo datos de operadora.', null],
  NO_COVERAGE: ['El proveedor no tiene cobertura para esta red.', null],
  INCONCLUSIVE: ['No se pudo determinar.', null],
  NOT_APPLICABLE: ['No aplicable.', null],
};
const SI_NO = { YES: 'Sí', NO: 'No', UNKNOWN: 'Desconocido' };

async function hlrlookup(number, env) {
  if (!env.HLR_API_KEY || !env.HLR_API_SECRET) throw new Error('Faltan HLR_API_KEY / HLR_API_SECRET en el Worker');
  const r = await fetch('https://api.hlrlookup.com/apiv2/hlr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.HLR_API_KEY,
      api_secret: env.HLR_API_SECRET,
      requests: [{ telephone_number: number }],
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HLRLookup HTTP ${r.status}: ${text}`);
  const data = JSON.parse(text);
  const res = data.results && data.results[0];
  if (!res) throw new Error('Respuesta sin resultados: ' + text.slice(0, 200));
  if (res.error && res.error !== 'NONE') throw new Error('HLRLookup error: ' + res.error);

  const [texto, activa] = HLR_ESTADO[res.live_status] || ['Estado: ' + res.live_status, null];
  const cur = res.current_network_details || {};
  const org = res.original_network_details || {};
  return {
    provider: 'hlrlookup',
    normalized: {
      estado: res.live_status,
      estado_texto: texto,
      activa,
      operadora_actual: cur.name || '',
      operadora_original: org.name || '',
      portado: SI_NO[res.is_ported] || res.is_ported || '',
      tipo: res.telephone_number_type || '',
      mccmnc: cur.mccmnc || org.mccmnc || '',
      area: org.area || '',
      coste: res.credits_spent !== undefined ? String(res.credits_spent) + ' créditos' : '',
    },
    raw: data,
  };
}

// ---------- Twilio Lookup v2 ----------
// line_status está en beta pública y puede no devolver datos para todas las redes.
const TW_ESTADO = {
  reachable: ['Activa y alcanzable (terminal conectado).', true],
  active: ['Activa en la red, no necesariamente alcanzable.', true],
  unreachable: ['Activa, pero el terminal está apagado o sin cobertura.', true],
  inactive: ['Sin asignar a ningún abonado, o no válida.', false],
  unknown: ['No se pudo determinar.', null],
};

async function twilio(number, env) {
  if (!env.TWILIO_API_KEY || !env.TWILIO_API_SECRET) throw new Error('Faltan TWILIO_API_KEY / TWILIO_API_SECRET en el Worker');
  const url = 'https://lookups.twilio.com/v2/PhoneNumbers/' + encodeURIComponent(number) +
    '?Fields=line_status,line_type_intelligence';
  const r = await fetch(url, {
    headers: { Authorization: 'Basic ' + btoa(env.TWILIO_API_KEY + ':' + env.TWILIO_API_SECRET) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Twilio HTTP ${r.status}: ${text}`);
  const data = JSON.parse(text);

  const st = (data.line_status && data.line_status.status || '').toLowerCase();
  const [texto, activa] = TW_ESTADO[st] || ['Sin dato de estado (puede que Twilio no cubra esta red).', null];
  const lti = data.line_type_intelligence || {};
  const mccmnc = lti.mobile_country_code && lti.mobile_network_code
    ? lti.mobile_country_code + lti.mobile_network_code : '';
  return {
    provider: 'twilio',
    normalized: {
      estado: data.line_status ? data.line_status.status : '',
      estado_texto: texto,
      activa,
      operadora_actual: lti.carrier_name || '',
      operadora_original: '',
      portado: '',
      tipo: lti.type || '',
      mccmnc,
      area: '',
      coste: '',
    },
    raw: data,
  };
}
