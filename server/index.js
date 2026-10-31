// Servidor do cardápio: arquivos estáticos (SPA) + API de pedidos + painel.
//
//   node server/index.js          -> http://localhost:8090
//   PORT=3000 node server/index.js
//
// Sem dependências: Node >= 22.13 (fetch e node:sqlite embutidos).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const RAIZ = path.join(__dirname, "..");

// .env na raiz (não vai pro git): TRONFY_API_KEY, ADMIN_TOKEN... — variáveis da hospedagem têm prioridade
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

// --------------------------------------------------------------- cidades
// A cidade vem do lead (IP / URL / busca) e fica registrada no SQLite; o app
// manda o id dela no header Company-ID em toda chamada.
const comNomeEmpresa = (c) => c && { ...c, companyId: c.id, nome_empresa: Cidades.modelo().name };
async function cidadeDaRequisicao(req) {
  const id = Number(req.headers["company-id"]);
  return comNomeEmpresa(cidadesDb.porId(id) || (await Cidades.padrao(UA)));
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
function clienteAutenticado(req) { return clientes.porToken(tokenDe(req)); }
function serializarCliente(c, comToken) {
  if (!c) return null;
  const client = {
    id: c.id, uuid: c.uuid, name: c.nome, ddi: Number(c.ddi), telephone: c.telefone, email: c.email,
    birth_date: c.nascimento, gender: c.genero, have_password: !!c.senha_hash,
    orders_quantity: clientes.qtdPedidos(c.id), loyalty_score: 0, cashback_balance: 0,
  };
  return comToken ? { access_token: `Bearer ${comToken}`, client } : { client };
}
function pedidoSerializado(row) {
  return serializar(row, cfg, comNomeEmpresa(cidadesDb.porSlug(row.cidade)));
}
const log = (...a) => console.log(new Date().toLocaleTimeString("pt-BR"), ...a);

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
  const c = cidadesDb.porSlug(slug) || (await Cidades.resolverSlug(slug, UA)) || (await Cidades.padrao(UA));
  json(res, 200, Cidades.perfil(c));
});

// --- taxa e tempo de entrega (CEP/endereço -> distância até a cidade)
rota("POST", "/api/menu/company/orders/calculate_tax", async (req, res) => {
  const corpo = await lerCorpo(req);
  const cidade = await cidadeDaRequisicao(req);
  const r = await calcular(corpo.calculate_tax || {}, cidade, cfg);
  log(`taxa ${cidade.slug} cep=${corpo.calculate_tax?.zip_code || "-"} -> ${r.status} R$${r.value} ${r.distance}km ${r.estimated_time}min`);
  json(res, 200, r);
});

// --- clientes
rota("GET", "/api/menu/company/clients", (req, res, _, url) => {
  const q = url.searchParams;
  let c = null;
  if (q.get("client_id")) c = clientes.porRef(q.get("client_id"));
  else if (q.get("telephone")) c = clientes.porTelefone(q.get("ddi") || "55", q.get("telephone"));
  if (!c) return json(res, 204);
  const token = tokenDe(req);
  const autenticado = token && c.token === token;
  json(res, 200, serializarCliente(c, autenticado ? token : null));
});

rota("POST", "/api/menu/company/clients", async (req, res) => {
  const b = await lerCorpo(req);
  const telefone = String(b.telephone || "").replace(/\D/g, "");
  if (!telefone) return erro(res, 422, "Informe um telefone válido");
  let c = clientes.porTelefone(b.ddi || "55", telefone);
  if (!c) c = clientes.criar({ ddi: b.ddi || "55", telefone, nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender, senha: b.password });
  else {
    clientes.atualizar(c.id, { nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender });
    if (b.password) clientes.definirSenha(c.id, b.password);
    c = clientes.porRef(c.id);
  }
  const token = c.senha_hash ? clientes.novoToken(c.id) : null;
  json(res, 200, serializarCliente(clientes.porRef(c.id), token));
});

rota("PUT", "/api/menu/company/clients/([^/]+)/first_register", async (req, res, [ref]) => {
  const c = clientes.porRef(ref);
  if (!c) return erro(res, 404, "Cliente não encontrado");
  const b = await lerCorpo(req);
  if (!b.password) return erro(res, 422, "Informe uma senha");
  clientes.atualizar(c.id, { nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender });
  clientes.definirSenha(c.id, b.password);
  json(res, 200, serializarCliente(clientes.porRef(c.id), clientes.novoToken(c.id)));
});

