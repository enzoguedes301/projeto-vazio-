// Banco de dados via libSQL (SQLite):
//   - local:   arquivo server/dados.sqlite            (sem configurar nada)
//   - nuvem:   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  (Vercel/serverless não tem disco)
// Mesmo SQL nos dois casos. Todas as funções são assíncronas.
const { createClient } = require("@libsql/client");
const path = require("node:path");
const crypto = require("node:crypto");

const URL_BANCO = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, "dados.sqlite")}`;
const client = createClient({ url: URL_BANCO, authToken: process.env.TURSO_AUTH_TOKEN });
const local = URL_BANCO.startsWith("file:");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS clientes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT UNIQUE NOT NULL,
    ddi         TEXT NOT NULL,
    telefone    TEXT NOT NULL,
    nome        TEXT,
    email       TEXT,
    nascimento  TEXT,
    genero      TEXT,
    senha_hash  TEXT,
    token       TEXT,
    criado_em   TEXT NOT NULL,
    UNIQUE (ddi, telefone)
  );
  CREATE TABLE IF NOT EXISTS pedidos (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    uid                  TEXT UNIQUE NOT NULL,
    numero               INTEGER NOT NULL,
    cidade               TEXT NOT NULL,
    company_id           INTEGER,
    cliente_id           INTEGER NOT NULL,
    payload              TEXT NOT NULL,
    tempo_estimado       INTEGER NOT NULL,
    status_manual        TEXT,
    status_manual_em     TEXT,
    motivo_cancelamento  TEXT,
    pix_id               TEXT,
    pix_copia_cola       TEXT,
    pix_expira_em        TEXT,
    pagamento_status     TEXT,
    pago_em              TEXT,
    pix_checado_em       TEXT,
    criado_em            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos (cliente_id);
  CREATE INDEX IF NOT EXISTS idx_pedidos_cidade  ON pedidos (cidade, criado_em);
  CREATE INDEX IF NOT EXISTS idx_pedidos_pix     ON pedidos (pix_id);
  CREATE TABLE IF NOT EXISTS contadores (
    cidade  TEXT PRIMARY KEY,
    numero  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cidades (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT UNIQUE NOT NULL,
    nome       TEXT NOT NULL,
    uf         TEXT NOT NULL,
    lat        REAL,
    lon        REAL,
    rua        TEXT,
    numero     TEXT,
    bairro     TEXT,
    cep        TEXT,
    criado_em  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS geocache (
    chave      TEXT PRIMARY KEY,
    lat        REAL,
    lon        REAL,
    cidade     TEXT,
    criado_em  TEXT NOT NULL
  );
`;

let pronto = null;
function init() {
  if (!pronto) {
    pronto = (async () => {
      if (local) await client.execute("PRAGMA journal_mode = WAL").catch(() => {});
      await client.executeMultiple(SCHEMA);
    })();
  }
  return pronto;
}

// --------------------------------------------------------------- helpers
const linha = (r, row) => (row ? Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) : undefined);
async function get(sql, args = []) { await init(); const r = await client.execute({ sql, args }); return linha(r, r.rows[0]); }
async function all(sql, args = []) { await init(); const r = await client.execute({ sql, args }); return r.rows.map((row) => linha(r, row)); }
async function run(sql, args = []) {
  await init();
  const r = await client.execute({ sql, args });
  return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined };
}
const agora = () => new Date().toISOString();

// ---------------------------------------------------------------- senha
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(senha, salt, 64).toString("hex")}`;
}
function confereSenha(senha, salvo) {
  if (!salvo) return false;
  const [salt, hash] = salvo.split(":");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(senha, salt, 64));
}

// -------------------------------------------------------------- clientes
const clientes = {
  porTelefone: (ddi, telefone) => get("SELECT * FROM clientes WHERE ddi = ? AND telefone = ?", [String(ddi), String(telefone)]),

  // o app ora manda o id numérico, ora o uuid
  porRef: (ref) =>
    /^\d+$/.test(String(ref))
      ? get("SELECT * FROM clientes WHERE id = ?", [Number(ref)])
      : get("SELECT * FROM clientes WHERE uuid = ?", [String(ref)]),

  porToken: async (token) => (token ? get("SELECT * FROM clientes WHERE token = ?", [token]) : undefined),

  criar: async ({ ddi, telefone, nome, email, nascimento, genero, senha }) => {
    const uuid = crypto.randomUUID();
    const r = await run(
      `INSERT INTO clientes (uuid, ddi, telefone, nome, email, nascimento, genero, senha_hash, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, String(ddi), String(telefone), nome || null, email || null, nascimento || null, genero || null,
       senha ? hashSenha(senha) : null, agora()]
    );
    return clientes.porRef(r.lastInsertRowid);
  },

  atualizar: async (id, { nome, email, nascimento, genero, ddi, telefone }) => {
    await run(
      `UPDATE clientes SET nome = COALESCE(?, nome), email = COALESCE(?, email), nascimento = COALESCE(?, nascimento),
       genero = COALESCE(?, genero), ddi = COALESCE(?, ddi), telefone = COALESCE(?, telefone) WHERE id = ?`,
      [nome ?? null, email ?? null, nascimento ?? null, genero ?? null, ddi ?? null, telefone ?? null, id]
    );
    return clientes.porRef(id);
  },

  definirSenha: (id, senha) => run("UPDATE clientes SET senha_hash = ? WHERE id = ?", [hashSenha(senha), id]),

  novoToken: async (id) => {
    const token = crypto.randomBytes(32).toString("hex");
    await run("UPDATE clientes SET token = ? WHERE id = ?", [token, id]);
    return token;
  },

  apagarToken: (id) => run("UPDATE clientes SET token = NULL WHERE id = ?", [id]),

  qtdPedidos: async (id) => (await get("SELECT COUNT(*) AS n FROM pedidos WHERE cliente_id = ?", [id])).n,
};

