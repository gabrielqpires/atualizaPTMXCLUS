import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { query } from '@/lib/db';
import { execKw, odooConfigurado } from '@/lib/odoo';
import {
  getMoloniCustomerDetails,
  getOrCreateMoloniCustomer,
  getOrCreateMoloniProduct,
  moloniConfig,
  moloniConfigurado,
  moloniPost,
  primeiroEmail,
} from '@/lib/moloni';
import { formatDateIsoLocal } from '@/lib/dates';
import { round2 } from '@/lib/regras';
import type { MoloniCustomerDetails } from '@/lib/moloni';
import type { Cliente, FaturaFechada } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PT_COMPANY_ID = Number(process.env.ODOO_PT_COMPANY_ID || 3);
const PT_SALES_JOURNAL_ID = Number(process.env.ODOO_PT_SALES_JOURNAL_ID || 29);
const PT_INCOME_ACCOUNT_ID = Number(process.env.ODOO_PT_INCOME_ACCOUNT_ID || 1760);
const TMS_UNIT_PRICE = 0.53;
const MOR_UNIT_PRICE = 1.30;

type ResumoFatura = {
  valor_frete?: number;
  valor_imposto?: number;
  valor_manual?: number;
  taxa_pct?: number;
  taxa_intercompany?: number;
  valor_total?: number;
  moeda?: string;
};

type RemessaFatura = {
  remessa_id?: string;
  awb?: string | null;
  grupo?: string | null;
  valor_frete?: number;
  valor_imposto?: number;
  tipo?: string | null;
  isManual?: boolean;
};

type ItemFatura = {
  tipo_ajuste?: string;
  descricao?: string | null;
  valor?: number;
};

type DetalhesFatura = {
  resumo: ResumoFatura;
  remessas: RemessaFatura[];
  itens: ItemFatura[];
};

type IntegracaoFiscal = {
  fatura_id: string;
  moloni_document_id: number | null;
  moloni_label: string | null;
  moloni_customer_id: number | null;
  odoo_nd_id: number | null;
  odoo_nd_name: string | null;
};

type OdooMoveRead = {
  id: number;
  name?: string;
  ref?: string | false;
  payment_reference?: string | false;
  invoice_origin?: string | false;
  amount_total?: number;
  payment_state?: string;
  invoice_date_due?: string;
};

type OdooPartnerRead = {
  id: number;
  name?: string;
  vat?: string | false;
  street?: string | false;
  street2?: string | false;
  zip?: string | false;
  city?: string | false;
  country_id?: [number, string] | false;
};

type MoloniInvoiceResponse = number | { document_id?: number; invoice_id?: number; id?: number; number?: string; document_number?: string };

type MoloniLine = {
  product_id: number;
  name: string;
  summary: string;
  qty: number;
  price: number;
  discount: number;
  order: number;
  exemption_reason: string;
  taxes: unknown[];
};

function addDaysIso(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) return decodeURIComponent(utf[1]).replace(/[\\/]/g, '_');
  const plain = header.match(/filename="?([^";]+)"?/i);
  if (plain?.[1]) return plain[1].replace(/[\\/]/g, '_');
  return fallback;
}

function apiHeaders(req: NextRequest): HeadersInit {
  const cookie = req.headers.get('cookie');
  return cookie ? { cookie } : {};
}

async function fetchDetalhes(req: NextRequest, faturaId: string): Promise<DetalhesFatura> {
  const url = new URL('/api/remessas-fatura', req.nextUrl.origin);
  url.searchParams.set('faturaId', faturaId);
  const res = await fetch(url, { headers: apiHeaders(req), cache: 'no-store' });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Falha ao recalcular resumo da fatura (${res.status}).`);
  return {
    resumo: json?.resumo || {},
    remessas: Array.isArray(json?.remessas) ? json.remessas : [],
    itens: Array.isArray(json?.itens) ? json.itens : [],
  };
}

async function fetchExcel(req: NextRequest, fat: FaturaFechada): Promise<{ buffer: Buffer; filename: string }> {
  const url = new URL(`/api/gerar-fatura/${encodeURIComponent(fat.cliente_id)}`, req.nextUrl.origin);
  url.searchParams.set('pais', fat.pais);
  url.searchParams.set('numFatura', fat.num_fatura || fat.fatura_id);
  const res = await fetch(url, { headers: apiHeaders(req), cache: 'no-store' });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Falha ao gerar Excel da fatura (${res.status}). ${msg.slice(0, 200)}`);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    filename: filenameFromDisposition(res.headers.get('content-disposition'), `${fat.num_fatura || fat.fatura_id}.xlsx`),
  };
}

