// Meta (Facebook) Conversions API — espelho server-side dos eventos do Pixel.
//
// O app dispara fbq('track', evento, dados, {eventID}) no navegador e, com
// facebook_pixel_api = true no perfil, manda o mesmo evento pra
// POST /api/menu/company/track_event. Aqui ele é repassado ao Graph API com o
// mesmo event_id, então a Meta deduplica (conta uma vez, mas com mais qualidade
// de correspondência: IP, user-agent, telefone/ID do cliente com hash).
//
// Token: META_PIXEL_TOKEN no .env (Gerenciador de Eventos -> Configurações -> API de Conversões).
const crypto = require("node:crypto");

const VERSAO = "v21.0";
const token = () => process.env.META_PIXEL_TOKEN || "";
const ativo = () => token().length > 20;
const sha = (s) => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

/**
 * @param ev      corpo enviado pelo app: {client_id, event_id, event_name, event_source_url, user_data:{fbc,fbp}, custom_data}
 * @param extra   {ip, userAgent, cliente}  (cliente = linha do banco, opcional)
 */
async function enviar(pixelId, ev, { ip, userAgent, cliente } = {}) {
  if (!ativo() || !pixelId || !ev || !ev.event_name) return { ok: false, motivo: "inativo" };

  const user_data = {
    ...(ev.user_data && ev.user_data.fbc ? { fbc: ev.user_data.fbc } : {}),
    ...(ev.user_data && ev.user_data.fbp ? { fbp: ev.user_data.fbp } : {}),
    ...(ip ? { client_ip_address: ip } : {}),
    ...(userAgent ? { client_user_agent: userAgent } : {}),
    ...(cliente ? { external_id: [sha(cliente.uuid || cliente.id)], ph: [sha(`${cliente.ddi || 55}${cliente.telefone}`)] } : {}),
    ...(cliente && cliente.email ? { em: [sha(cliente.email)] } : {}),
  };
  const corpo = {
    data: [{
      event_name: ev.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: ev.event_id || undefined,
      event_source_url: ev.event_source_url || undefined,
      action_source: "website",
      user_data,
      ...(ev.custom_data ? { custom_data: ev.custom_data } : {}),
    }],
  };
  const r = await fetch(`https://graph.facebook.com/${VERSAO}/${pixelId}/events?access_token=${encodeURIComponent(token())}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, motivo: (j.error && j.error.message) || `HTTP ${r.status}` };
  return { ok: true, recebidos: j.events_received };
}

module.exports = { ativo, enviar };
