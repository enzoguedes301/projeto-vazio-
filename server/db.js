// Banco SQLite embutido do Node (node:sqlite, sem dependências externas).
// Arquivo: server/dados.sqlite — faça backup dele em produção.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const crypto = require("node:crypto");

const db = new DatabaseSync(path.join(__dirname, "dados.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;

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
    criado_em            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos (cliente_id);
  CREATE INDEX IF NOT EXISTS idx_pedidos_cidade  ON pedidos (cidade, criado_em);

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
`);

const agora = () => new Date().toISOString();

// Migrações simples: colunas novas em bancos já existentes
function garantirColuna(tabela, coluna, tipo) {
  const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
  if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
}
for (const [col, tipo] of [
  ["pix_id", "TEXT"], ["pix_copia_cola", "TEXT"], ["pix_expira_em", "TEXT"],
  ["pagamento_status", "TEXT"], ["pago_em", "TEXT"], ["pix_checado_em", "TEXT"],
]) garantirColuna("pedidos", col, tipo);

// ---------------------------------------------------------------- senha
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function confereSenha(senha, salvo) {
  if (!salvo) return false;
  const [salt, hash] = salvo.split(":");
  const calc = crypto.scryptSync(senha, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), calc);
}

// -------------------------------------------------------------- clientes
const clientes = {
  porTelefone: (ddi, telefone) =>
    db.prepare("SELECT * FROM clientes WHERE ddi = ? AND telefone = ?").get(String(ddi), String(telefone)),

  // o app ora manda o id numérico, ora o uuid
  porRef: (ref) =>
    /^\d+$/.test(String(ref))
      ? db.prepare("SELECT * FROM clientes WHERE id = ?").get(Number(ref))
      : db.prepare("SELECT * FROM clientes WHERE uuid = ?").get(String(ref)),

  porToken: (token) => (token ? db.prepare("SELECT * FROM clientes WHERE token = ?").get(token) : undefined),

  criar: ({ ddi, telefone, nome, email, nascimento, genero, senha }) => {
    const uuid = crypto.randomUUID();
    const r = db
      .prepare(
        `INSERT INTO clientes (uuid, ddi, telefone, nome, email, nascimento, genero, senha_hash, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uuid, String(ddi), String(telefone), nome || null, email || null, nascimento || null, genero || null,
           senha ? hashSenha(senha) : null, agora());
    return clientes.porRef(r.lastInsertRowid);
  },

  atualizar: (id, { nome, email, nascimento, genero, ddi, telefone }) => {
    db.prepare(
      `UPDATE clientes SET nome = COALESCE(?, nome), email = COALESCE(?, email), nascimento = COALESCE(?, nascimento),
       genero = COALESCE(?, genero), ddi = COALESCE(?, ddi), telefone = COALESCE(?, telefone) WHERE id = ?`
    ).run(nome ?? null, email ?? null, nascimento ?? null, genero ?? null, ddi ?? null, telefone ?? null, id);
    return clientes.porRef(id);
  },

  definirSenha: (id, senha) => db.prepare("UPDATE clientes SET senha_hash = ? WHERE id = ?").run(hashSenha(senha), id),

  novoToken: (id) => {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("UPDATE clientes SET token = ? WHERE id = ?").run(token, id);
    return token;
  },

  apagarToken: (id) => db.prepare("UPDATE clientes SET token = NULL WHERE id = ?").run(id),

  qtdPedidos: (id) => db.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE cliente_id = ?").get(id).n,
};

