// Servidor do cardápio: arquivos estáticos (SPA) + API de pedidos + painel.
//
//   node server/index.js          -> http://localhost:8090      (servidor próprio)
//   api/index.js                  -> mesma função, como serverless na Vercel
//
// Dependência única: @libsql/client (banco). Node >= 22.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const RAIZ = path.join(__dirname, "..");
const PUBLIC = path.join(RAIZ, "public");

// .env na raiz (não vai pro git): TRONFY_API_KEY, META_PIXEL_TOKEN, ADMIN_TOKEN, TURSO_* — variáveis da hospedagem têm prioridade
try {
  for (const linha of fs.readFileSync(path.join(RAIZ, ".env"), "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* sem .env */ }

const { clientes, pedidos, cidadesDb, confereSenha } = require("./db");
const { calcular } = require("./entrega");
const { serializar, ATIVOS, ehPixAuto } = require("./pedidos");
const Cidades = require("./cidades");
const Pix = require("./pix");
const Meta = require("./meta");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PORTA = Number(process.env.PORT) || cfg.porta;
const UA = cfg.geocoder.user_agent;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cfg.admin_token;
const log = (...a) => console.log(new Date().toLocaleTimeString("pt-BR"), ...a);

// --------------------------------------------------------------- cidades
// A cidade vem do lead (IP / URL / busca) e fica registrada no banco; o app
// manda o id dela no header Company-ID em toda chamada.
const comNomeEmpresa = (c) => c && { ...c, companyId: c.id, nome_empresa: Cidades.modelo().name };
async function cidadeDaRequisicao(req) {
  const id = Number(req.headers["company-id"]);
  return comNomeEmpresa((id && (await cidadesDb.porId(id))) || (await Cidades.padrao(UA)));
}

// --------------------------------------------------------------- helpers
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
function json(res, status, body, extra = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(data);
}
function erro(res, status, message) { json(res, status, { message }); }
function lerCorpo(req) {
  // na Vercel o corpo já vem analisado em req.body
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") { try { return Promise.resolve(req.body ? JSON.parse(req.body) : {}); } catch (e) { return Promise.reject(e); } }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 2e6) reject(new Error("corpo grande")); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function tokenDe(req) {
  const h = req.headers.authorization || "";
  return h.replace(/^Bearer\s+/i, "").trim() || null;
}
const clienteAutenticado = (req) => clientes.porToken(tokenDe(req));
async function serializarCliente(c, comToken) {
  if (!c) return null;
  const client = {
    id: c.id, uuid: c.uuid, name: c.nome, ddi: Number(c.ddi), telephone: c.telefone, email: c.email,
    birth_date: c.nascimento, gender: c.genero, have_password: !!c.senha_hash,
    orders_quantity: await clientes.qtdPedidos(c.id), loyalty_score: 0, cashback_balance: 0,
  };
  return comToken ? { access_token: `Bearer ${comToken}`, client } : { client };
}
async function pedidoSerializado(row) {
  return serializar(row, cfg, comNomeEmpresa(await cidadesDb.porSlug(row.cidade)));
}
const mapaAsync = (lista, fn) => Promise.all(lista.map(fn));
async function mesmoCliente(req, ref) {
  const c = await clienteAutenticado(req);
  if (!c) return null;
  const alvo = await clientes.porRef(ref);
  return alvo && alvo.id === c.id ? c : null;
}

// ------------------------------------------------------------------ rotas
const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, re: new RegExp("^" + padrao + "$"), fn });

// --- cidade do lead
//   GET /api/cidade              detecta pelo IP (ou padrão)
//   GET /api/cidade?slug=x-uf    resolve a cidade da URL (cai no IP se não existir)
//   GET /api/cidade?busca=texto  busca digitada no seletor
rota("GET", "/api/cidade", async (req, res, _, url) => {
  const q = url.searchParams;
  const { detectar_por_ip, cardapio } = Cidades.cfgCidades();
  let c = null, origem = "padrao";
  if (q.get("busca")) {
    const achada = await Cidades.buscarCidade(q.get("busca"), UA);
    if (!achada) return erro(res, 404, "Cidade não encontrada");
    c = await Cidades.registrar(achada, UA); origem = "busca";
  }
  if (!c && q.get("slug")) { c = await Cidades.resolverSlug(q.get("slug"), UA); if (c) origem = "url"; }
  if (!c && detectar_por_ip) { c = await Cidades.detectarPorIp(Cidades.ipDaRequisicao(req), UA); if (c) origem = "ip"; }
  if (!c) c = await Cidades.padrao(UA);
  json(res, 200, { id: c.id, slug: c.slug, nome: c.nome, uf: c.uf, lat: c.lat, lon: c.lon, origem, cardapio });
});
rota("GET", "/api/perfil/([a-z0-9-]+)\\.json", async (req, res, [slug]) => {
  const c = (await cidadesDb.porSlug(slug)) || (await Cidades.resolverSlug(slug, UA)) || (await Cidades.padrao(UA));
  json(res, 200, Cidades.perfil(c));
});

// --- taxa e tempo de entrega (CEP/endereço -> distância até o restaurante da cidade)
rota("POST", "/api/menu/company/orders/calculate_tax", async (req, res) => {
  const corpo = await lerCorpo(req);
  const cidade = await cidadeDaRequisicao(req);
  const r = await calcular(corpo.calculate_tax || {}, cidade, cfg);
  log(`taxa ${cidade.slug} cep=${corpo.calculate_tax?.zip_code || "-"} -> ${r.status} R$${r.value} ${r.distance}km ${r.estimated_time}min`);
  json(res, 200, r);
});

// --- clientes
rota("GET", "/api/menu/company/clients", async (req, res, _, url) => {
  const q = url.searchParams;
  let c = null;
  if (q.get("client_id")) c = await clientes.porRef(q.get("client_id"));
  else if (q.get("telephone")) c = await clientes.porTelefone(q.get("ddi") || "55", q.get("telephone"));
  if (!c) return json(res, 204);
  const token = tokenDe(req);
  json(res, 200, await serializarCliente(c, token && c.token === token ? token : null));
});

rota("POST", "/api/menu/company/clients", async (req, res) => {
  const b = await lerCorpo(req);
  const telefone = String(b.telephone || "").replace(/\D/g, "");
  if (!telefone) return erro(res, 422, "Informe um telefone válido");
  let c = await clientes.porTelefone(b.ddi || "55", telefone);
  if (!c) c = await clientes.criar({ ddi: b.ddi || "55", telefone, nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender, senha: b.password });
  else {
    await clientes.atualizar(c.id, { nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender });
    if (b.password) await clientes.definirSenha(c.id, b.password);
    c = await clientes.porRef(c.id);
  }
  const token = c.senha_hash ? await clientes.novoToken(c.id) : null;
  json(res, 200, await serializarCliente(await clientes.porRef(c.id), token));
});

rota("PUT", "/api/menu/company/clients/([^/]+)/first_register", async (req, res, [ref]) => {
  const c = await clientes.porRef(ref);
  if (!c) return erro(res, 404, "Cliente não encontrado");
  const b = await lerCorpo(req);
  if (!b.password) return erro(res, 422, "Informe uma senha");
  await clientes.atualizar(c.id, { nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender });
  await clientes.definirSenha(c.id, b.password);
  json(res, 200, await serializarCliente(await clientes.porRef(c.id), await clientes.novoToken(c.id)));
});

rota("PUT", "/api/menu/company/clients/([^/]+)/change_password", async (req, res, [ref]) => {
  const c = await mesmoCliente(req, ref);
  if (!c) return erro(res, 401, "Não autorizado");
  const b = await lerCorpo(req);
  const atual = b.current_password ?? b.old_password;
  if (atual !== undefined && !confereSenha(atual, c.senha_hash)) return erro(res, 422, "Senha atual incorreta");
  const nova = b.new_password ?? b.password;
  if (!nova) return erro(res, 422, "Informe a nova senha");
  await clientes.definirSenha(c.id, nova);
  json(res, 200, { access_token: `Bearer ${await clientes.novoToken(c.id)}` });
});

rota("PUT", "/api/menu/company/clients/([^/]+)", async (req, res, [ref]) => {
  const c = await mesmoCliente(req, ref);
  if (!c) return erro(res, 401, "Não autorizado");
  const b = await lerCorpo(req);
  const tel = b.telephone ? String(b.telephone).replace(/\D/g, "") : undefined;
  await clientes.atualizar(c.id, { nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender, ddi: b.ddi, telefone: tel });
  json(res, 200, await serializarCliente(await clientes.porRef(c.id), tokenDe(req)));
});

rota("POST", "/api/menu/authentication/client_session/login", async (req, res) => {
  const b = await lerCorpo(req);
  const c = b.auth && b.auth.client_id ? await clientes.porRef(b.auth.client_id) : null;
  if (!c || !confereSenha(String((b.auth && b.auth.password) || ""), c.senha_hash)) return erro(res, 401, "Senha inválida");
  json(res, 200, { access_token: `Bearer ${await clientes.novoToken(c.id)}` });
});
rota("PUT", "/api/menu/authentication/client_session/logout", async (req, res) => {
  const c = await clienteAutenticado(req);
  if (c) await clientes.apagarToken(c.id);
  json(res, 200, {});
});
rota("POST", "/api/menu/company/client/([^/]+)/send_password_recovery_code", (_, res) =>
  erro(res, 422, "Recuperação de senha indisponível. Fale com o estabelecimento."));
rota("POST", "/api/menu/company/client/([^/]+)/recover_password", (_, res) =>
  erro(res, 422, "Recuperação de senha indisponível. Fale com o estabelecimento."));

// --- pedidos
rota("POST", "/api/menu/company/orders/new_version", async (req, res) => {
  const c = await clienteAutenticado(req);
  if (!c) return erro(res, 401, "Identifique-se para finalizar o pedido");
  const b = await lerCorpo(req);
  if (!Array.isArray(b.order_items) || b.order_items.length === 0) return erro(res, 422, "Pedido sem itens");
  const cidade = await cidadeDaRequisicao(req);
  b.client_id = c.id;
  b.client = { name: c.nome, ddi: Number(c.ddi), telephone: c.telefone, ...(b.client || {}) };
  const tempo = Number(b.estimated_time) || cfg.linha_do_tempo_min.entregue_padrao;

  // Pix automático: gera a cobrança antes de gravar o pedido
  let pix = null;
  if (ehPixAuto(b)) {
    if (!Pix.ativo()) return erro(res, 422, "Pagamento por Pix indisponível no momento. Escolha outra forma de pagamento.");
    const cpf = String(b.invoice_document || "").replace(/\D/g, "");
    if (cpf.length !== 11 && cpf.length !== 14) return erro(res, 422, "Informe seu CPF para pagar com Pix");
    const centavos = Math.round(Number(b.final_value) * 100);
    if (!(centavos > 0)) return erro(res, 422, "Valor do pedido inválido");
    pix = { uid: crypto.randomUUID(), numero: await pedidos.proximoNumero(cidade.slug), centavos };
    try {
      pix.cobranca = await Pix.criarCobranca({ uid: pix.uid, numero: pix.numero, valorCentavos: centavos, cliente: c, cpf, cidade, expiracaoMin: cfg.pix.expiracao_min });
    } catch (e) {
      log(`PIX erro: ${e.message}`);
      return erro(res, 502, "Não foi possível gerar o Pix agora. Tente novamente ou escolha outra forma de pagamento.");
    }
  }

  const row = await pedidos.criar({ uid: pix?.uid, numero: pix?.numero, cidade: cidade.slug, companyId: cidade.companyId, clienteId: c.id, payload: b, tempoEstimado: tempo });
  if (pix) {
    const expira = new Date(Date.now() + cfg.pix.expiracao_min * 60_000).toISOString();
    await pedidos.definirPix(row.id, { pixId: pix.cobranca.id, copiaCola: pix.cobranca.copia_cola, expiraEm: expira, status: Pix.traduzir(pix.cobranca.status) });
    log(`PEDIDO #${row.numero} ${cidade.slug} ${c.nome} R$${b.final_value} — PIX ${pix.cobranca.id} ${pix.cobranca.copia_cola ? "ok" : "sem copia-e-cola ainda"}`);
  } else {
    log(`PEDIDO #${row.numero} ${cidade.slug} ${c.nome} R$${b.final_value} (${tempo} min)`);
  }
  json(res, 200, { id: row.id, uid: row.uid, order_number: row.numero });
});

// Reconcilia um pedido Pix pendente com o provedor (no máximo a cada 8 s por pedido).
// Rede de segurança pra quando o webhook não chega.
async function sincronizarPix(row) {
  if (!row.pix_id || row.pago_em || row.pagamento_status === "falhou") return row;
  if (row.pix_checado_em && Date.now() - new Date(row.pix_checado_em) < 8000) return row;
  if (row.pix_expira_em && new Date(row.pix_expira_em) < Date.now() - 3600_000) return row; // expirado há mais de 1 h: desiste
  try {
    const c = await Pix.consultar(row.pix_id);
    const st = Pix.traduzir(c.status);
    if (st === "pago") { await pedidos.marcarPago(row.id); log(`PIX PAGO pedido #${row.numero}`); }
    else await pedidos.atualizarPagamento(row.id, { status: st, copiaCola: c.pix && c.pix.qr_code_text });
  } catch {
    await pedidos.atualizarPagamento(row.id, { status: row.pagamento_status || "pendente" });
  }
  return pedidos.porRef(row.id);
}

rota("GET", "/api/menu/company/orders/([^/]+)", async (req, res, [ref]) => {
  let row = await pedidos.porRef(ref);
  if (!row) return erro(res, 404, "Pedido não encontrado");
  row = await sincronizarPix(row);
  json(res, 200, await pedidoSerializado(row));
});

// Webhook do provedor Pix: confirma pela consulta autenticada antes de marcar pago
rota("POST", "/webhooks/tronfy", async (req, res) => {
  const b = await lerCorpo(req).catch(() => ({}));
  const id = b && b.data && b.data.id;
  if (!["transaction.approved", "transaction.updated"].includes(b.event) || !id) return json(res, 200, {});
  const row = await pedidos.porPixId(id);
  if (!row) return json(res, 404, {});
  try {
    const c = await Pix.consultar(id);
    const centavos = Math.round(Number(JSON.parse(row.payload).final_value) * 100);
    if (c.method === "pix" && c.amount === centavos && c.status === "paid") { await pedidos.marcarPago(row.id); log(`PIX PAGO (webhook) pedido #${row.numero}`); }
    else await pedidos.atualizarPagamento(row.id, { status: Pix.traduzir(c.status) });
    json(res, 200, {});
  } catch { json(res, 503, {}); }
});

rota("GET", "/api/menu/company/orders/([^/]+)/satisfaction_survey", (_, res) => json(res, 204));
rota("POST", "/api/menu/company/orders/([^/]+)/satisfaction_survey", (_, res) => json(res, 200, {}));
rota("GET", "/api/menu/company/orders/([^/]+)/prefilled_order", (_, res) => json(res, 204));
rota("GET", "/api/menu/company/satisfaction_survey_questions", (_, res) => json(res, 200, []));

rota("GET", "/api/menu/company/client/([^/]+)/pending_orders", async (req, res, [ref]) => {
  const c = await clientes.porRef(ref);
  if (!c) return json(res, 200, []);
  const lista = await mapaAsync(await pedidos.doCliente(c.id), pedidoSerializado);
  json(res, 200, lista.filter((o) => ATIVOS(o.status)));
});
rota("GET", "/api/menu/company/client/([^/]+)/closed_orders", async (req, res, [ref], url) => {
  const c = await mesmoCliente(req, ref);
  if (!c) return json(res, 200, []);
  const limit = Number(url.searchParams.get("limit")) || 6;
  const cursor = Number(url.searchParams.get("cursor")) || null;
  let lista = (await mapaAsync(await pedidos.doCliente(c.id), pedidoSerializado)).filter((o) => !ATIVOS(o.status));
  if (cursor) lista = lista.filter((o) => o.id < cursor);
  json(res, 200, lista.slice(0, limit));
});
rota("GET", "/api/menu/company/client/([^/]+)/summary", async (req, res, [ref]) => {
  const c = await clientes.porRef(ref);
  json(res, 200, { orders_quantity: c ? await clientes.qtdPedidos(c.id) : 0, loyalty_score: 0, cashback_balance: 0 });
});
rota("GET", "/api/menu/company/client/([^/]+)/loyalty_program_operations", (_, res) => json(res, 200, []));

// --- Meta Conversions API: o app manda cada evento do Pixel também pro servidor
rota("POST", "/api/menu/company/track_event", async (req, res) => {
  if (!Meta.ativo()) return json(res, 204);
  try {
    const ev = await lerCorpo(req);
    const cliente = (await clienteAutenticado(req)) || (ev.client_id ? await clientes.porRef(ev.client_id) : null);
    const r = await Meta.enviar(cfg.meta.pixel_id, ev, { ip: Cidades.ipDaRequisicao(req), userAgent: req.headers["user-agent"], cliente });
    if (!r.ok && r.motivo !== "inativo") log(`META ${ev.event_name}: ${r.motivo}`);
  } catch (e) { log(`META erro: ${e.message}`); }
  json(res, 204);
});

// --- ruído que o app manda e não precisa de resposta real
rota("POST", "/api/menu/client/push_notification_token", (_, res) => json(res, 204));
rota("POST", "/api/menu/client/verify_number/send_sms_token", (_, res) => erro(res, 422, "Verificação por SMS indisponível"));
rota("POST", "/api/menu/company/coupons/verify", (_, res) => erro(res, 404, "Cupom inválido"));

// --- painel (server/admin.html) — protegido por ADMIN_TOKEN / admin_token do config.json
function admin(req, res) {
  const t = tokenDe(req);
  if (t !== ADMIN_TOKEN) { erro(res, 401, "Token inválido"); return false; }
  return true;
}
rota("GET", "/admin", (_, res) => {
  res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
  res.end(fs.readFileSync(path.join(__dirname, "admin.html")));
});
rota("GET", "/admin/api/pedidos", async (req, res, _, url) => {
  if (!admin(req, res)) return;
  const desde = new Date(Date.now() - 36 * 3600_000).toISOString();
  const lista = await mapaAsync(await pedidos.todos({ cidade: url.searchParams.get("cidade") || undefined, desde }), pedidoSerializado);
  const todasCidades = (await cidadesDb.todas()).map((c) => ({ slug: c.slug, nome: c.nome, uf: c.uf }));
  json(res, 200, { pedidos: lista, cidades: todasCidades, agora: new Date().toISOString() });
});
rota("POST", "/admin/api/pedidos/(\\d+)/(cancelar|entregar|concluir)", async (req, res, [id, acao]) => {
  if (!admin(req, res)) return;
  const row = await pedidos.porRef(id);
  if (!row) return erro(res, 404, "Pedido não encontrado");
  const b = await lerCorpo(req);
  const status = { cancelar: "canceled", entregar: "delivered", concluir: "closed" }[acao];
  await pedidos.definirStatusManual(row.id, status, b.motivo);
  json(res, 200, await pedidoSerializado(await pedidos.porRef(row.id)));
});

// --------------------------------------------------------------- estático
// (no servidor próprio; na Vercel o public/ é servido pela plataforma)
function estatico(req, res, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let alvo = path.join(PUBLIC, "index.html");
  if (rel) {
    const cand = path.resolve(PUBLIC, rel);
    if (cand.startsWith(PUBLIC + path.sep) && fs.existsSync(cand) && fs.statSync(cand).isFile()) alvo = cand;
  }
  const ext = path.extname(alvo).toLowerCase();
  const imutavel = /^(assets|img|fonts)\//.test(rel) && alvo !== path.join(PUBLIC, "index.html");
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": imutavel ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(alvo).pipe(res);
}

// --------------------------------------------------------------- handler
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      await r.fn(req, res, m.slice(1), url);
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/webhooks/")) return erro(res, 404, "Rota não encontrada");
    estatico(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) erro(res, 500, "Erro interno");
  }
}

module.exports = handler;
module.exports.handler = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORTA, async () => {
    log(`Cardápio em http://localhost:${PORTA}   painel: http://localhost:${PORTA}/admin`);
    log(`Banco: ${process.env.TURSO_DATABASE_URL ? "Turso (nuvem)" : "arquivo local server/dados.sqlite"}`);
    log(`Pix automático: ${Pix.ativo() ? "ATIVO" : "desligado — defina TRONFY_API_KEY no .env"}`);
    log(`Meta Conversions API: ${Meta.ativo() ? `ATIVA (pixel ${cfg.meta.pixel_id})` : "desligada — defina META_PIXEL_TOKEN no .env"}`);
    const p = await Cidades.padrao(UA);
    log(`Cidade padrão: ${p.nome} - ${p.uf} (${p.rua}, ${p.numero}, ${p.bairro}) · cidades conhecidas: ${(await cidadesDb.todas()).length}`);
  });
}