async function ensureIntegrationTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS integracoes_faturamento (
      fatura_id text PRIMARY KEY,
      moloni_document_id bigint,
      moloni_label text,
      moloni_customer_id bigint,
      odoo_nd_id integer,
      odoo_nd_name text,
      criado_em timestamptz DEFAULT now(),
      atualizado_em timestamptz DEFAULT now()
    )
  `);
  await query(`ALTER TABLE integracoes_faturamento ADD COLUMN IF NOT EXISTS moloni_customer_id bigint`);
}

async function readIntegration(faturaId: string): Promise<IntegracaoFiscal | null> {
  const [row] = await query<IntegracaoFiscal>(
    `SELECT fatura_id,moloni_document_id,moloni_label,moloni_customer_id,odoo_nd_id,odoo_nd_name FROM integracoes_faturamento WHERE fatura_id=$1`,
    [faturaId],
  );
  return row || null;
}

async function saveIntegration(faturaId: string, vals: Partial<IntegracaoFiscal>) {
  await query(
    `INSERT INTO integracoes_faturamento (fatura_id,moloni_document_id,moloni_label,moloni_customer_id,odoo_nd_id,odoo_nd_name,atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (fatura_id) DO UPDATE SET
       moloni_document_id=COALESCE(EXCLUDED.moloni_document_id, integracoes_faturamento.moloni_document_id),
       moloni_label=COALESCE(EXCLUDED.moloni_label, integracoes_faturamento.moloni_label),
       moloni_customer_id=COALESCE(EXCLUDED.moloni_customer_id, integracoes_faturamento.moloni_customer_id),
       odoo_nd_id=COALESCE(EXCLUDED.odoo_nd_id, integracoes_faturamento.odoo_nd_id),
       odoo_nd_name=COALESCE(EXCLUDED.odoo_nd_name, integracoes_faturamento.odoo_nd_name),
       atualizado_em=now()`,
    [faturaId, vals.moloni_document_id || null, vals.moloni_label || null, vals.moloni_customer_id || null, vals.odoo_nd_id || null, vals.odoo_nd_name || null],
  );
}

function ajusteValor(item: ItemFatura): number {
  const valor = Math.abs(Number(item.valor || 0));
  const tipo = String(item.tipo_ajuste || '').trim().toLowerCase();
  return tipo === 'desconto' || tipo === 'discount' ? -valor : valor;
}

function remessasNonEuComImposto(detalhes: DetalhesFatura): RemessaFatura[] {
  return detalhes.remessas.filter(r =>
    String(r.grupo || '').toUpperCase() !== 'EU' && Number(r.valor_imposto || 0) > 0,
  );
}

function totalDutiesNonEu(detalhes: DetalhesFatura): number {
  return round2(remessasNonEuComImposto(detalhes).reduce((s, r) => s + Number(r.valor_imposto || 0), 0));
}

function destinatarioFiscal(cliente: Cliente, nomeCliente: string): { nome: string; fallback: MoloniCustomerDetails | null } {
  const intermediario = String(cliente.intermediario_cobranca || '').trim().toLowerCase();
  const nome = String(nomeCliente || cliente.nome || '').trim();
  if (intermediario.includes('ucm')) {
    return {
      nome: 'Unstoppable Commerce Machine, Lda.',
      fallback: {
        customer_id: 0,
        name: 'Unstoppable Commerce Machine, Lda.',
        vat: '518309061',
        address: 'Rua Professor Oliveira Andrade N 420A',
        zip_code: '4470-634',
        city: 'Maia',
        country: { country: 'Portugal', iso_3166_1: 'PT' },
      },
    };
  }
  if (intermediario.includes('undo') || nome.toLowerCase().includes('undo')) {
    return {
      nome: 'Conscious Galaxy Unipessoal Lda',
      fallback: {
        customer_id: 0,
        name: 'Conscious Galaxy Unipessoal Lda',
        vat: '516382810',
        address: 'Rua Jose Lourenco da Luz Gomes N 1 2 Esq',
        zip_code: '2770-105',
        city: 'Paco de Arcos',
        country: { country: 'Portugal', iso_3166_1: 'PT' },
      },
    };
  }
  return { nome: nome || 'Cliente', fallback: null };
}

function extrairNumeroNotaDebito(value: unknown): number | null {
  const text = String(value || '').toUpperCase();
  const match = text.match(/(?:NOTA\s+DE\s+DEBITO|ND)\D*(\d{1,6})/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function proximoNumeroNotaDebito(ctx: Record<string, unknown>): Promise<string> {
  const rows = await execKw<OdooMoveRead[]>('account.move', 'search_read', [[
    ['company_id', '=', PT_COMPANY_ID],
    ['move_type', '=', 'out_invoice'],
    '|',
    ['ref', 'ilike', 'Nota de Debito'],
    ['payment_reference', 'ilike', 'ND'],
  ]], {
    fields: ['name', 'ref', 'payment_reference', 'invoice_origin'],
    limit: 200,
    order: 'id desc',
    context: ctx,
  });
  const max = rows.reduce((acc, row) => {
    const found = [row.ref, row.payment_reference, row.invoice_origin, row.name]
      .map(extrairNumeroNotaDebito)
      .filter((n): n is number => n !== null);
    return Math.max(acc, ...found, 0);
  }, 0);
  return String(max + 1).padStart(2, '0');
}

function productRef(key: string): string {
  return String(process.env[key] || '').trim();
}

async function addMoloniLine(lines: MoloniLine[], reference: string, name: string, amount: number, qty = 1) {
  const quantity = Math.max(1, Number(qty || 1));
  const value = round2(Number(amount || 0));
  if (value < 0.01) return;
  const cfg = moloniConfig();
  const productId = await getOrCreateMoloniProduct(reference, name);
  lines.push({
    product_id: productId,
    name,
    summary: '',
    qty: quantity,
    price: round2(value / quantity),
    discount: 0,
    order: lines.length + 1,
    exemption_reason: cfg.exemptionReason,
    taxes: [],
  });
}


function techMoloniLine(cliente: Cliente, detalhes: DetalhesFatura): { reference: string; name: string; amount: number; qty: number } | null {
  const tms = !!cliente.tms;
  const mor = !!cliente.mor;
  if (!tms && !mor) return null;

  const qty = detalhes.remessas.filter(r => !r.isManual && String(r.tipo || 'remessa') === 'remessa').length;
  if (qty < 1) return null;

  if (tms && mor) {
    return {
      reference: productRef('MOLONI_PRODUCT_REF_TMS_MOR') || 'TMS & MOR',
      name: productRef('MOLONI_PRODUCT_NAME_TMS_MOR') || 'TMS & MOR',
      amount: round2(qty * (TMS_UNIT_PRICE + MOR_UNIT_PRICE)),
      qty,
    };
  }

  if (tms) {
    return {
      reference: productRef('MOLONI_PRODUCT_REF_TMS') || 'TMS',
      name: productRef('MOLONI_PRODUCT_NAME_TMS') || 'TMS',
      amount: round2(qty * TMS_UNIT_PRICE),
      qty,
    };
  }

  return {
    reference: productRef('MOLONI_PRODUCT_REF_MOR') || 'MOR',
    name: productRef('MOLONI_PRODUCT_NAME_MOR') || 'MOR',
    amount: round2(qty * MOR_UNIT_PRICE),
    qty,
  };
}
function parseMoloniDocument(resp: MoloniInvoiceResponse): { id: number; label: string } {
  if (typeof resp === 'number') return { id: resp, label: String(resp) };
  const id = Number(resp.document_id || resp.invoice_id || resp.id || 0);
  if (!id) throw new Error(`Moloni devolveu documento sem id: ${JSON.stringify(resp).slice(0, 300)}`);
  return { id, label: String(resp.document_number || resp.number || id) };
}

async function criarFaturaMoloni(cliente: Cliente, fat: FaturaFechada, detalhes: DetalhesFatura, dataDoc: string, vencimento: string) {
  const cfg = moloniConfig();
  const fiscal = destinatarioFiscal(cliente, fat.nome_cliente || cliente.nome);
  const nomeCliente = fiscal.nome;
  const email = primeiroEmail(cliente.emails_contato, cliente.emails_usuario);
  const customerId = await getOrCreateMoloniCustomer(nomeCliente, email);
  const customer = await getMoloniCustomerDetails(customerId);

  const freteEu = detalhes.remessas
    .filter(r => String(r.grupo || '').toUpperCase() === 'EU')
    .reduce((s, r) => s + Number(r.valor_frete || 0), 0);
  const freteNonEu = detalhes.remessas
    .filter(r => String(r.grupo || '').toUpperCase() !== 'EU')
    .reduce((s, r) => s + Number(r.valor_frete || 0), 0);

  const lines: MoloniLine[] = [];
  await addMoloniLine(
    lines,
    productRef('MOLONI_PRODUCT_REF_EU') || 'Servico de Transporte',
    productRef('MOLONI_PRODUCT_NAME_EU') || 'Servico de Transporte Internacional na Uniao Europeia - 1 envio',
    freteEu,
  );
  await addMoloniLine(
    lines,
    productRef('MOLONI_PRODUCT_REF_NON_EU') || 'Transporte Fora UE',
    productRef('MOLONI_PRODUCT_NAME_NON_EU') || 'Servico de Transporte Internacional fora da Uniao Europeia - 1 envio',
    freteNonEu,
  );
  const techLine = techMoloniLine(cliente, detalhes);
  if (techLine) {
    await addMoloniLine(lines, techLine.reference, techLine.name, techLine.amount, techLine.qty);
  }

  await addMoloniLine(
    lines,
    productRef('MOLONI_PRODUCT_REF_FEE') || 'Intercompany Cross-Border Fee',
    productRef('MOLONI_PRODUCT_NAME_FEE') || 'Intercompany Cross-Border Fee',
    Number(detalhes.resumo.taxa_intercompany || 0),
  );

  let specialDiscount = 0;
  for (const item of detalhes.itens) {
    const value = ajusteValor(item);
    if (value < -0.01) {
      specialDiscount += Math.abs(value);
      continue;
    }
    await addMoloniLine(
      lines,
      productRef('MOLONI_PRODUCT_REF_AJUSTE') || 'Ajuste',
      String(item.descricao || item.tipo_ajuste || 'Ajuste'),
      value,
    );
  }

  const gross = round2(lines.reduce((s, l) => s + Number(l.price || 0), 0));
  if (gross < 0.01) return null;
  if (specialDiscount > gross) throw new Error('Descontos maiores que o total positivo da fatura Moloni.');

  const numFatura = fat.num_fatura || fat.fatura_id;
  const resp = await moloniPost<MoloniInvoiceResponse>('invoices/insert', {
    company_id: cfg.companyId,
    document_set_id: cfg.documentSetId,
    customer_id: customerId,
    maturity_date_id: cfg.maturityDateId,
    date: dataDoc,
    expiration_date: vencimento,
    status: 0,
    products: lines,
    special_discount: round2(specialDiscount),
    our_reference: numFatura,
    your_reference: fat.fatura_id,
    notes: `Fatura ShipSmart ${numFatura}`,
  });
  return { ...parseMoloniDocument(resp), customerId, customer };
}

async function getOrCreateOdooPartner(cliente: Cliente, nomeCliente: string, ctx: Record<string, unknown>): Promise<number> {
  const email = primeiroEmail(cliente.emails_contato, cliente.emails_usuario);
  if (email) {
    const byEmail = await execKw<number[]>('res.partner', 'search', [[['email', '=', email]]], { limit: 1, context: ctx });
    if (byEmail[0]) return byEmail[0];
  }
  const nome = String(nomeCliente || cliente.nome || '').trim();
  if (nome) {
    const byName = await execKw<number[]>('res.partner', 'search', [[['name', '=', nome]]], { limit: 1, context: ctx });
    if (byName[0]) return byName[0];
  }
  return execKw<number>('res.partner', 'create', [{
    name: nome || email || 'Cliente ShipSmart',
    email: email || false,
    customer_rank: 1,
  }], { context: ctx });
}

async function anexarArquivo(moveId: number, filename: string, buffer: Buffer, mimetype: string, ctx: Record<string, unknown>): Promise<number> {
  return execKw<number>('ir.attachment', 'create', [{
    name: filename,
    type: 'binary',
    datas: buffer.toString('base64'),
    res_model: 'account.move',
    res_id: moveId,
    mimetype,
  }], { context: ctx });
}

async function anexarExcel(moveId: number, filename: string, buffer: Buffer, ctx: Record<string, unknown>): Promise<number> {
  return anexarArquivo(moveId, filename, buffer, EXCEL_MIME, ctx);
}

async function readOdooPartner(partnerId: number, ctx: Record<string, unknown>): Promise<OdooPartnerRead | null> {
  const [partner] = await execKw<OdooPartnerRead[]>('res.partner', 'read', [[partnerId]], {
    fields: ['name', 'vat', 'street', 'street2', 'zip', 'city', 'country_id'],
    context: ctx,
  });
  return partner || null;
}

function stripControl(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function pdfEscape(value: string): string {
  return stripControl(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function moneyEur(value: number): string {
  return new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
}

function wrapWords(text: string, maxChars: number): string[] {
  const words = stripControl(text).split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function readLogoJpeg(): { data: string; width: number; height: number } | null {
  try {
    const logoPath = path.join(process.cwd(), 'public', 'shipsmart-logo.jpg');
    const data = fs.readFileSync(logoPath);
    return { data: data.toString('latin1'), width: 385, height: 278 };
  } catch {
    return null;
  }
}

function buildPdf(objects: string[]): Buffer {
  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(header + body, 'latin1'));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(header + body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, 'latin1');
}

function criarPdfNotaDebito(args: {
  numero: string;
  clienteNome: string;
  partner: OdooPartnerRead | null;
  moloniCustomer: MoloniCustomerDetails | null;
  total: number;
  quantidade: number;
  dataInicio: string | null;
  dataFim: string | null;
  prazoDias: number;
}): Buffer {
  const pageLines: string[] = [];
  const draw = (cmd: string) => pageLines.push(cmd);
  const add = (x: number, y: number, size: number, text: string, bold = false, color = '0 0 0') => {
    pageLines.push(`BT ${color} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`);
  };
  const paragraph = (x: number, y: number, size: number, text: string, maxChars = 88, leading = 15) => {
    let yy = y;
    for (const line of wrapWords(text, maxChars)) {
      add(x, yy, size, line);
      yy -= leading;
    }
    return yy;
  };

  const moloni = args.moloniCustomer;
  const partnerLines = moloni ? [
    moloni.name || args.clienteNome,
    moloni.vat ? `NIF: ${moloni.vat}` : '',
    moloni.address || '',
    [moloni.zip_code || '', moloni.city || ''].filter(Boolean).join(' '),
    moloni.country?.country || '',
  ].filter(Boolean) : [
    args.clienteNome,
    args.partner?.vat ? `NIF: ${args.partner.vat}` : '',
    args.partner?.street ? String(args.partner.street) : '',
    args.partner?.street2 ? String(args.partner.street2) : '',
    [args.partner?.zip || '', args.partner?.city || ''].filter(Boolean).join(' '),
    Array.isArray(args.partner?.country_id) ? args.partner?.country_id[1] || '' : '',
  ].filter(Boolean);
  const periodo = args.dataInicio && args.dataFim ? ` entre ${args.dataInicio} e ${args.dataFim}` : '';

  const logo = readLogoJpeg();
  draw('0.08 0.19 0.35 rg 42 744 511 2 re f');
  if (logo) {
    draw('q 92 0 0 66 438 746 cm /Im1 Do Q');
  } else {
    add(462, 780, 13, 'SHIP', true, '0 0 0');
    add(462, 764, 13, 'SMART', true, '0 0 0');
  }
  add(52, 786, 17, `NOTA DE DEBITO ${args.numero}`, true, '0.04 0.13 0.30');
  add(52, 766, 13, 'IMPOSTOS ADUANEIROS (DUTIES & TAXES)', true, '0.04 0.13 0.30');

  add(52, 720, 11, 'Emitente', true, '0.04 0.13 0.30');
  add(52, 704, 11, 'Shipsmart Global / DARE2BEGIN - Unipessoal Lda.', true);
  add(52, 688, 10, 'NIF: 519023790');
  add(52, 673, 10, 'Rua Serpa Pinto, No 18, 1o andar');
  add(52, 658, 10, '2560-363 Torres Vedras - Portugal');
  add(52, 643, 10, 'E-mail: financeiro@shipsmart.global');

  add(52, 600, 11, 'Destinatario', true, '0.04 0.13 0.30');
  let y = 577;
  for (const line of partnerLines) {
    add(52, y, 10, line);
    y -= 15;
  }

  y -= 14;
  add(52, y, 12, '1. Contexto', true, '0.04 0.13 0.30');
  y -= 20;
  y = paragraph(52, y, 10, 'Esta Nota de Debito refere-se exclusivamente aos impostos de importacao (Duties & Taxes) pagos pela Shipsmart/DARE2BEGIN durante o processo de desembaraco aduaneiro, em nome e por conta do cliente. O valor debitado nao constitui receita, sendo apenas o reembolso do montante suportado.');

  y -= 14;
  add(52, y, 12, '2. Impostos (Duties & Taxes) pagos por conta do cliente', true, '0.04 0.13 0.30');
  y -= 22;
  add(70, y, 10, '- Tipo de despesa: Impostos aduaneiros (Duties & Taxes)'); y -= 16;
  add(70, y, 10, `- Processo: Desembaraco aduaneiro fora da UE${periodo}.`); y -= 16;
  add(70, y, 10, `- Quantidade: ${args.quantidade || ''} Envios internacionais fora da Uniao Europeia`); y -= 16;
  add(70, y, 10, `- Valor total pago: EUR ${moneyEur(args.total)}`); y -= 32;
  add(52, y, 12, `Total a reembolsar: EUR ${moneyEur(args.total)}`, true);

  y -= 38;
  add(52, y, 12, '3. Condicoes de Pagamento', true, '0.04 0.13 0.30');
  y -= 22;
  add(70, y, 10, '- Moeda: EUR'); y -= 16;
  add(70, y, 10, `- Prazo: ${args.prazoDias || 7} dias apos rececao`); y -= 16;
  add(70, y, 10, '- Forma: Transferencia bancaria'); y -= 16;
  add(70, y, 10, '- Referencia: Reembolso - Duties & Taxes (Desembaraco Aduaneiro)');

  y -= 36;
  add(52, y, 12, '4. Observacao Legal', true, '0.04 0.13 0.30');
  y -= 20;
  paragraph(52, y, 10, 'Documento nao sujeito a IVA, por corresponder a despesas efetuadas em nome e por conta do cliente (reembolso de encargos aduaneiros). Nao representa prestacao de servicos.');

  const stream = pageLines.join('\n');
  const contentObjectNumber = logo ? 7 : 6;
  const imageResources = logo ? '/XObject << /Im1 6 0 R >>' : '';
  const imageObject = logo
    ? `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${Buffer.byteLength(logo.data, 'latin1')} >>\nstream\n${logo.data}\nendstream`
    : null;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> ${imageResources} >> /Contents ${contentObjectNumber} 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ...(imageObject ? [imageObject] : []),
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  return buildPdf(objects);
}

async function criarNotaDebitoOdoo(cliente: Cliente, fat: FaturaFechada, detalhes: DetalhesFatura, dataDoc: string, vencimento: string, excel: { buffer: Buffer; filename: string }, moloniCustomer: MoloniCustomerDetails | null, moloniLabel: string | null) {
  const nonEuDuties = remessasNonEuComImposto(detalhes);
  const totalImposto = totalDutiesNonEu(detalhes);
  if (totalImposto < 0.01) return null;

  const ctx = { allowed_company_ids: [PT_COMPANY_ID], company_id: PT_COMPANY_ID };
  const numFatura = fat.num_fatura || fat.fatura_id;
  const fiscal = destinatarioFiscal(cliente, fat.nome_cliente || cliente.nome);
  const partnerId = await getOrCreateOdooPartner(cliente, fiscal.nome, ctx);
  const partner = await readOdooPartner(partnerId, ctx);
  const customerForPdf = moloniCustomer || fiscal.fallback;
  const ndNumero = await proximoNumeroNotaDebito(ctx);
  const faturaRef = moloniLabel || numFatura;
  const ref = `Nota de Debito ${ndNumero} - Fatura ${faturaRef}`;
  const datas = nonEuDuties.map(r => String((r as { data?: string }).data || '').slice(0, 10)).filter(Boolean).sort();
  const pdf = criarPdfNotaDebito({
    numero: ndNumero,
    clienteNome: fiscal.nome,
    partner,
    moloniCustomer: customerForPdf,
    total: totalImposto,
    quantidade: nonEuDuties.length,
    dataInicio: datas[0] || null,
    dataFim: datas[datas.length - 1] || null,
    prazoDias: Number(cliente.dias_vencimento || 7),
  });

  const existing = await execKw<OdooMoveRead[]>('account.move', 'search_read', [[
    ['company_id', '=', PT_COMPANY_ID],
    ['move_type', '=', 'out_invoice'],
    ['ref', '=', ref],
  ]], { fields: ['id', 'name', 'amount_total', 'payment_state', 'invoice_date_due'], limit: 1, context: ctx });

  if (existing[0]?.id) {
    return {
      id: existing[0].id,
      name: existing[0].name || String(existing[0].id),
      total: existing[0].amount_total || totalImposto,
      payment_state: existing[0].payment_state || '?',
      invoice_date_due: existing[0].invoice_date_due || vencimento,
      jaExistia: true,
    };
  }

  const moveId = await execKw<number>('account.move', 'create', [{
    move_type: 'out_invoice',
    company_id: PT_COMPANY_ID,
    journal_id: PT_SALES_JOURNAL_ID,
    partner_id: partnerId,
    invoice_date: dataDoc,
    invoice_date_due: vencimento,
    invoice_payment_term_id: false,
    ref,
    payment_reference: `ND ${ndNumero}`,
    invoice_origin: `Fatura ${faturaRef}`,
    invoice_line_ids: [[0, 0, {
      name: `Nota de Debito ${ndNumero} vinculada a fatura ${faturaRef} - direitos e impostos`,
      quantity: 1,
      price_unit: totalImposto,
      account_id: PT_INCOME_ACCOUNT_ID,
      tax_ids: [[6, 0, []]],
    }]],
  }], { context: ctx });
  await execKw('account.move', 'action_post', [[moveId]], { context: ctx });
  await anexarExcel(moveId, excel.filename, excel.buffer, ctx);
  await anexarArquivo(moveId, `Nota de Debito ${ndNumero} - ${faturaRef}.pdf`, pdf, 'application/pdf', ctx);

  const [mv] = await execKw<OdooMoveRead[]>('account.move', 'read', [[moveId]], {
    fields: ['name', 'amount_total', 'payment_state', 'invoice_date_due'],
    context: ctx,
  });
  return {
    id: moveId,
    name: mv?.name || String(moveId),
    total: mv?.amount_total || totalImposto,
    payment_state: mv?.payment_state || '?',
    invoice_date_due: mv?.invoice_date_due || vencimento,
    jaExistia: false,
  };
}

export async function POST(req: NextRequest) {
  if (!moloniConfigurado()) {
    return NextResponse.json({ error: 'Moloni nao configurado (faltam env vars MOLONI_*).' }, { status: 500 });
  }
  if (!odooConfigurado()) {
    return NextResponse.json({ error: 'Odoo nao configurado (faltam env vars ODOO_*).' }, { status: 500 });
  }

  const { faturaId } = await req.json();
  if (!faturaId) return NextResponse.json({ error: 'faturaId obrigatorio' }, { status: 400 });

  await ensureIntegrationTable();

  const [fat] = await query<FaturaFechada>(`SELECT * FROM faturamentos_fechados WHERE fatura_id=$1`, [faturaId]);
  if (!fat) return NextResponse.json({ error: 'Fatura nao encontrada.' }, { status: 404 });
  if (fat.status === 'reaberto') return NextResponse.json({ error: 'Fatura reaberta nao pode ser integrada.' }, { status: 400 });
  if (String(fat.pais || '').toUpperCase() !== 'PT') {
    return NextResponse.json({ error: 'Esta integracao fiscal esta liberada apenas para PT.' }, { status: 400 });
  }

  const [cliente] = await query<Cliente>(`SELECT * FROM clientes WHERE cliente_id=$1`, [fat.cliente_id]);
  if (!cliente) return NextResponse.json({ error: 'Cliente nao encontrado.' }, { status: 404 });

  try {
    const detalhes = await fetchDetalhes(req, fat.fatura_id);
    const moeda = String(detalhes.resumo.moeda || fat.moeda || cliente.moeda_pagamento || 'EUR').toUpperCase();
    if (moeda !== 'EUR') return NextResponse.json({ error: `PT/Moloni esperado em EUR, mas a fatura esta em ${moeda}.` }, { status: 400 });

    const dataDoc = formatDateIsoLocal(new Date());
    const vencimento = addDaysIso(dataDoc, Number(cliente.dias_vencimento || 7));
    const excel = await fetchExcel(req, fat);
    let integracao = await readIntegration(fat.fatura_id);

    let moloniCustomer = integracao?.moloni_customer_id ? await getMoloniCustomerDetails(Number(integracao.moloni_customer_id)) : null;
    let moloni = integracao?.moloni_document_id
      ? { id: Number(integracao.moloni_document_id), label: integracao.moloni_label || String(integracao.moloni_document_id), customerId: Number(integracao.moloni_customer_id || 0) || null, jaExistia: true }
      : null;
    if (!moloni) {
      const created = await criarFaturaMoloni(cliente, fat, detalhes, dataDoc, vencimento);
      if (created) {
        await saveIntegration(fat.fatura_id, { moloni_document_id: created.id, moloni_label: created.label, moloni_customer_id: created.customerId });
        moloniCustomer = created.customer;
        moloni = { id: created.id, label: created.label, customerId: created.customerId, jaExistia: false };
      }
    }

    integracao = await readIntegration(fat.fatura_id);
    let odooNd = integracao?.odoo_nd_id
      ? { id: Number(integracao.odoo_nd_id), name: integracao.odoo_nd_name || String(integracao.odoo_nd_id), jaExistia: true }
      : null;
    if (!odooNd) {
      const createdNd = await criarNotaDebitoOdoo(cliente, fat, detalhes, dataDoc, vencimento, excel, moloniCustomer, moloni?.label || null);
      if (createdNd) {
        await saveIntegration(fat.fatura_id, { odoo_nd_id: createdNd.id, odoo_nd_name: createdNd.name });
        odooNd = createdNd;
      }
    }

    return NextResponse.json({
      ok: true,
      moloni,
      odooNd,
      moeda,
      vencimento,
      totalMoloniEstimado: round2(
        Number(detalhes.resumo.valor_frete || 0) +
        Number(detalhes.resumo.valor_manual || 0) +
        Number(detalhes.resumo.taxa_intercompany || 0) +
        Number(techMoloniLine(cliente, detalhes)?.amount || 0),
      ),
      totalNotaDebito: totalDutiesNonEu(detalhes),
      filename: excel.filename,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}


