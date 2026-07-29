import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { execKw, odooConfigurado } from '@/lib/odoo';
import { buscarClienteMoloni, getMoloniCustomerDetails, moloniConfigurado, primeiroEmail } from '@/lib/moloni';
import { round2 } from '@/lib/regras';
import type { MoloniCustomerDetails } from '@/lib/moloni';
import type { Cliente, FaturaFechada } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PT_COMPANY_ID = Number(process.env.ODOO_PT_COMPANY_ID || 3);

type RemessaFatura = {
  remessa_id?: string;
  awb?: string | null;
  grupo?: string | null;
  valor_imposto?: number;
  data?: string | null;
};

type DetalhesFatura = {
  remessas: RemessaFatura[];
};

type OdooMoveRead = {
  name?: string;
  ref?: string | false;
  payment_reference?: string | false;
  invoice_origin?: string | false;
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
  return { remessas: Array.isArray(json?.remessas) ? json.remessas : [] };
}

function remessasNonEuComImposto(detalhes: DetalhesFatura): RemessaFatura[] {
  return detalhes.remessas.filter(r =>
    String(r.grupo || '').toUpperCase() !== 'EU' && Number(r.valor_imposto || 0) > 0,
  );
}

function totalDutiesNonEu(detalhes: DetalhesFatura): number {
  return round2(remessasNonEuComImposto(detalhes).reduce((s, r) => s + Number(r.valor_imposto || 0), 0));
}

