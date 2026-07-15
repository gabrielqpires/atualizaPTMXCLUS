# Deploy — painel-intl

Painel internacional de faturamento (Next.js + Postgres). Deploy na Vercel com
sync automático do Metabase a cada 10 min.

## 1. Subir para o GitHub

O repositório já está inicializado localmente com um commit. Crie o repo no
GitHub (recomendado: **privado**) e faça o push:

```bash
# no diretório painel-intl
git remote add origin https://github.com/<seu-usuario>/painel-intl.git
git branch -M main
git push -u origin main
```

## 2. Conectar na Vercel

1. vercel.com → **Add New → Project** → importe o repo `painel-intl`.
2. Framework: Next.js (detectado automaticamente).
3. Em **Environment Variables**, adicione:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | (mesma string do `.env.local`) |
| `MB_BASE_URL` | URL base do Metabase (ex: `https://metabase.suaempresa.com`) |
| `MB_USERNAME` | usuário do Metabase |
| `MB_PASSWORD` | senha do Metabase |
| `MB_CARD_ID` | id da saved question (ex: `15893`) |
| `MB_FROM_DATE` | data de corte, opcional (default `2026-05-01`) |
| `CRON_SECRET` | `82d15851c6a871779026d0787e7bae35cee570d8934fa0a9` |

> As credenciais `MB_*` estão no Apps Script antigo em
> **Configurações do projeto → Propriedades do script**.

4. **Deploy**. Push na `main` re-deploya automaticamente.

## 3. Gatilho do sync a cada 10 min

O endpoint é `GET /api/sync` e exige o header `Authorization: Bearer <CRON_SECRET>`
(ou `?secret=<CRON_SECRET>` na URL).

### Opção A — cron-job.org (recomendado, grátis, qualquer plano Vercel)

1. Crie conta em https://cron-job.org.
2. **Create cronjob**:
   - URL: `https://<seu-deploy>.vercel.app/api/sync?secret=82d15851c6a871779026d0787e7bae35cee570d8934fa0a9`
   - Schedule: a cada 10 minutos (`*/10`).
3. Salvar. Pronto — roda de 10 em 10 min de forma confiável.

### Opção B — GitHub Actions (`.github/workflows/sync.yml`, já incluso)

Em **Settings → Secrets and variables → Actions** do repo, crie:
- `SYNC_URL` = `https://<seu-deploy>.vercel.app`
- `CRON_SECRET` = `82d15851c6a871779026d0787e7bae35cee570d8934fa0a9`

⚠️ Em repo **privado** consome ~4.300 min/mês (acima dos 2.000 grátis) e o
agendador pode atrasar. Use só se o repo for público.

### Opção C — Vercel Cron (`vercel.json`, já incluso)

Funciona de 10 em 10 min **apenas no plano Pro**. No Hobby, roda 1x/dia.
Se ficar no Hobby, apague o `vercel.json` e use a Opção A.

## 4. Testar

- Abra o painel → botão **Sincronizar** (sync manual). Deve mostrar
  "Processadas / Novas / Atualizadas" e atualizar a linha **Última sync**.
- Ou via curl:
  ```bash
  curl "https://<seu-deploy>.vercel.app/api/sync?secret=82d15851c6a871779026d0787e7bae35cee570d8934fa0a9"
  ```