// --------------------------------------------------------------- pedidos
const pedidos = {
  proximoNumero: (cidade) =>
    db.prepare(
      `INSERT INTO contadores (cidade, numero) VALUES (?, 1)
       ON CONFLICT(cidade) DO UPDATE SET numero = numero + 1 RETURNING numero`
    ).get(cidade).numero,

  criar: ({ uid, numero, cidade, companyId, clienteId, payload, tempoEstimado }) => {
    numero = numero ?? pedidos.proximoNumero(cidade);
    uid = uid || crypto.randomUUID();
    const r = db
      .prepare(
        `INSERT INTO pedidos (uid, numero, cidade, company_id, cliente_id, payload, tempo_estimado, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uid, numero, cidade, companyId ?? null, clienteId, JSON.stringify(payload), tempoEstimado, agora());
    return pedidos.porRef(r.lastInsertRowid);
  },

  porRef: (ref) =>
    /^\d+$/.test(String(ref))
      ? db.prepare("SELECT * FROM pedidos WHERE id = ?").get(Number(ref))
      : db.prepare("SELECT * FROM pedidos WHERE uid = ?").get(String(ref)),

  doCliente: (clienteId) =>
    db.prepare("SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY id DESC").all(clienteId),

  todos: ({ cidade, desde } = {}) => {
    const cond = [], args = [];
    if (cidade) { cond.push("cidade = ?"); args.push(cidade); }
    if (desde) { cond.push("criado_em >= ?"); args.push(desde); }
    const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
    return db.prepare(`SELECT * FROM pedidos ${where} ORDER BY id DESC LIMIT 500`).all(...args);
  },

  definirStatusManual: (id, status, motivo) =>
    db.prepare("UPDATE pedidos SET status_manual = ?, status_manual_em = ?, motivo_cancelamento = ? WHERE id = ?")
      .run(status, agora(), motivo || null, id),

  // --- Pix
  definirPix: (id, { pixId, copiaCola, expiraEm, status }) =>
    db.prepare("UPDATE pedidos SET pix_id = ?, pix_copia_cola = ?, pix_expira_em = ?, pagamento_status = ?, pix_checado_em = ? WHERE id = ?")
      .run(pixId, copiaCola || null, expiraEm, status, agora(), id),
  atualizarPagamento: (id, { status, copiaCola }) =>
    db.prepare("UPDATE pedidos SET pagamento_status = ?, pix_copia_cola = COALESCE(?, pix_copia_cola), pix_checado_em = ? WHERE id = ?")
      .run(status, copiaCola || null, agora(), id),
  // idempotente: só marca uma vez
  marcarPago: (id) =>
    db.prepare("UPDATE pedidos SET pagamento_status = 'pago', pago_em = COALESCE(pago_em, ?), pix_checado_em = ? WHERE id = ?")
      .run(agora(), agora(), id),
  porPixId: (pixId) => db.prepare("SELECT * FROM pedidos WHERE pix_id = ?").get(String(pixId)),
};

// -------------------------------------------------------------- geocache
const geocache = {
  ler: (chave) => db.prepare("SELECT * FROM geocache WHERE chave = ?").get(chave),
  gravar: (chave, lat, lon, cidade) =>
    db.prepare("INSERT OR REPLACE INTO geocache (chave, lat, lon, cidade, criado_em) VALUES (?, ?, ?, ?, ?)")
      .run(chave, lat, lon, cidade || null, agora()),
};

// --------------------------------------------------------------- cidades
const cidadesDb = {
  porSlug: (slug) => db.prepare("SELECT * FROM cidades WHERE slug = ?").get(String(slug)),
  porId: (id) => db.prepare("SELECT * FROM cidades WHERE id = ?").get(Number(id)),
  todas: () => db.prepare("SELECT * FROM cidades ORDER BY nome").all(),
  salvar: ({ slug, nome, uf, lat, lon, rua, numero, bairro, cep }) => {
    db.prepare(
      `INSERT INTO cidades (slug, nome, uf, lat, lon, rua, numero, bairro, cep, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET nome = excluded.nome,
         lat = COALESCE(excluded.lat, lat), lon = COALESCE(excluded.lon, lon),
         rua = COALESCE(excluded.rua, rua), numero = COALESCE(excluded.numero, numero),
         bairro = COALESCE(excluded.bairro, bairro), cep = COALESCE(excluded.cep, cep)`
    ).run(slug, nome, uf, lat ?? null, lon ?? null, rua ?? null, numero ?? null, bairro ?? null, cep ?? null, agora());
    return cidadesDb.porSlug(slug);
  },
};

module.exports = { db, clientes, pedidos, geocache, cidadesDb, confereSenha };