// --------------------------------------------------------------- pedidos
const pedidos = {
  proximoNumero: async (cidade) =>
    (await get(
      `INSERT INTO contadores (cidade, numero) VALUES (?, 1)
       ON CONFLICT(cidade) DO UPDATE SET numero = numero + 1 RETURNING numero`, [cidade]
    )).numero,

  criar: async ({ uid, numero, cidade, companyId, clienteId, payload, tempoEstimado }) => {
    numero = numero ?? (await pedidos.proximoNumero(cidade));
    uid = uid || crypto.randomUUID();
    const r = await run(
      `INSERT INTO pedidos (uid, numero, cidade, company_id, cliente_id, payload, tempo_estimado, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, numero, cidade, companyId ?? null, clienteId, JSON.stringify(payload), tempoEstimado, agora()]
    );
    return pedidos.porRef(r.lastInsertRowid);
  },

  porRef: (ref) =>
    /^\d+$/.test(String(ref))
      ? get("SELECT * FROM pedidos WHERE id = ?", [Number(ref)])
      : get("SELECT * FROM pedidos WHERE uid = ?", [String(ref)]),

  doCliente: (clienteId) => all("SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY id DESC", [clienteId]),

  todos: ({ cidade, desde } = {}) => {
    const cond = [], args = [];
    if (cidade) { cond.push("cidade = ?"); args.push(cidade); }
    if (desde) { cond.push("criado_em >= ?"); args.push(desde); }
    const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
    return all(`SELECT * FROM pedidos ${where} ORDER BY id DESC LIMIT 500`, args);
  },

  definirStatusManual: (id, status, motivo) =>
    run("UPDATE pedidos SET status_manual = ?, status_manual_em = ?, motivo_cancelamento = ? WHERE id = ?",
        [status, agora(), motivo || null, id]),

  // --- Pix
  definirPix: (id, { pixId, copiaCola, expiraEm, status }) =>
    run("UPDATE pedidos SET pix_id = ?, pix_copia_cola = ?, pix_expira_em = ?, pagamento_status = ?, pix_checado_em = ? WHERE id = ?",
        [pixId, copiaCola || null, expiraEm, status, agora(), id]),
  atualizarPagamento: (id, { status, copiaCola }) =>
    run("UPDATE pedidos SET pagamento_status = ?, pix_copia_cola = COALESCE(?, pix_copia_cola), pix_checado_em = ? WHERE id = ?",
        [status, copiaCola || null, agora(), id]),
  // idempotente: só marca uma vez
  marcarPago: (id) =>
    run("UPDATE pedidos SET pagamento_status = 'pago', pago_em = COALESCE(pago_em, ?), pix_checado_em = ? WHERE id = ?",
        [agora(), agora(), id]),
  porPixId: (pixId) => get("SELECT * FROM pedidos WHERE pix_id = ?", [String(pixId)]),
};

// --------------------------------------------------------------- cidades
const cidadesDb = {
  porSlug: (slug) => get("SELECT * FROM cidades WHERE slug = ?", [String(slug)]),
  porId: (id) => get("SELECT * FROM cidades WHERE id = ?", [Number(id)]),
  todas: () => all("SELECT * FROM cidades ORDER BY nome"),
  salvar: async ({ slug, nome, uf, lat, lon, rua, numero, bairro, cep }) => {
    await run(
      `INSERT INTO cidades (slug, nome, uf, lat, lon, rua, numero, bairro, cep, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET nome = excluded.nome,
         lat = COALESCE(excluded.lat, lat), lon = COALESCE(excluded.lon, lon),
         rua = COALESCE(excluded.rua, rua), numero = COALESCE(excluded.numero, numero),
         bairro = COALESCE(excluded.bairro, bairro), cep = COALESCE(excluded.cep, cep)`,
      [slug, nome, uf, lat ?? null, lon ?? null, rua ?? null, numero ?? null, bairro ?? null, cep ?? null, agora()]
    );
    return cidadesDb.porSlug(slug);
  },
};

// -------------------------------------------------------------- geocache
const geocache = {
  ler: (chave) => get("SELECT * FROM geocache WHERE chave = ?", [chave]),
  gravar: (chave, lat, lon, cidade) =>
    run("INSERT OR REPLACE INTO geocache (chave, lat, lon, cidade, criado_em) VALUES (?, ?, ?, ?, ?)",
        [chave, lat, lon, cidade || null, agora()]),
};

module.exports = { init, clientes, pedidos, geocache, cidadesDb, confereSenha, local };
