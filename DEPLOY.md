# Deploy — painel-intl

Painel internacional de faturamento (Next.js + Postgres). Produção na Vercel com
sync automático do Metabase via GitHub Actions.

- **Repo:** https://github.com/gabrielqpires/atualizaPTMXCLUS
- **Produção:** https://painel-intl.vercel.app (projeto Vercel `painel-intl`)

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Valor |
|---|---|
| `DATABASE_URL` | string de conexão do Postgres/Supabase |
| `MB_BASE_URL` | `https://shipsmart.metabaseapp.com` |
| `MB_USERNAME` | usuário do Metabase |
| `MB_PASSWORD` | senha do Metabase |
| `MB_CARD_ID` | id da saved question |
| `MB_FROM_DATE` | data de corte, opcional (default `2026-05-01`) |
| `CRON_SECRET` | segredo do endpoint de sync (`/api/sync`) |
| `PANEL_PASSWORD` | senha da tela de login do painel |

> `MB_USERNAME/PASSWORD/CARD_ID` estão no Apps Script antigo em
> **Configurações do projeto → Propriedades do script**.
> Depois de alterar env vars, é preciso re-deployar (`npx vercel --prod --yes`).

## Proteção por senha

Todo o painel (páginas e APIs) exige login definido por `PANEL_PASSWORD`
(cookie de 30 dias). Exceções: `/login`, `/api/login` e `GET /api/sync`
(protegido pelo próprio `CRON_SECRET`). Sem `PANEL_PASSWORD` configurada
(ex.: dev local), nada é bloqueado.

## Sync automático (GitHub Actions, 1x por hora)

Workflow: `.github/workflows/sync.yml` — chama `GET /api/sync` com
`Authorization: Bearer <CRON_SECRET>`. Cadência horária ≈ 720 min/mês,
dentro dos 2.000 grátis de repo privado.

Secrets necessários no repo (**Settings → Secrets and variables → Actions**):

- `SYNC_URL` = `https://painel-intl.vercel.app`
- `CRON_SECRET` = mesmo valor da env var na Vercel

Rodar na mão: aba **Actions** → *Sync Metabase (1h)* → **Run workflow**,
ou o botão **Sincronizar** dentro do painel.

## Deploy

Via CLI (funciona hoje): `npx vercel --prod --yes` na pasta do projeto.

Auto-deploy por push: conectar o repo em
**Vercel → painel-intl → Settings → Git** (requer autorizar o GitHub App da Vercel).

## Testar

```bash
# endpoint do cron (troque <CRON_SECRET>)
curl "https://painel-intl.vercel.app/api/sync?secret=<CRON_SECRET>"
```

No painel: login → botão **Sincronizar** → deve mostrar
"Processadas / Novas / Atualizadas" e atualizar a linha **Última sync**.
