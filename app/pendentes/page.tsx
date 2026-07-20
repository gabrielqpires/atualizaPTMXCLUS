'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { formatDatePtBR } from '@/lib/dates';

interface Pendente {
  remessa_id: string;
  awb: string;
  email: string;
  pais: string;
  contrato_descricao: string;
  weight: number;
  status: string;
  data: string;
  moeda: string;
  valor_frete: number;
  valor_imposto: number;
}

interface ClienteOpt {
  cliente_id: string;
  nome: string;
  pais: string;
}

function fmt(v: number, moeda: string) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda || 'USD' }).format(v ?? 0);
}

function fmtDate(s: string | null) {
  return formatDatePtBR(s);
}

function PendentesInner() {
  const searchParams = useSearchParams();
  const paisParam = searchParams.get('pais') || 'PT';

  const [pais, setPais] = useState(paisParam);
  const [rows, setRows] = useState<Pendente[]>([]);
  const [clientes, setClientes] = useState<ClienteOpt[]>([]);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/pendentes?pais=${pais}`).then(r => r.json()).then(d => {
      setRows(Array.isArray(d) ? d : []);
      setLoading(false);
    });
  }, [pais]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/clientes?all=1').then(r => r.json()).then(d => setClientes(Array.isArray(d) ? d : []));
  }, []);

  async function assign(remessaId: string) {
    const clienteId = sel[remessaId];
    if (!clienteId) { alert('Selecione um cliente.'); return; }
    setBusy(remessaId);
    const res = await fetch('/api/pendentes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'assign', remessaId, clienteId }),
    }).then(r => r.json());
    setBusy(null);
    if (res.ok) load();
    else alert('Erro: ' + (res.error || 'desconhecido'));
  }

  async function ignorar(awb: string) {
    if (!confirm(`Ignorar remessa ${awb}? Ela não aparecerá mais como pendente.`)) return;
    setBusy(awb);
    const res = await fetch('/api/pendentes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ignore', awb }),
    }).then(r => r.json());
    setBusy(null);
    if (res.ok) load();
    else alert('Erro: ' + (res.error || 'desconhecido'));
  }

  // Cria conta a receber no Odoo (+ liquidação no Stripe). Se o parceiro não
  // existir, abre uma caixinha pedindo o nome e cria o cadastro (e-mail = do user).
  async function criarOdoo(remessaId: string, nome?: string) {
    setBusy('odoo-' + remessaId);
    const res = await fetch('/api/odoo/criar-ar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remessaId, nome }),
    }).then(r => r.json());
    setBusy(null);
    if (res.needsName) {
      const n = window.prompt(`Cliente não cadastrado no Odoo${res.email ? ` (${res.email})` : ''}.\nDigite o nome do cliente para criar o cadastro:`);
      if (n && n.trim()) return criarOdoo(remessaId, n.trim());
      return;
    }
    if (res.ok) {
      alert(`Conta a receber criada e liquidada no Odoo ✓\nFatura ${res.numero} — total ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: res.moeda || 'MXN' }).format(res.total)} (${res.pagamento})`);
    } else {
      alert('Erro Odoo: ' + (res.error || 'desconhecido'));
    }
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Link href={`/dashboard/${pais}`} className="text-zinc-400 hover:text-white text-sm">← {pais}</Link>
          <span className="text-zinc-600">/</span>
          <h1 className="text-xl font-bold">Remessas não identificadas</h1>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary text-xs" onClick={load}>Atualizar</button>
          <Link href="/" className="btn text-xs">Início</Link>
        </div>
      </div>
      <p className="text-zinc-500 text-sm mb-5">Remessas sem cliente vinculado. O país pode vir do contrato mesmo antes da atribuição manual.</p>

      <div className="flex gap-2 mb-5">
        {['PT', 'MX', 'US', 'CL'].map(p => (
          <button key={p} onClick={() => setPais(p)}
            className={`btn ${pais === p ? 'bg-indigo-700 border-indigo-500 text-white' : ''}`}>
            {p}
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
                <th>AWB</th>
                <th>Created At</th>
                <th>Email</th>
                <th>País</th>
                <th>Contrato</th>
                <th className="amount">Frete</th>
                <th className="amount">Imposto</th>
                <th>Status</th>
                <th>Atribuir</th>
                <th></th>
                <th></th>
                {pais === 'MX' && <th>Odoo</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.remessa_id}>
                  <td className="mono whitespace-nowrap">{r.awb}</td>
                  <td className="whitespace-nowrap">{fmtDate(r.data)}</td>
                  <td className="text-xs">{r.email || '—'}</td>
                  <td><span className="pill pill-ok">{r.pais || '—'}</span></td>
                  <td className="text-xs max-w-[200px] truncate">{r.contrato_descricao || '—'}</td>
                  <td className="amount">{fmt(r.valor_frete, r.moeda)}</td>
                  <td className="amount">{fmt(r.valor_imposto, r.moeda)}</td>
                  <td className="text-zinc-400 text-xs">{r.status || '—'}</td>
                  <td>
                    <select
                      value={sel[r.remessa_id] || ''}
                      onChange={e => setSel(s => ({ ...s, [r.remessa_id]: e.target.value }))}
                      className="max-w-[220px]"
                    >
                      <option value="">Selecione</option>
                      {clientes.map(c => (
                        <option key={c.cliente_id} value={c.cliente_id}>{c.nome} ({c.pais})</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="btn btn-primary text-xs" disabled={busy === r.remessa_id} onClick={() => assign(r.remessa_id)}>OK</button>
                  </td>
                  <td>
                    <button className="btn btn-danger text-xs" disabled={busy === r.awb} onClick={() => ignorar(r.awb)} title="Ignorar esta remessa">Ignorar</button>
                  </td>
                  {pais === 'MX' && (
                    <td>
                      <button
                        className="btn text-xs whitespace-nowrap"
                        disabled={busy === 'odoo-' + r.remessa_id}
                        onClick={() => criarOdoo(r.remessa_id)}
                        title="Criar conta a receber no Odoo e liquidar no Stripe"
                      >
                        {busy === 'odoo-' + r.remessa_id ? '...' : '+ Odoo'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={pais === 'MX' ? 12 : 11} className="text-zinc-500 text-center py-6">Nenhuma remessa pendente.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Pendentes() {
  return (
    <Suspense fallback={<div className="text-zinc-400 py-8 text-center">Carregando...</div>}>
      <PendentesInner />
    </Suspense>
  );
}