function extrairNumeroNotaDebito(value: unknown): number | null {
  const text = String(value || '').toUpperCase();
  const match = text.match(/(?:NOTA\s+DE\s+DEBITO|ND)\D*(\d{1,6})/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function proximoNumeroNotaDebito(): Promise<string> {
  if (!odooConfigurado()) return 'PREVIEW';
  const ctx = { allowed_company_ids: [PT_COMPANY_ID], company_id: PT_COMPANY_ID };
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

async function buscarPartnerOdoo(cliente: Cliente, nomeCliente: string): Promise<OdooPartnerRead | null> {
  if (!odooConfigurado()) return null;
  const ctx = { allowed_company_ids: [PT_COMPANY_ID], company_id: PT_COMPANY_ID };
  const email = primeiroEmail(cliente.emails_contato, cliente.emails_usuario);
  let ids: number[] = [];
  if (email) ids = await execKw<number[]>('res.partner', 'search', [[['email', '=', email]]], { limit: 1, context: ctx });
  if (!ids[0]) ids = await execKw<number[]>('res.partner', 'search', [[['name', '=', nomeCliente]]], { limit: 1, context: ctx });
  if (!ids[0]) return null;
  const [partner] = await execKw<OdooPartnerRead[]>('res.partner', 'read', [[ids[0]]], {
    fields: ['name', 'vat', 'street', 'street2', 'zip', 'city', 'country_id'],
    context: ctx,
  });
  return partner || null;
}

async function buscarClienteFiscalMoloni(cliente: Cliente, nomeCliente: string): Promise<MoloniCustomerDetails | null> {
  if (!moloniConfigurado()) return null;
  const email = primeiroEmail(cliente.emails_contato, cliente.emails_usuario);
  const found = await buscarClienteMoloni(nomeCliente, email);
  if (!found?.customer_id) return null;
  return getMoloniCustomerDetails(found.customer_id);
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
  const add = (x: number, y: number, size: number, text: string, bold = false) => {
    pageLines.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`);
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

  add(52, 780, 18, `NOTA DE DEBITO ${args.numero} - IMPOSTOS ADUANEIROS`, true);
  add(52, 758, 13, '(DUTIES & TAXES)', true);
  add(52, 720, 11, 'Shipsmart Global / DARE2BEGIN - Unipessoal Lda.', true);
  add(52, 704, 10, 'NIF: 519023790');
  add(52, 689, 10, 'Rua Serpa Pinto, No 18, 1o andar');
  add(52, 674, 10, '2560-363 Torres Vedras - Portugal');
  add(52, 659, 10, 'E-mail: financeiro@shipsmart.global');

  add(52, 627, 11, 'Destinatario:', true);
  let y = 611;
  for (const line of partnerLines) {
    add(52, y, 10, line);
    y -= 15;
  }

  y -= 14;
  add(52, y, 12, '1. Contexto', true);
  y -= 20;
  y = paragraph(52, y, 10, 'Esta Nota de Debito refere-se exclusivamente aos impostos de importacao (Duties & Taxes) pagos pela Shipsmart/DARE2BEGIN durante o processo de desembaraco aduaneiro, em nome e por conta do cliente. O valor debitado nao constitui receita, sendo apenas o reembolso do montante suportado.');

  y -= 14;
  add(52, y, 12, '2. Impostos (Duties & Taxes) pagos por conta do cliente', true);
  y -= 22;
  add(70, y, 10, '- Tipo de despesa: Impostos aduaneiros (Duties & Taxes)'); y -= 16;
  add(70, y, 10, `- Processo: Desembaraco aduaneiro fora da UE${periodo}.`); y -= 16;
  add(70, y, 10, `- Quantidade: ${args.quantidade || ''} Envios internacionais fora da Uniao Europeia`); y -= 16;
  add(70, y, 10, `- Valor total pago: EUR ${moneyEur(args.total)}`); y -= 32;
  add(52, y, 12, `Total a reembolsar: EUR ${moneyEur(args.total)}`, true);

  y -= 38;
  add(52, y, 12, '3. Condicoes de Pagamento', true);
  y -= 22;
  add(70, y, 10, '- Moeda: EUR'); y -= 16;
  add(70, y, 10, `- Prazo: ${args.prazoDias || 7} dias apos rececao`); y -= 16;
  add(70, y, 10, '- Forma: Transferencia bancaria'); y -= 16;
  add(70, y, 10, '- Referencia: Reembolso - Duties & Taxes (Desembaraco Aduaneiro)');

  y -= 36;
  add(52, y, 12, '4. Observacao Legal', true);
  y -= 20;
  paragraph(52, y, 10, 'Documento nao sujeito a IVA, por corresponder a despesas efetuadas em nome e por conta do cliente (reembolso de encargos aduaneiros). Nao representa prestacao de servicos.');

  const stream = pageLines.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  return buildPdf(objects);
}

export async function GET(req: NextRequest) {
  const faturaId = req.nextUrl.searchParams.get('faturaId');
  if (!faturaId) return NextResponse.json({ error: 'faturaId obrigatorio' }, { status: 400 });

  const [fat] = await query<FaturaFechada>(`SELECT * FROM faturamentos_fechados WHERE fatura_id=$1`, [faturaId]);
  if (!fat) return NextResponse.json({ error: 'Fatura nao encontrada.' }, { status: 404 });
  if (String(fat.pais || '').toUpperCase() !== 'PT') {
    return NextResponse.json({ error: 'PDF de Nota de Debito disponivel apenas para PT.' }, { status: 400 });
  }
  const [cliente] = await query<Cliente>(`SELECT * FROM clientes WHERE cliente_id=$1`, [fat.cliente_id]);
  if (!cliente) return NextResponse.json({ error: 'Cliente nao encontrado.' }, { status: 404 });

  try {
    const detalhes = await fetchDetalhes(req, fat.fatura_id);
    const nonEuDuties = remessasNonEuComImposto(detalhes);
    const total = totalDutiesNonEu(detalhes);
    if (total < 0.01) return NextResponse.json({ error: 'Sem duties/taxes Non-EU para gerar Nota de Debito.' }, { status: 400 });

    const nomeCliente = fat.nome_cliente || cliente.nome;
    const [numero, moloniCustomer, partner] = await Promise.all([
      proximoNumeroNotaDebito().catch(() => 'PREVIEW'),
      buscarClienteFiscalMoloni(cliente, nomeCliente).catch(() => null),
      buscarPartnerOdoo(cliente, nomeCliente).catch(() => null),
    ]);
    const datas = nonEuDuties.map(r => String(r.data || '').slice(0, 10)).filter(Boolean).sort();
    const pdf = criarPdfNotaDebito({
      numero,
      clienteNome: nomeCliente,
      partner,
      moloniCustomer,
      total,
      quantidade: nonEuDuties.length,
      dataInicio: datas[0] || null,
      dataFim: datas[datas.length - 1] || null,
      prazoDias: Number(cliente.dias_vencimento || 7),
    });
    const filename = `Nota de Debito ${numero} - ${fat.num_fatura || fat.fatura_id}.pdf`.replace(/[\\/]/g, '_');
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

