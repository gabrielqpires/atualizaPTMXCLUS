import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { query } from '@/lib/db';
import { calcularValores, converterValorManual, isEnvioManual, isStatusRemessaVisivel, moedaPagamentoCliente } from '@/lib/faturamento';
import { aplicarMediaFrete, aplicarRegras, carregarRegras, getTaxaIntercompany, round2 } from '@/lib/regras';
import type { Remessa, ItemManual } from '@/lib/types';

const FMT_EUR = '#,##0.00 "€"';
const FMT_USD = '"$"#,##0.00';

function fmtNum(pais: string) { return pais === 'PT' ? FMT_EUR : FMT_USD; }
function fmtDate(d: string | null) {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ clienteId: string }> }) {
  const { clienteId } = await params;
  const pais = req.nextUrl.searchParams.get('pais') || 'PT';
  const numFatura = req.nextUrl.searchParams.get('numFatura') || null;

  const [cliente] = await query<{ nome: string; regime: string; moeda_pagamento: string }>(
    `SELECT nome, regime, moeda_pagamento FROM clientes WHERE cliente_id=$1`, [clienteId]
  );
  if (!cliente) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 });

  const regras = await carregarRegras(pais);
  const moedaFat = moedaPagamentoCliente({ moeda_pagamento: cliente.moeda_pagamento, pais });
  const numFmt = fmtNum(pais);
  const taxaPct = getTaxaIntercompany(clienteId, regras);

  // num_fatura é compartilhado entre clientes — sempre filtrar por cliente também
  const remessasAll = numFatura
    ? await query<Remessa>(`SELECT * FROM remessas WHERE num_fatura=$1 AND cliente_id=$2 ORDER BY data`, [numFatura, clienteId])
    : await query<Remessa>(`SELECT * FROM remessas WHERE cliente_id=$1 AND operacao_faturavel=true AND num_fatura IS NULL ORDER BY data`, [clienteId]);
  // Fatura fechada mantém todas as remessas gravadas; em aberto aplica o filtro de status
  const remessas = numFatura ? remessasAll : remessasAll.filter(r => isStatusRemessaVisivel(r.status_codigo, r.status));

  const itensBrutos = numFatura
    ? await query<ItemManual>(`SELECT * FROM itens_manuais WHERE num_fatura=$1 AND cliente_id=$2 ORDER BY criado_em`, [numFatura, clienteId])
    : await query<ItemManual>(`SELECT * FROM itens_manuais WHERE cliente_id=$1 AND num_fatura IS NULL ORDER BY criado_em`, [clienteId]);

  // Calculate per-remessa values + rules, then equalize freight average
  const workItems = remessas.map(r => {
    const ctx = {
      clienteId,
      weightKg: r.weight || 0,
      paisOrigem: pais,
      paisDestino: r.destination || '',
      contratoDescricao: r.contrato_descricao || '',
    };
    const raw = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moedaFat, r.imposto_eur, r.imposto_tipo);
    const ruled = aplicarRegras(raw, ctx, regras);
    return { r, valores: { frete: ruled.frete, imposto: ruled.imposto }, contexto: ctx };
  });
  if (workItems.length > 0) aplicarMediaFrete(clienteId, workItems, regras);
  const rows = workItems.map(({ r, valores }) => ({ r, frete: round2(valores.frete), imposto: round2(valores.imposto) }));

  const ajustes = itensBrutos
    .filter(i => !isEnvioManual(i))
    .map(i => {
      const vf = converterValorManual(i.valor_frete, i.moeda, moedaFat);
      const vi = converterValorManual(i.valor_imposto, i.moeda, moedaFat);
      const tipo = (i.tipo || '').toLowerCase();
      const val = tipo === 'desconto' ? -Math.abs(vf + vi) : (vf + vi);
      return { i, val };
    });

  const workbook = new ExcelJS.Workbook();

  if (pais === 'MX') {
    // Single "Consolidado" sheet with duties col
    const ws = workbook.addWorksheet('Consolidado');
    ws.columns = [
      { width: 5 },  // A
      { width: 35 }, // B - description
      { width: 18 }, // C - AWB
      { width: 12 }, // D - date
      { width: 10 }, // E - weight
      { width: 16 }, // F - freight
      { width: 16 }, // G - duties
    ];

    const hdr = ws.addRow(['', 'Description', 'AWB', 'Date', 'Weight (kg)', 'Freight (USD)', 'Duties (USD)']);
    hdr.font = { bold: true };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const firstDataRow = ws.rowCount + 1;

    for (const { r, frete, imposto } of rows) {
      const row = ws.addRow(['', r.contrato_descricao || r.awb || '', r.awb, fmtDate(r.data), r.weight || '', frete, imposto]);
      (row.getCell(6) as ExcelJS.Cell).numFmt = FMT_USD;
      (row.getCell(7) as ExcelJS.Cell).numFmt = FMT_USD;
    }

    const lastDataRow = ws.rowCount;

    // Seção de ajustes manuais com cabeçalho próprio
    if (ajustes.length > 0) {
      const ajHdr = ws.addRow(['', 'Manual Adjustments', 'Description', 'Date', '', 'Amount (USD)', '']);
      ajHdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ajHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
      for (const { i, val } of ajustes) {
        const row = ws.addRow(['', i.tipo || 'Ajuste', i.descricao || '', fmtDate(i.data), '', val, '']);
        (row.getCell(6) as ExcelJS.Cell).numFmt = FMT_USD;
        if (val < 0) row.getCell(6).font = { color: { argb: 'FFFF4444' } };
      }
    }

    const lastBeforeFeeRow = ws.rowCount;

    // Seção da fee intercompany com cabeçalho próprio
    if (taxaPct > 0 && lastBeforeFeeRow >= firstDataRow) {
      const feeHdr = ws.addRow(['', 'Fees', '', '', '', 'Amount (USD)', '']);
      feeHdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      feeHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
      const feeRow = ws.addRow([
        '',
        `Intercompany Cross-Border Fee (${taxaPct}%)`,
        '', '', '',
        { formula: `(SUM(F${firstDataRow}:F${lastBeforeFeeRow})+SUM(G${firstDataRow}:G${lastDataRow}))*${taxaPct / 100}` },
        '',
      ]);
      feeRow.getCell(6).numFmt = FMT_USD;
      feeRow.getCell(6).font = { bold: true };
    }

    // Total row
    const lastBeforeTotalRow = ws.rowCount;
    const gRange = lastDataRow >= firstDataRow ? `+SUM(G${firstDataRow}:G${lastDataRow})` : '';
    const totalRow = ws.addRow([
      '', 'TOTAL', '', '', '',
      { formula: `SUM(F${firstDataRow}:F${lastBeforeTotalRow})${gRange}` },
      '',
    ]);
    totalRow.getCell(6).numFmt = FMT_USD;
    totalRow.getCell(6).font = { bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    totalRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  } else {
    // PT / US: Consolidado + Ajustes + Resumo sheets
    const wsC = workbook.addWorksheet('Consolidado');
    wsC.columns = [
      { width: 5 },
      { width: 35 },
      { width: 18 },
      { width: 12 },
      { width: 10 },
      { width: 16 },
      { width: 16 },
    ];

    const hdr = wsC.addRow(['', 'Descrição', 'AWB', 'Data', 'Peso (kg)', `Frete (${moedaFat})`, `Imposto (${moedaFat})`]);
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

    const firstDataRow = wsC.rowCount + 1;
    for (const { r, frete, imposto } of rows) {
      const row = wsC.addRow(['', r.contrato_descricao || r.awb || '', r.awb, fmtDate(r.data), r.weight || '', frete, imposto]);
      row.getCell(6).numFmt = numFmt;
      row.getCell(7).numFmt = numFmt;
    }
    const lastDataRow = wsC.rowCount;

    // Totals
    if (lastDataRow >= firstDataRow) {
      const totRow = wsC.addRow(['', 'TOTAL', '', '', '',
        { formula: `SUM(F${firstDataRow}:F${lastDataRow})` },
        { formula: `SUM(G${firstDataRow}:G${lastDataRow})` },
      ]);
      totRow.getCell(6).numFmt = numFmt;
      totRow.getCell(7).numFmt = numFmt;
      totRow.font = { bold: true };
      totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    }

    // Ajustes sheet
    if (ajustes.length > 0) {
      const wsA = workbook.addWorksheet('Ajustes');
      wsA.columns = [{ width: 5 }, { width: 35 }, { width: 16 }, { width: 12 }];
      const ah = wsA.addRow(['', 'Descrição', `Valor (${moedaFat})`, 'Data']);
      ah.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ah.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
      const aFirst = wsA.rowCount + 1;
      for (const { i, val } of ajustes) {
        const row = wsA.addRow(['', i.descricao || i.tipo, val, fmtDate(i.data)]);
        row.getCell(3).numFmt = numFmt;
        if (val < 0) row.getCell(3).font = { color: { argb: 'FFFF4444' } };
      }
      const aLast = wsA.rowCount;
      const totA = wsA.addRow(['', 'Total Ajustes', { formula: `SUM(C${aFirst}:C${aLast})` }, '']);
      totA.getCell(3).numFmt = numFmt;
      totA.font = { bold: true };
    }

    // Resumo sheet
    const wsR = workbook.addWorksheet('Resumo');
    wsR.columns = [{ width: 5 }, { width: 30 }, { width: 18 }];
    const totFrete = rows.reduce((s, x) => s + x.frete, 0);
    const totImposto = rows.reduce((s, x) => s + x.imposto, 0);
    const totAjustes = ajustes.reduce((s, x) => s + x.val, 0);
    const base = totFrete + totImposto + totAjustes;
    const fee = taxaPct > 0 ? Math.round(base * taxaPct) / 100 : 0;
    const total = base + fee;

    const rh = wsR.addRow(['', 'Item', `Valor (${moedaFat})`]);
    rh.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    rh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

    const addResRow = (label: string, val: number) => {
      const row = wsR.addRow(['', label, val]);
      row.getCell(3).numFmt = numFmt;
    };
    addResRow('Frete', totFrete);
    addResRow('Imposto', totImposto);
    if (ajustes.length > 0) addResRow('Ajustes / Descontos', totAjustes);
    if (taxaPct > 0) addResRow(`Intercompany Fee (${taxaPct}%)`, fee);

    const totRow = wsR.addRow(['', 'TOTAL', total]);
    totRow.getCell(3).numFmt = numFmt;
    totRow.font = { bold: true };
    totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  }

  const buf = await workbook.xlsx.writeBuffer();
  const safeName = cliente.nome.replace(/[^a-zA-Z0-9]/g, '_');
  return new NextResponse(buf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Fatura_${pais}_${safeName}.xlsx"`,
    },
  });
}
