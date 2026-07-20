import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { execKw, odooConfigurado } from '@/lib/odoo';
import { formatDateIsoLocal } from '@/lib/dates';
import { round2 } from '@/lib/regras';
import type { Cliente, FaturaFechada } from '@/lib/types';

export const dynamic = 'force-dynamic';

const COMPANY_BY_PAIS: Record<string, number> = { MX: 2 };
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ResumoFatura = {
  valor_frete?: number;
  valor_imposto?: number;
  valor_manual?: number;
  taxa_intercompany?: number;
  valor_total?: number;
  moeda?: string;
};

type ItemFatura = {
  tipo_ajuste?: string;
  descricao?: string | null;
  valor?: number;
};

type DetalhesFatura = {
  resumo: ResumoFatura;
  itens: ItemFatura[];
};

type OdooMoveRead = {
  id: number;
  name?: string;
  amount_total?: number;
  payment_state?: string;
  invoice_date_due?: string;
};

function primeiroEmail(...values: Array<string | null | undefined>): string {
  return values
    .join(' ')
    .split(/[;,\s]+/)
    .map(v => v.trim().toLowerCase())
    .find(v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || '';
}

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
  const filename = filenameFromDisposition(
    res.headers.get('content-disposition'),
    `${fat.num_fatura || fat.fatura_id}.xlsx`,
  );
  return { buffer: Buffer.from(await res.arrayBuffer()), filename };
}

async function getCurrencyId(moeda: string): Promise<number | null> {
  const ids = await execKw<number[]>('res.currency', 'search', [[['name', '=', moeda.toUpperCase()]]], { limit: 1 });
  return ids[0] || null;
}

function ajusteValor(item: ItemFatura): number {
  const valor = Math.abs(Number(item.valor || 0));
  const tipo = String(item.tipo_ajuste || '').trim().toLowerCase();
  return tipo === 'desconto' || tipo === 'discount' ? -valor : valor;
}

function ajusteNome(item: ItemFatura, numFatura: string): string {
  const tipo = String(item.tipo_ajuste || 'Ajuste').trim() || 'Ajuste';
  const descricao = String(item.descricao || '').trim();
  return descricao ? `${tipo} - ${numFatura} - ${descricao}` : `${tipo} - ${numFatura}`;
}

async function getOrCreatePartner(cliente: Cliente, nomeCliente: string): Promise<number> {
  const email = primeiroEmail(cliente.emails_contato, cliente.emails_usuario);
  if (email) {
    const found = await execKw<number[]>('res.partner', 'search', [[['email', '=', email]]], { limit: 1 });
    if (found.length) return found[0];
  }

  const nome = String(nomeCliente || cliente.nome || '').trim();
  if (nome) {
    const foundByName = await execKw<number[]>('res.partner', 'search', [[['name', '=', nome]]], { limit: 1 });
    if (foundByName.length) return foundByName[0];
  }

  return execKw<number>('res.partner', 'create', [{
    name: nome || email || 'Cliente ShipSmart',
    email: email || false,
    customer_rank: 1,
  }]);
}

async function anexarExcel(invoiceId: number, filename: string, buffer: Buffer, ctx: Record<string, unknown>): Promise<number> {
  const datas = buffer.toString('base64');
  const vals = {
    name: filename,
    type: 'binary',
    datas,
    res_model: 'account.move',
    res_id: invoiceId,
    mimetype: EXCEL_MIME,
  };
  const existing = await execKw<Array<{ id: number }>>('ir.attachment', 'search_read', [[
    ['res_model', '=', 'account.move'],
    ['res_id', '=', invoiceId],
    ['name', '=', filename],
  ]], { fields: ['id'], limit: 1, context: ctx });

  if (existing[0]?.id) {
    await execKw('ir.attachment', 'write', [[existing[0].id], vals], { context: ctx });
    return existing[0].id;
  }
  return execKw<number>('ir.attachment', 'create', [vals], { context: ctx });
}

