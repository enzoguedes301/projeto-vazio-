// Linha do tempo automática do pedido e serialização no formato que o app espera.
//
// Status (nomes que o front conhece):
//   pending_online_payment (Pix ainda não pago) -> created -> confirmed -> ready -> released -> delivered -> closed
// Rótulos no app: "Aguardando pagamento" / "Pedido em produção" / "Aguardando retirada pelo motorista"
//                 / "Entrega em andamento" / "Pedido entregue"
//
// As etapas avançam sozinhas pelo relógio (config.json -> linha_do_tempo_min) a partir do
// momento em que o pedido "entra": criação (dinheiro/cartão) ou confirmação do Pix (pago_em).
// "Entrega em andamento" fica aberta até o painel marcar ENTREGUE (entregue_automatico: false).
// Nada roda em segundo plano: a cada consulta o status é recalculado.

const { qrDataUri } = require("./pix");

const ehPixAuto = (p) => (p.payment_values_attributes || []).some((v) => v.payment_method === "pix_auto");

function linhaDoTempo(row, cfg, p) {
  const t = cfg.linha_do_tempo_min;
  const criado = new Date(row.criado_em).getTime();
  const etapas = [{ status: "created", em: new Date(criado) }];

  let inicio = criado;
  if (ehPixAuto(p)) {
    if (!row.pago_em) return etapas; // ainda aguardando pagamento
    inicio = new Date(row.pago_em).getTime();
    etapas.push({ status: "waiting_confirmation", em: new Date(inicio) });
  }
  const min = (m) => new Date(inicio + m * 60_000);
  etapas.push(
    { status: "confirmed", em: new Date(inicio + t.confirmed * 60_000 + 1000) },
    { status: "ready",     em: min(t.ready) },
    { status: "released",  em: min(t.released) },
  );
  if (t.entregue_automatico) {
    const entrega = Math.max(row.tempo_estimado || t.entregue_padrao, t.released + 5);
    etapas.push({ status: "delivered", em: min(entrega) });
    etapas.push({ status: "closed", em: min(entrega + t.closed_apos_entrega) });
  }
  return etapas;
}

// Pix: pendente, pago, expirado (abandonado) ou recusado
function situacaoPix(row, p, agora) {
  if (!ehPixAuto(p)) return null;
  if (row.pago_em) return "pago";
  if (row.pagamento_status === "falhou") return "falhou";
  if (row.pix_expira_em && new Date(row.pix_expira_em) <= agora) return "expirado";
  return "pendente";
}

function etapasAtuais(row, cfg, agora = new Date()) {
  const p = JSON.parse(row.payload);
  let etapas = linhaDoTempo(row, cfg, p).filter((e) => e.em <= agora);

  const pix = situacaoPix(row, p, agora);
  if (pix === "pendente") etapas = [{ status: "pending_online_payment", em: new Date(row.criado_em) }];
  if (pix === "expirado" || pix === "falhou") {
    const quando = pix === "expirado" ? new Date(row.pix_expira_em) : new Date(row.pix_checado_em || row.criado_em);
    return { etapas: [etapas[0], { status: "canceled", em: quando }], pix,
             motivo: pix === "expirado" ? "Pagamento Pix não realizado no prazo" : "Pagamento Pix recusado" };
  }

  if (row.status_manual) {
    const quando = new Date(row.status_manual_em);
    etapas = etapas.filter((e) => e.em < quando && !["delivered", "closed"].includes(e.status));
    etapas.push({ status: row.status_manual, em: quando });
    if (row.status_manual === "delivered") {
      const fecha = new Date(quando.getTime() + cfg.linha_do_tempo_min.closed_apos_entrega * 60_000);
      if (fecha <= agora) etapas.push({ status: "closed", em: fecha });
    }
  }
  return { etapas, pix, motivo: row.motivo_cancelamento || null };
}

const ATIVOS = (status) => !["closed", "canceled"].includes(status);

function valoresDePagamento(row, p, pix) {
  return (p.payment_values_attributes || []).map((v) => {
    if (v.payment_method !== "pix_auto") return { status: "pending", ...v };
    const seg = row.pix_expira_em ? Math.max(1, Math.round((new Date(row.pix_expira_em) - new Date(row.criado_em)) / 1000)) : null;
    return {
      ...v,
      status: pix === "pago" ? "paid" : pix === "pendente" ? "pending" : "abandoned",
      pix_qr_copy_paste: row.pix_copia_cola || null,
      pix_qr_image: row.pix_copia_cola ? qrDataUri(row.pix_copia_cola) : null,
      pix_expires_at: row.pix_expira_em || null,
      pix_expiration: seg,
      paid_at: row.pago_em || null,
    };
  });
}

function serializar(row, cfg, cidade) {
  const p = JSON.parse(row.payload);
  const { etapas, pix, motivo } = etapasAtuais(row, cfg);
  const atual = etapas[etapas.length - 1];
  const iso = (d) => d.toISOString();

  return {
    id: row.id,
    uid: row.uid,
    order_number: row.numero,
    status: atual.status,
    status_changes: etapas.map((e, i) => ({
      id: row.id * 100 + i,
      status: e.status,
      created_at: iso(e.em),
      updated_at: iso(e.em),
    })),
    created_at: new Date(row.criado_em).toISOString(),
    updated_at: iso(atual.em),
    cancellation_reason: motivo,
    has_satisfaction_survey: false,

    order_type: p.order_type || "delivery",
    sales_channel: p.sales_channel || "catalog",
    scheduled_date: p.scheduled_date || null,
    scheduled_period: p.scheduled_period || null,
    estimated_time: row.tempo_estimado,

    final_value: Number(p.final_value) || 0,
    delivery_fee: p.delivery_fee ?? null,
    delivery_man_fee: p.delivery_man_fee ?? null,
    additional_fee: p.additional_fee ?? null,
    service_fee: null,
    earned_points: 0,
    earned_cashback: 0,
    delivery_info_only_by_whatsapp: !!p.delivery_info_only_by_whatsapp,
    benefits: p.benefits || [],
    custom_fields_data: p.custom_fields_data || null,
    invoice_document: p.invoice_document || null,

    client: p.client || null,
    delivery_address: p.delivery_address || null,
    order_items: (p.order_items || []).map((i) => ({ status: "active", ...i })),
    payment_values: valoresDePagamento(row, p, pix),
    pagamento: pix, // só pro painel: pendente | pago | expirado | falhou | null

    company: cidade ? { id: cidade.companyId, name: cidade.nome_empresa, city: cidade.nome, state: cidade.uf } : undefined,
  };
}

module.exports = { serializar, etapasAtuais, ATIVOS, ehPixAuto };