rota("PUT", "/api/menu/company/clients/([^/]+)/change_password", async (req, res, [ref]) => {
  const c = clienteAutenticado(req);
  if (!c || String(c.id) !== String(clientes.porRef(ref)?.id)) return erro(res, 401, "Não autorizado");
  const b = await lerCorpo(req);
  const atual = b.current_password ?? b.old_password;
  if (atual !== undefined && !confereSenha(atual, c.senha_hash)) return erro(res, 422, "Senha atual incorreta");
  const nova = b.new_password ?? b.password;
  if (!nova) return erro(res, 422, "Informe a nova senha");
  clientes.definirSenha(c.id, nova);
  json(res, 200, { access_token: `Bearer ${clientes.novoToken(c.id)}` });
});

rota("PUT", "/api/menu/company/clients/([^/]+)", async (req, res, [ref]) => {
  const c = clienteAutenticado(req);
  if (!c || String(c.id) !== String(clientes.porRef(ref)?.id)) return erro(res, 401, "Não autorizado");
  const b = await lerCorpo(req);
  const tel = b.telephone ? String(b.telephone).replace(/\D/g, "") : undefined;
  clientes.atualizar(c.id, { nome: b.name, email: b.email, nascimento: b.birth_date, genero: b.gender, ddi: b.ddi, telefone: tel });
  json(res, 200, serializarCliente(clientes.porRef(c.id), tokenDe(req)));
});

rota("POST", "/api/menu/authentication/client_session/login", async (req, res) => {
  const b = await lerCorpo(req);
  const c = clientes.porRef(b.auth?.client_id);
  if (!c || !confereSenha(String(b.auth?.password || ""), c.senha_hash)) return erro(res, 401, "Senha inválida");
  json(res, 200, { access_token: `Bearer ${clientes.novoToken(c.id)}` });
});
rota("PUT", "/api/menu/authentication/client_session/logout", (req, res) => {
  const c = clienteAutenticado(req);
  if (c) clientes.apagarToken(c.id);
  json(res, 200, {});
});
rota("POST", "/api/menu/company/client/([^/]+)/send_password_recovery_code", (_, res) =>
  erro(res, 422, "Recuperação de senha indisponível. Fale com o estabelecimento."));
rota("POST", "/api/menu/company/client/([^/]+)/recover_password", (_, res) =>
  erro(res, 422, "Recuperação de senha indisponível. Fale com o estabelecimento."));

// --- pedidos
rota("POST", "/api/menu/company/orders/new_version", async (req, res) => {
  const c = clienteAutenticado(req);
  if (!c) return erro(res, 401, "Identifique-se para finalizar o pedido");
  const b = await lerCorpo(req);
  if (!Array.isArray(b.order_items) || b.order_items.length === 0) return erro(res, 422, "Pedido sem itens");
  const cidade = await cidadeDaRequisicao(req);
  b.client_id = c.id;
  b.client = { name: c.nome, ddi: Number(c.ddi), telephone: c.telefone, ...(b.client || {}) };
  const tempo = Number(b.estimated_time) || cfg.linha_do_tempo_min.entregue_padrao;

  // Pix automático: gera a cobrança na Tronfy antes de gravar o pedido
  let pix = null;
  if (ehPixAuto(b)) {
    if (!Pix.ativo()) return erro(res, 422, "Pagamento por Pix indisponível no momento. Escolha outra forma de pagamento.");
    const cpf = String(b.invoice_document || "").replace(/\D/g, "");
    if (cpf.length !== 11 && cpf.length !== 14) return erro(res, 422, "Informe seu CPF para pagar com Pix");
    const centavos = Math.round(Number(b.final_value) * 100);
    if (!(centavos > 0)) return erro(res, 422, "Valor do pedido inválido");
    pix = { uid: require("node:crypto").randomUUID(), numero: pedidos.proximoNumero(cidade.slug), centavos };
    try {
      pix.cobranca = await Pix.criarCobranca({ uid: pix.uid, numero: pix.numero, valorCentavos: centavos, cliente: c, cpf, cidade, expiracaoMin: cfg.pix.expiracao_min });
    } catch (e) {
      log(`PIX erro: ${e.message}`);
      return erro(res, 502, "Não foi possível gerar o Pix agora. Tente novamente ou escolha outra forma de pagamento.");
    }
  }

  const row = pedidos.criar({ uid: pix?.uid, numero: pix?.numero, cidade: cidade.slug, companyId: cidade.companyId, clienteId: c.id, payload: b, tempoEstimado: tempo });
  if (pix) {
    const expira = new Date(Date.now() + cfg.pix.expiracao_min * 60_000).toISOString();
    pedidos.definirPix(row.id, { pixId: pix.cobranca.id, copiaCola: pix.cobranca.copia_cola, expiraEm: expira, status: Pix.traduzir(pix.cobranca.status) });
    log(`PEDIDO #${row.numero} ${cidade.slug} ${c.nome} R$${b.final_value} — PIX ${pix.cobranca.id} ${pix.cobranca.copia_cola ? "ok" : "sem copia-e-cola ainda"}`);
  } else {
    log(`PEDIDO #${row.numero} ${cidade.slug} ${c.nome} R$${b.final_value} (${tempo} min)`);
  }
  json(res, 200, { id: row.id, uid: row.uid, order_number: row.numero });
});