export async function POST(req: NextRequest) {
  if (!odooConfigurado()) {
    return NextResponse.json({ error: 'Odoo nao configurado (faltam env vars ODOO_*).' }, { status: 500 });
  }

  const { faturaId } = await req.json();
  if (!faturaId) return NextResponse.json({ error: 'faturaId obrigatorio' }, { status: 400 });

  const [fat] = await query<FaturaFechada>(
    `SELECT * FROM faturamentos_fechados WHERE fatura_id=$1`,
    [faturaId],
  );
  if (!fat) return NextResponse.json({ error: 'Fatura nao encontrada.' }, { status: 404 });
  if (fat.status === 'reaberto') return NextResponse.json({ error: 'Fatura reaberta nao pode ser enviada ao Odoo.' }, { status: 400 });

  const pais = String(fat.pais || '').toUpperCase();
  const companyId = COMPANY_BY_PAIS[pais];
  if (!companyId || pais !== 'MX') {
    return NextResponse.json({ error: 'Por enquanto o envio de faturas fechadas ao Odoo esta liberado apenas para MX.' }, { status: 400 });
  }

  const [cliente] = await query<Cliente>(`SELECT * FROM clientes WHERE cliente_id=$1`, [fat.cliente_id]);
  if (!cliente) return NextResponse.json({ error: 'Cliente nao encontrado.' }, { status: 404 });

  const ctx = { allowed_company_ids: [companyId], company_id: companyId };
  try {
    const detalhes = await fetchDetalhes(req, fat.fatura_id);
    const resumo = detalhes.resumo;
    const excel = await fetchExcel(req, fat);
    const moeda = String(resumo.moeda || fat.moeda || 'MXN').toUpperCase();
    const currencyId = await getCurrencyId(moeda);
    const partnerId = await getOrCreatePartner(cliente, fat.nome_cliente);
    const numFatura = fat.num_fatura || fat.fatura_id;
    const ref = `Fatura ${numFatura}`;

    const existing = await execKw<OdooMoveRead[]>('account.move', 'search_read', [[
      ['company_id', '=', companyId],
      ['move_type', '=', 'out_invoice'],
      ['ref', '=', ref],
    ]], {
      fields: ['id', 'name', 'amount_total', 'payment_state', 'invoice_date_due'],
      limit: 1,
      context: ctx,
    });

    if (existing[0]?.id) {
      const attachmentId = await anexarExcel(existing[0].id, excel.filename, excel.buffer, ctx);
      return NextResponse.json({
        ok: true,
        jaExistia: true,
        invoiceId: existing[0].id,
        numero: existing[0].name || String(existing[0].id),
        total: existing[0].amount_total || 0,
        pagamento: existing[0].payment_state || '?',
        vencimento: existing[0].invoice_date_due || null,
        attachmentId,
        filename: excel.filename,
        moeda,
      });
    }

    const linhas: unknown[] = [];
    const addLine = (name: string, amount: number) => {
      const value = round2(Number(amount || 0));
      if (Math.abs(value) >= 0.01) {
        linhas.push([0, 0, { name, quantity: 1, price_unit: value, tax_ids: [[6, 0, []]] }]);
      }
    };
    addLine(`Freight - ${numFatura}`, Number(resumo.valor_frete || 0));
    addLine(`Duties & Taxes - ${numFatura}`, Number(resumo.valor_imposto || 0));
    for (const item of detalhes.itens) {
      addLine(ajusteNome(item, numFatura), ajusteValor(item));
    }
    addLine(`Intercompany Cross-Border Fee - ${numFatura}`, Number(resumo.taxa_intercompany || 0));

    if (!linhas.length) return NextResponse.json({ error: 'Fatura sem valor para enviar ao Odoo.' }, { status: 400 });

    const hoje = formatDateIsoLocal(new Date());
    const vencimento = addDaysIso(hoje, 7);
    const invoiceVals: Record<string, unknown> = {
      move_type: 'out_invoice',
      company_id: companyId,
      partner_id: partnerId,
      invoice_date: hoje,
      invoice_date_due: vencimento,
      invoice_payment_term_id: false,
      ref,
      invoice_line_ids: linhas,
    };
    if (currencyId) invoiceVals.currency_id = currencyId;

    const invoiceId = await execKw<number>('account.move', 'create', [invoiceVals], { context: ctx });
    await execKw('account.move', 'action_post', [[invoiceId]], { context: ctx });
    const attachmentId = await anexarExcel(invoiceId, excel.filename, excel.buffer, ctx);

    const [mv] = await execKw<OdooMoveRead[]>('account.move', 'read', [[invoiceId]], {
      fields: ['name', 'amount_total', 'payment_state', 'invoice_date_due'],
      context: ctx,
    });

    return NextResponse.json({
      ok: true,
      invoiceId,
      numero: mv?.name || String(invoiceId),
      total: mv?.amount_total ?? round2(Number(resumo.valor_total || 0)),
      pagamento: mv?.payment_state || '?',
      vencimento: mv?.invoice_date_due || vencimento,
      attachmentId,
      filename: excel.filename,
      moeda,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
