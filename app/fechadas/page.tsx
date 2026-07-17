'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import React from 'react';
import { formatDatePtBR } from '@/lib/dates';

interface Fatura {
  fatura_id: string;
  nome_cliente: string;
  cliente_id: string;
  pais: string;
  num_fatura: string | null;
  data_fechamento: string;
  fechado_por: string | null;
  qtd_awbs: number;
  valor_frete: number;
  valor_imposto: number;
  valor_manual: number;
  valor_total: number;
  moeda: string;
  status: string;
}

interface RemessaDetalhe {
  remessa_id: string;
  awb: string;
  order_id: string | null;
  destination: string | null;
  grupo: string | null;
  weight: number;
  contrato_descricao: string;
  status: string;
  imposto_tipo: string | null;
  data: string;
  valor_frete: number;
  valor_imposto: number;
  moeda: string;
}

interface ItemDetalhe {
  item_id: string;
  descricao: string | null;
  tipo_ajuste: string;
  data: string | null;
  valor: number;
  moeda: string;
}

interface ResumoFatura {
  valor_frete: number;
  valor_imposto: number;
  valor_manual: number;
  taxa_pct: number;
  taxa_intercompany: number;
  valor_total: number;
  moeda: string;
}

function fmt(v: number, moeda: string) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda || 'USD' }).format(v ?? 0);
}

function fmtDate(s: string | null) {
  return formatDatePtBR(s);
}

