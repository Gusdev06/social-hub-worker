# social-hub-worker

A esteira que produz os vídeos. Saiu da máquina do Gusta em 28/08/2026 e passou
a rodar num container na VPS.

O painel (repo `social-hub`, na Vercel) **não fala com este serviço por HTTP**.
Os dois se encontram no Postgres do Supabase: o painel escreve uma rodada em
`render_jobs`, o worker lê, executa um passo por vez e escreve o resultado de
volta. Se a VPS cair, o painel continua aceitando rodadas — elas só ficam na
fila até alguém religar aqui.

## Os passos

```
analisar → roteiro → imagem_base → clipes → montar → compor → publicar
```

| passo | o que faz | onde gasta |
|---|---|---|
| `analisar` | mede a estrutura do criativo de referência: cortes, faixas, papéis | local (ffmpeg + numpy) |
| `roteiro` | transcreve (Whisper), pontua (Kimi K3) e fatia em clipes | ~US$ 0,01 |
| `imagem_base` | gera o rosto novo (Seedream) | ~US$ 0,05 |
| `clipes` | gera um clipe por vez, encadeando o último frame do anterior | **US$ 0,08–0,11 por segundo** |
| `montar` | tira as pausas mortas da fala e costura os clipes | local |
| `compor` | remonta a edição do original sobre o avatar novo | local |
| `publicar` | cria o rascunho do post | — |

`clipes` é o passo caro. Ele para pra você conferir o prompt antes de cada
geração, e é isso que impede um prompt errado virar dinheiro.

## Subir na VPS da Hostinger

**Não funciona em hospedagem compartilhada.** Precisa de ffmpeg, python+numpy e
um processo vivo o tempo todo — nada disso existe em plano compartilhado. Use um
plano **VPS**. O KVM 2 (2 vCPU / 8 GB) dá conta; com 1 vCPU o `compor` fica lento
mas roda.

### 1. Docker na VPS

```bash
ssh root@SEU_IP
curl -fsSL https://get.docker.com | sh
```

Alguns templates da Hostinger já vêm com Docker — `docker --version` responde.

### 2. Código e variáveis

```bash
git clone SEU_REPO social-hub-worker && cd social-hub-worker
cp .env.example .env
nano .env          # cole os valores do .env.local do painel
```

As quatro obrigatórias são `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` e `WAVESPEED_API_KEY`. Em `DATABASE_URL` use a
string do **pooler** (porta 6543): o worker mantém conexão longa e é o pooler
que aguenta isso.

### 3. Subir

```bash
docker compose up -d --build
docker compose logs -f
```

Você deve ver `worker-… de pé · passos prontos: …`. Se aparecer
`worker NÃO subiu: faltam ferramentas no PATH`, a imagem foi montada errada — o
preflight roda antes de aceitar qualquer job justamente pra isso.

### 4. Conferir

```bash
curl localhost:8080/saude     # vivo? não toca no banco
curl localhost:8080/status    # fila, gasto acumulado, última rodada
```

O painel também passa a mostrar `● worker de pé`, alimentado pelo sinal em
`worker_heartbeat`.

### Atualizar

```bash
git pull && docker compose up -d --build
```

O container reinicia entre passos. Uma rodada em andamento não se perde: o
passo interrompido volta pra fila e é retomado quando o lease vence.

## API

Só leitura, sem autenticação — não dispara trabalho e não devolve segredo. Ainda
assim o `docker-compose.yml` publica só no loopback: a fila revela quanto você
gasta. Pra ver de fora, ponha atrás do proxy da Hostinger com senha.

- `GET /saude` — vivo, id do worker, há quanto tempo de pé, passo atual
- `GET /status` — o mesmo + contagem da fila, gasto acumulado e última rodada

`/saude` responde sem tocar no banco de propósito: uma oscilação do Postgres não
pode derrubar um container que está funcionando.

## `src/compartilhado/` — o contrato com o painel

Estes arquivos são **cópia** do repo `social-hub`:

```
compartilhado/db/index.ts      conexão
compartilhado/db/schema.ts     tabelas + o tipo RenderManifest
compartilhado/lib/llm.ts       Kimi K3 (llm.wavespeed.ai)
compartilhado/lib/casting.ts   nota de casting e prompt de clipe
compartilhado/lib/roteiro.ts   pontuação e alinhamento da transcrição
compartilhado/lib/storage.ts   upload no Supabase Storage
compartilhado/lib/modelos-video.ts  Kling / Wan / MiniMax e seus adaptadores
```

**Mudou o `RenderManifest` de um lado? Mude do outro na mesma hora.** Os dois
repos leem e escrevem o mesmo jsonb, e uma divergência aqui não dá erro de
compilação em lugar nenhum — aparece como campo que some sozinho, meses depois.

Se isso incomodar, a alternativa é deletar este repo e rodar o container a partir
do próprio `social-hub`, que já tem um Dockerfile equivalente. Some a duplicação,
volta o acoplamento.

## Local

```bash
npm install
cp .env.example .env
npm run dev
```

Precisa de `ffmpeg`, `ffprobe`, `python3` e `numpy` no PATH — o preflight reclama
com o caminho na mensagem se faltar algum.
