import Link from 'next/link';

const PAISES = [
  { code: 'PT', nome: 'Portugal',       flag: '🇵🇹' },
  { code: 'US', nome: 'Estados Unidos', flag: '🇺🇸' },
  { code: 'CL', nome: 'Chile',          flag: '🇨🇱' },
  { code: 'MX', nome: 'México',         flag: '🇲🇽' },
];

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="text-xs text-zinc-500 mb-2 tracking-widest uppercase">ShipSmart / Faturamento</div>
      <h1 className="text-3xl font-bold mb-2">Painel de Faturamento</h1>
      <p className="text-zinc-400 mb-10">Escolha o país para gerenciar clientes, remessas e ajustes.</p>

      <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
        {PAISES.map(p => (
          <Link
            key={p.code}
            href={`/dashboard/${p.code}`}
            className="flex flex-col items-center justify-center gap-3 p-6 rounded-xl border border-zinc-700 bg-zinc-900 hover:border-indigo-500 hover:bg-zinc-800 transition-all cursor-pointer"
          >
            <span className="text-5xl">{p.flag}</span>
            <strong className="text-base">{p.nome}</strong>
          </Link>
        ))}
      </div>

      <div className="mt-10 flex gap-3">
        <Link href="/fechadas" className="btn text-xs">Faturas fechadas</Link>
        <Link href="/pendentes" className="btn text-xs">Pendentes</Link>
        <Link href="/cadastro" className="btn text-xs">Clientes</Link>
        <Link href="/cambio" className="btn text-xs">Cambio</Link>
      </div>
    </div>
  );
}