// Reconcilia um pedido Pix pendente com a Tronfy (no máximo a cada 8 s por pedido).
// Serve de rede de segurança quando o webhook não chega (ex.: localhost).
async function sincronizarPix(row) {
  if (!row.pix_id || row.pago_em || row.pagamento_status === "falhou") return row;
  if (row.pix_checado_em && Date.now() - new Date(row.pix_checado_em) < 8000) return row;
  if (row.pix_expira_em && new Date(row.pix_expira_em) < Date.now() - 3600_000) return row; // expirado há mais de 1 h: desiste
  try {
    const c = await Pix.consultar(row.pix_id);
    const st = Pix.traduzir(c.status);
    if (st === "pago") { pedidos.marcarPago(row.id); log(`PIX PAGO pedido #${row.numero}`); }
    else pedidos.atualizarPagamento(row.id, { status: st, copiaCola: c.pix && c.pix.qr_code_text });
  } catch (e) {
    pedidos.atualizarPagamento(row.id, { status: row.pagamento_status || "pendente" });
  }
  return pedidos.porRef(row.id);
}

rota("GET", "/api/menu/company/orders/([^/]+)", async (req, res, [ref]) => {
  let row = pedidos.porRef(ref);
  if (!row) return erro(res, 404, "Pedido não encontrado");
  row = await sincronizarPix(row);
  json(res, 200, pedidoSerializado(row));
});

// Webhook da Tronfy (Integrações -> Webhooks, categoria Transações): confirma pela consulta autenticada
rota("POST", "/webhooks/tronfy", async (req, res) => {
  const b = await lerCorpo(req).catch(() => ({}));
  const id = b && b.data && b.data.id;
  if (!["transaction.approved", "transaction.updated"].includes(b.event) || !id) return json(res, 200, {});
  const row = pedidos.porPixId(id);
  if (!row) return json(res, 404, {});
  try {
    const c = await Pix.consultar(id);
    const centavos = Math.round(Number(JSON.parse(row.payload).final_value) * 100);
    if (c.method === "pix" && c.amount === centavos && c.status === "paid") { pedidos.marcarPago(row.id); log(`PIX PAGO (webhook) pedido #${row.numero}`); }
    else pedidos.atualizarPagamento(row.id, { status: Pix.traduzir(c.status) });
    json(res, 200, {});
  } catch { json(res, 503, {}); }
});
rota("GET", "/api/menu/company/orders/([^/]+)/satisfaction_survey", (_, res) => json(res, 204));
rota("POST", "/api/menu/company/orders/([^/]+)/satisfaction_survey", (_, res) => json(res, 200, {}));
rota("GET", "/api/menu/company/orders/([^/]+)/prefilled_order", (_, res) => json(res, 204));
rota("GET", "/api/menu/company/satisfaction_survey_questions", (_, res) => json(res, 200, []));

rota("GET", "/api/menu/company/client/([^/]+)/pending_orders", (req, res, [ref]) => {
  const c = clientes.porRef(ref);
  if (!c) return json(res, 200, []);
  json(res, 200, pedidos.doCliente(c.id).map(pedidoSerializado).filter((o) => ATIVOS(o.status)));
});
rota("GET", "/api/menu/company/client/([^/]+)/closed_orders", (req, res, [ref], url) => {
  const c = clienteAutenticado(req);
  if (!c || String(c.id) !== String(clientes.porRef(ref)?.id)) return json(res, 200, []);
  const limit = Number(url.searchParams.get("limit")) || 6;
  const cursor = Number(url.searchParams.get("cursor")) || null;
  let lista = pedidos.doCliente(c.id).map(pedidoSerializado).filter((o) => !ATIVOS(o.status));
  if (cursor) lista = lista.filter((o) => o.id < cursor);
  json(res, 200, lista.slice(0, limit));
});
rota("GET", "/api/menu/company/client/([^/]+)/summary", (req, res, [ref]) => {
  const c = clientes.porRef(ref);
  json(res, 200, { orders_quantity: c ? clientes.qtdPedidos(c.id) : 0, loyalty_score: 0, cashback_balance: 0 });
});
rota("GET", "/api/menu/company/client/([^/]+)/loyalty_program_operations", (_, res) => json(res, 200, []));

