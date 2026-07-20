'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type CambioApi = {
  taxas: Record<string, number>;
  padrao: Record<string, number>;
  pares: string[];
  principais: string[];
};

const fallbackPares = [
  'EUR>USD', 'USD>EUR',
  'EUR>MXN', 'MXN>EUR',
  'USD>MXN', 'MXN>USD',
  'USD>BRL', 'BRL>USD',
  'EUR>BRL', 'BRL>EUR',
  'BRL>MXN', 'MXN>BRL',
];

const fallbackPrincipais = ['EUR>USD', 'EUR>MXN', 'USD>MXN', 'USD>BRL', 'EUR>BRL', 'BRL>MXN'];

function inverso(par: string) {
  const [origem, destino] = par.split('>');
  return `${destino}>${origem}`;
}

function formatTaxa(value: number | string | undefined) {
  if (value === undefined || value === '') return '';
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : '';
}

export default function CambioPage() {
  const [data, setData] = useState<CambioApi | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const principais = useMemo(() => data?.principais?.length ? data.principais : fallbackPrincipais, [data]);
  const pares = useMemo(() => data?.pares?.length ? data.pares : fallbackPares, [data]);

  useEffect(() => {
    let alive = true;
    fetch('/api/cambio')
      .then(res => res.json())
      .then((json: CambioApi & { error?: string }) => {
        if (!alive) return;
        if (json.error) throw new Error(json.error);
        setData(json);
        const next: Record<string, string> = {};
        for (const par of json.pares || fallbackPares) {
          next[par] = formatTaxa(json.taxas?.[par] ?? json.padrao?.[par]);
        }
        setRates(next);
      })
      .catch(err => {
        if (alive) setMsg({ kind: 'err', text: `Erro ao carregar cambio: ${err.message}` });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  function syncRate(par: string, value: string) {
    setRates(prev => {
      const next = { ...prev, [par]: value };
      const taxa = Number(value);
      const inv = inverso(par);
      if (Number.isFinite(taxa) && taxa > 0) next[inv] = (1 / taxa).toFixed(6);
      return next;
    });
  }

  async function salvar(reset = false) {
    setSaving(true);
    setMsg(null);
    try {
      const taxas: Record<string, number> = {};
      for (const par of pares) taxas[par] = Number(rates[par]);
      const res = await fetch('/api/cambio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reset ? { reset: true } : { taxas }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Falha ao salvar');
      const next: Record<string, string> = {};
      for (const par of pares) next[par] = formatTaxa(json.taxas?.[par]);
      setRates(next);
      setMsg({ kind: 'ok', text: reset ? 'Taxas padrao restauradas.' : 'Taxas salvas com sucesso.' });
    } catch (err) {
      setMsg({ kind: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs text-zinc-500 mb-2 tracking-widest uppercase">ShipSmart / Faturamento</div>
            <h1 className="text-3xl font-bold">Taxas de cambio</h1>
            <p className="text-sm text-zinc-400 mt-2">
              Configuracao usada para converter frete, impostos, itens manuais e Excel.
            </p>
          </div>
          <Link href="/" className="btn w-fit">Inicio</Link>
        </header>

        {msg && (
          <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            msg.kind === 'ok'
              ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
              : 'border-red-700 bg-red-950/50 text-red-200'
          }`}>
            {msg.text}
          </div>
        )}

        <section className="card overflow-hidden">
          <div className="border-b border-zinc-800 px-5 py-4">
            <h2 className="text-lg font-semibold">Pares principais</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Edite o par principal; o inverso e calculado automaticamente.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Par</th>
                  <th className="text-right">Taxa</th>
                  <th></th>
                  <th>Inverso</th>
                  <th className="text-right">Taxa</th>
                </tr>
              </thead>
              <tbody>
                {principais.map(par => {
                  const inv = inverso(par);
                  const destino = par.split('>')[1];
                  const invDestino = inv.split('>')[1];
                  return (
                    <tr key={par}>
                      <td className="font-semibold">{par}</td>
                      <td className="min-w-36">
                        <input
                          type="number"
                          min="0"
                          step="0.000001"
                          value={rates[par] || ''}
                          disabled={loading || saving}
                          onChange={e => syncRate(par, e.target.value)}
                          className="text-right font-mono"
                        />
                      </td>
                      <td className="text-xs text-zinc-500">{destino}</td>
                      <td className="text-zinc-400">{inv}</td>
                      <td className="min-w-32">
                        <input
                          type="number"
                          value={rates[inv] || ''}
                          readOnly
                          className="text-right font-mono text-zinc-400 opacity-80"
                        />
                      </td>
                      <td className="text-xs text-zinc-500">{invDestino}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-3 border-t border-zinc-800 px-5 py-4">
            <button className="btn btn-primary" disabled={loading || saving} onClick={() => salvar(false)}>
              {saving ? 'Salvando...' : 'Salvar'}
            </button>
            <button className="btn" disabled={loading || saving} onClick={() => salvar(true)}>
              Restaurar padrao
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