function FaturaDetalhe({ fatura, onClose, onReaberto }: { fatura: Fatura; onClose: () => void; onReaberto: () => void }) {
  const [remessas, setRemessas] = useState<RemessaDetalhe[]>([]);
  const [itens, setItens] = useState<ItemDetalhe[]>([]);
  const [resumo, setResumo] = useState<ResumoFatura | null>(null);
  const [loading, setLoading] = useState(true);
  const [reabrindo, setReabrindo] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/remessas-fatura?faturaId=${fatura.fatura_id}`)
      .then(r => r.json())
      .then(d => {
        setRemessas(d.remessas || []);
        setItens(d.itens || []);
        setResumo(d.resumo || null);
        setLoading(false);
      });
  }, [fatura.fatura_id]);

  async function reabrir() {
    if (!confirm('Reabrir este faturamento? As remessas voltam para a janela em andamento.')) return;
    setReabrindo(true);
    await fetch('/api/reabrir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faturaId: fatura.fatura_id }),
    });
    setReabrindo(false);
    onReaberto();
  }

  const moeda = resumo?.moeda || fatura.moeda || 'USD';
  const valorFrete = resumo ? resumo.valor_frete : fatura.valor_frete;
  const valorImposto = resumo ? resumo.valor_imposto : fatura.valor_imposto;
  const valorManual = resumo ? resumo.valor_manual : fatura.valor_manual;
  const valorTotal = resumo ? resumo.valor_total : fatura.valor_total;

  return (
    <div className="card p-0 overflow-hidden border-indigo-700/40">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 bg-zinc-800/60 border-b border-zinc-700">
        <div>
          <span className="font-semibold text-base">{fatura.nome_cliente}</span>
          <span className="text-zinc-400 text-sm ml-3">
            Fatura <strong className="text-white mono">{fatura.num_fatura || fatura.fatura_id}</strong>
            {' · '}Fechado em {fmtDate(fatura.data_fechamento)}
            {fatura.fechado_por ? ` por ${fatura.fechado_por}` : ''}
          </span>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/gerar-fatura/${fatura.cliente_id}?pais=${fatura.pais}&numFatura=${fatura.num_fatura || ''}`}
            className="btn text-xs"
            target="_blank" rel="noopener noreferrer"
          >
            ↓ Excel
          </a>
          <button className="btn btn-danger text-xs" onClick={reabrir} disabled={reabrindo}>
            {reabrindo ? 'Reabrindo...' : 'Reabrir'}
          </button>
          <button className="btn text-xs" onClick={onClose}>✕ Fechar</button>
        </div>
      </div>

      {/* Summary line */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3 border-b border-zinc-800 text-sm">
        <span className="text-zinc-400">Frete <strong className="text-white">{fmt(valorFrete, moeda)}</strong></span>
        <span className="text-zinc-400">Imposto <strong className="text-white">{fmt(valorImposto, moeda)}</strong></span>
        {valorManual !== 0 && (
          <span className="text-zinc-400">Manual <strong className={valorManual < 0 ? 'text-red-400' : 'text-white'}>{fmt(valorManual, moeda)}</strong></span>
        )}
        {resumo && resumo.taxa_intercompany > 0 && (
          <span className="text-zinc-400">Cross-Border Fee ({resumo.taxa_pct}%) <strong className="text-white">{fmt(resumo.taxa_intercompany, moeda)}</strong></span>
        )}
        <span className="text-zinc-400">Total <strong className="text-indigo-300 text-base">{fmt(valorTotal, moeda)}</strong></span>
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm py-6 text-center">Carregando...</div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Remessas */}
          <div>
            <div className="flex justify-between items-center mb-1 px-1">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Remessas da fatura</span>
              <span className="text-xs text-zinc-500">{remessas.length} AWB(s)</span>
            </div>
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table>
                <thead>
                  <tr>
                    <th>Created At</th>
                    <th>AWB</th>
                    <th>Order</th>
                    <th>Destination</th>
                    <th>Group</th>
                    <th>Weight</th>
                    <th className="amount">Billed Freight</th>
                    <th className="amount">Duties &amp; Taxes</th>
                    <th>Tax Type</th>
                    <th>Charge Description</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {remessas.map(r => (
                    <tr key={r.remessa_id}>
                      <td className="whitespace-nowrap">{fmtDate(r.data)}</td>
                      <td className="mono whitespace-nowrap">{r.awb}</td>
                      <td className="text-zinc-400">{r.order_id || '—'}</td>
                      <td>{r.destination || '—'}</td>
                      <td><span className={`pill ${r.grupo === 'EU' ? 'pill-ok' : 'pill-warn'}`}>{r.grupo || '—'}</span></td>
                      <td>{r.weight ? Number(r.weight).toFixed(3) : '—'}</td>
                      <td className="amount">{fmt(r.valor_frete, r.moeda || moeda)}</td>
                      <td className="amount">{fmt(r.valor_imposto, r.moeda || moeda)}</td>
                      <td className="text-zinc-400 text-xs">{r.imposto_tipo || '—'}</td>
                      <td className="text-xs max-w-[180px] truncate">{r.contrato_descricao || '—'}</td>
                      <td className="text-zinc-400 text-xs">{r.status || '—'}</td>
                    </tr>
                  ))}
                  {remessas.length === 0 && (
                    <tr><td colSpan={11} className="text-zinc-500 text-center py-4">Sem remessas.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Ajustes */}
          {itens.length > 0 && (
            <div>
              <div className="flex justify-between items-center mb-1 px-1">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Ajustes</span>
                <span className="text-xs text-zinc-500">{itens.length} item(ns)</span>
              </div>
              <div className="overflow-x-auto rounded border border-zinc-800">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Tipo</th>
                      <th>Descrição</th>
                      <th className="amount">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itens.map(i => (
                      <tr key={i.item_id}>
                        <td className="whitespace-nowrap">{fmtDate(i.data)}</td>
                        <td><span className="pill pill-warn">{i.tipo_ajuste}</span></td>
                        <td>{i.descricao || '—'}</td>
                        <td className={`amount font-semibold ${i.tipo_ajuste === 'Desconto' ? 'text-red-400' : 'text-green-400'}`}>
                          {fmt(i.valor, i.moeda || moeda)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FechadasInner() {
  const searchParams = useSearchParams();
  const paisParam = searchParams.get('pais') || 'PT';

  const [pais, setPais] = useState(paisParam);
  const [faturas, setFaturas] = useState<Fatura[]>([]);
  const [total, setTotal] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback((all = false) => {
    setLoading(true);
    setExpandedId(null);
    setShowAll(all);
    const limit = all ? 1000 : 10;
    const params = pais ? `pais=${pais}&limit=${limit}` : `limit=${limit}`;
    fetch(`/api/fechadas?${params}`).then(r => r.json()).then(d => {
      setFaturas(Array.isArray(d.faturas) ? d.faturas : []);
      setTotal(d.total || 0);
      setLoading(false);
      setLoadingAll(false);
    });
  }, [pais]);

  useEffect(() => { load(false); }, [load]);

  const backHref = pais ? `/dashboard/${pais}` : '/';

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href={backHref} className="text-zinc-400 hover:text-white text-sm">← {pais ? pais : 'Países'}</Link>
          <span className="text-zinc-600">/</span>
          <h1 className="text-xl font-bold">Faturamentos Fechados</h1>
        </div>
        <Link href="/" className="btn text-xs">Início</Link>
      </div>

      {/* Country filter */}
      <div className="flex gap-2 mb-5">
        {['PT', 'MX', 'US', 'CL', ''].map(p => (
          <button key={p || 'todos'} onClick={() => setPais(p)}
            className={`btn ${pais === p ? 'bg-indigo-700 border-indigo-500 text-white' : ''}`}>
            {p || 'Todos'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-zinc-400 py-8 text-center">Carregando...</div>
      ) : (
        <div className="card overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Nº Fatura</th>
                <th>Cliente</th>
                <th>País</th>
                <th>Fechado em</th>
                <th>Por</th>
                <th className="amount">AWBs</th>
                <th className="amount">Frete</th>
                <th className="amount">Imposto</th>
                <th className="amount">Manual</th>
                <th className="amount">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {faturas.map(f => (
                <React.Fragment key={f.fatura_id}>
                  <tr
                    className={`cursor-pointer ${expandedId === f.fatura_id ? 'bg-indigo-900/30 border-l-2 border-indigo-500' : ''}`}
                    onClick={() => setExpandedId(expandedId === f.fatura_id ? null : f.fatura_id)}
                  >
                    <td className="mono font-bold">{f.num_fatura || '—'}</td>
                    <td className="font-medium">{f.nome_cliente}</td>
                    <td><span className="pill pill-ok">{f.pais}</span></td>
                    <td className="whitespace-nowrap">{fmtDate(f.data_fechamento)}</td>
                    <td className="text-zinc-400 text-xs">{f.fechado_por || '—'}</td>
                    <td className="amount">{f.qtd_awbs}</td>
                    <td className="amount">{fmt(f.valor_frete, f.moeda)}</td>
                    <td className="amount">{fmt(f.valor_imposto, f.moeda)}</td>
                    <td className={`amount ${f.valor_manual < 0 ? 'text-red-400' : f.valor_manual > 0 ? 'text-green-400' : 'text-zinc-600'}`}>
                      {f.valor_manual !== 0 ? fmt(f.valor_manual, f.moeda) : '—'}
                    </td>
                    <td className="amount font-bold text-indigo-300">{fmt(f.valor_total, f.moeda)}</td>
                    <td><span className={`pill ${f.status === 'fechado' ? 'pill-ok' : 'pill-warn'}`}>{f.status}</span></td>
                  </tr>
                  {expandedId === f.fatura_id && (
                    <tr>
                      <td colSpan={11} className="p-0 border-b border-zinc-800">
                        <div className="p-3 bg-zinc-950">
                          <FaturaDetalhe
                            fatura={f}
                            onClose={() => setExpandedId(null)}
                            onReaberto={() => { setExpandedId(null); load(false); }}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {faturas.length === 0 && (
                <tr><td colSpan={11} className="text-zinc-500 text-center py-6">Nenhum faturamento fechado{pais ? ` para ${pais}` : ''}.</td></tr>
              )}
            </tbody>
          </table>
          {!showAll && faturas.length < total && (
            <div className="flex gap-3 px-4 py-3 border-t border-zinc-800">
              <button
                className="btn text-xs"
                disabled={loadingAll}
                onClick={() => { setLoadingAll(true); load(true); }}
              >
                {loadingAll ? 'Carregando...' : `Ver todas (${total})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Fechadas() {
  return (
    <Suspense fallback={<div className="text-zinc-400 py-8 text-center">Carregando...</div>}>
      <FechadasInner />
    </Suspense>
  );
}