// --- Meta Conversions API: o app manda cada evento do Pixel também pro servidor
rota("POST", "/api/menu/company/track_event", async (req, res) => {
  json(res, 204); // responde já; o envio pra Meta não segura o app
  if (!Meta.ativo()) return;
  try {
    const ev = await lerCorpo(req);
    const cliente = clienteAutenticado(req) || (ev.client_id ? clientes.porRef(ev.client_id) : null);
    const r = await Meta.enviar(cfg.meta.pixel_id, ev, { ip: Cidades.ipDaRequisicao(req), userAgent: req.headers["user-agent"], cliente });
    if (!r.ok && r.motivo !== "inativo") log(`META ${ev.event_name}: ${r.motivo}`);
  } catch (e) { log(`META erro: ${e.message}`); }
});

// --- ruído que o app manda e não precisa de resposta real
rota("POST", "/api/menu/client/push_notification_token", (_, res) => json(res, 204));
rota("POST", "/api/menu/client/verify_number/send_sms_token", (_, res) => erro(res, 422, "Verificação por SMS indisponível"));
rota("POST", "/api/menu/company/coupons/verify", (_, res) => erro(res, 404, "Cupom inválido"));

// --- painel (server/admin.html) — protegido por admin_token do config.json
function admin(req, res) {
  const t = tokenDe(req);
  if (t !== ADMIN_TOKEN) { erro(res, 401, "Token inválido"); return false; }
  return true;
}
rota("GET", "/admin", (_, res) => {
  res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
  res.end(fs.readFileSync(path.join(__dirname, "admin.html")));
});
rota("GET", "/admin/api/pedidos", (req, res, _, url) => {
  if (!admin(req, res)) return;
  const desde = new Date(Date.now() - 36 * 3600_000).toISOString();
  const lista = pedidos.todos({ cidade: url.searchParams.get("cidade") || undefined, desde }).map(pedidoSerializado);
  const todasCidades = cidadesDb.todas().map((c) => ({ slug: c.slug, nome: c.nome, uf: c.uf }));
  json(res, 200, { pedidos: lista, cidades: todasCidades, agora: new Date().toISOString() });
});
rota("POST", "/admin/api/pedidos/(\\d+)/(cancelar|entregar|concluir)", async (req, res, [id, acao]) => {
  if (!admin(req, res)) return;
  const row = pedidos.porRef(id);
  if (!row) return erro(res, 404, "Pedido não encontrado");
  const b = await lerCorpo(req);
  const status = { cancelar: "canceled", entregar: "delivered", concluir: "closed" }[acao];
  pedidos.definirStatusManual(row.id, status, b.motivo);
  json(res, 200, pedidoSerializado(pedidos.porRef(row.id)));
});

// --------------------------------------------------------------- estático
const PUBLICOS = new Set(["index.html", "manifest.json", "cidades.js", "assets", "img", "dados", "fonts"]);
function estatico(req, res, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const primeiro = rel.split("/")[0];
  let alvo = path.join(RAIZ, "index.html");
  if (rel && PUBLICOS.has(primeiro)) {
    const cand = path.resolve(RAIZ, rel);
    if (cand.startsWith(RAIZ + path.sep) && fs.existsSync(cand) && fs.statSync(cand).isFile()) alvo = cand;
    else if (primeiro !== "index.html") return erro(res, 404, "Arquivo não encontrado");
  }
  const ext = path.extname(alvo).toLowerCase();
  const imutavel = ["assets", "img", "fonts"].includes(primeiro) && alvo !== path.join(RAIZ, "index.html");
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": imutavel ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(alvo).pipe(res);
}

// --------------------------------------------------------------- servidor
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      for (const r of rotas) {
        if (r.metodo !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        await r.fn(req, res, m.slice(1), url);
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin/")) return erro(res, 404, "Rota não encontrada");
      estatico(req, res, url);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) erro(res, 500, "Erro interno");
    }
  })
  .listen(PORTA, async () => {
    log(`Cardápio em http://localhost:${PORTA}   painel: http://localhost:${PORTA}/admin`);
    log(`Pix automático (Tronfy): ${Pix.ativo() ? "ATIVO" : "desligado — defina TRONFY_API_KEY no .env"}`);
    log(`Meta Conversions API: ${Meta.ativo() ? `ATIVA (pixel ${cfg.meta.pixel_id})` : "desligada — defina META_PIXEL_TOKEN no .env"}`);
    const p = await Cidades.padrao(UA);
    log(`Cidade padrão: ${p.nome} - ${p.uf} (${p.rua}, ${p.numero}, ${p.bairro}) · cidades conhecidas: ${cidadesDb.todas().length}`);
  });
