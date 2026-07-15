'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Login() {
  const router = useRouter();
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErro(null);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha }),
    });
    setLoading(false);
    if (res.ok) {
      router.push('/');
      router.refresh();
    } else {
      setErro('Senha incorreta.');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={entrar} className="card p-8 w-full max-w-sm space-y-4">
        <div className="text-center">
          <div className="text-3xl mb-2">🔒</div>
          <h1 className="text-lg font-bold">Painel de Faturamento</h1>
          <p className="text-zinc-500 text-sm">Digite a senha para acessar</p>
        </div>
        <input
          type="password"
          placeholder="Senha"
          value={senha}
          onChange={e => setSenha(e.target.value)}
          autoFocus
          required
          className="w-full"
        />
        {erro && <div className="text-red-400 text-sm text-center">{erro}</div>}
        <button type="submit" className="btn btn-primary w-full" disabled={loading || !senha}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
