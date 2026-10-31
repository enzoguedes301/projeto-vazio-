// Pix automático via Tronfy (https://api.tronfy.com.br/v1).
// A chave privada vem de process.env.TRONFY_API_KEY (arquivo .env ou variável da hospedagem).
const qrcode = require("./vendor/qrcode.js");

const BASE = "https://api.tronfy.com.br/v1";
const chave = () => process.env.TRONFY_API_KEY || "";
const ativo = () => chave().length > 10;

async function tronfy(metodo, caminho, corpo, extraHeaders = {}) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { "x-api-key": chave(), "Content-Type": "application/json", ...extraHeaders },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `Tronfy HTTP ${r.status}`);
    e.status = r.status; e.code = j.code;
    throw e;
  }
  return { http: r.status, ...j };
}

/**
 * Cria a cobrança. Devolve {id, status, copia_cola|null}. Se a Tronfy responder 202
 * (processando), consulta algumas vezes até o copia-e-cola aparecer.
 */
async function criarCobranca({ uid, numero, valorCentavos, cliente, cpf, cidade, expiracaoMin }) {
  const corpo = {
    amount: valorCentavos,
    description: `Pedido #${numero}`,
    external_id: `pedido_${uid}`,
    expiration_minutes: expiracaoMin,
    customer: {
      name: cliente.nome,
      document: cpf,
      phone: `${cliente.ddi || 55}${cliente.telefone}`,
      ...(cliente.email ? { email: cliente.email } : {}),
      ...(cidade ? { city: cidade.nome, state: cidade.uf } : {}),
    },
  };
  let c = await tronfy("POST", "/pix-charges", corpo, { "X-Idempotency-Key": `pedido_${uid}` });
  for (let i = 0; i < 4 && !(c.pix && c.pix.qr_code_text); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    c = await consultar(c.id);
  }
  return { id: c.id, status: c.status, copia_cola: (c.pix && c.pix.qr_code_text) || null };
}

const consultar = (id) => tronfy("GET", `/pix-charges/${encodeURIComponent(id)}`);

// status Tronfy -> nosso: pendente | pago | falhou
function traduzir(status) {
  if (status === "paid") return "pago";
  if (["declined", "failed", "cancelled", "canceled", "refunded"].includes(status)) return "falhou";
  return "pendente";
}

// QR Code do copia-e-cola como data URI SVG (o app exibe num <img>)
function qrDataUri(texto) {
  const q = qrcode(0, "M");
  q.addData(texto);
  q.make();
  const svg = q.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

module.exports = { ativo, criarCobranca, consultar, traduzir, qrDataUri };
