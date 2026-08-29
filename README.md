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
| `imagem_base` | gera o rosto novo (GPT Image 2) | ~US$ 0,06 |
| `clipes` | gera um clipe por vez, encadeando o último frame do anterior | **US$ 0,08–0,11 por segundo** |
| `montar` | tira as pausas mortas da fala e costura os clipes | local |
| `compor` | remonta a edição do original sobre o avatar novo | local |
| `publicar` | cria o rascunho do post | — |

`clipes` é o passo caro. Ele para pra você conferir o prompt antes de cada
geração, e é isso que impede um prompt errado virar dinheiro.

## Subir no EasyPanel

É o caminho usado aqui. O EasyPanel constrói direto do GitHub — não use o
`docker-compose.yml`, ele é ignorado (serve pro caminho de Docker puro, mais
abaixo).

**1. Criar o serviço**

Project → **+ Service** → **App**. Nome: `esteira`.

**2. Source**

- Provider: **GitHub** (o repo é público, não precisa conectar conta)
- Owner `Gusdev06` · Repository `social-hub-worker` · Branch `main`

**3. Build**

Método: **Dockerfile**, caminho `Dockerfile`. Isto é obrigatório — no padrão
(Nixpacks) a imagem sai sem ffmpeg e sem numpy, e o preflight derruba o
container na largada com "faltam ferramentas no PATH".

**4. Environment**

Cole as quatro. Saem do `.env.local` do painel:

```
DATABASE_URL=            # use a string do POOLER (porta 6543)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
WAVESPEED_API_KEY=
```

**5. Deploy**

Botão **Deploy**. O primeiro build leva alguns minutos (apt + npm ci). Nos logs
espere:

```
worker-… de pé · passos prontos: analisar, roteiro, …
api de saúde na porta 8080
```

**6. O que o compose fazia e agora é você quem configura**

O `docker-compose.yml` trazia proteções que o EasyPanel não lê. Os equivalentes:

| proteção | onde fica no EasyPanel |
|---|---|
| teto de CPU e memória | aba **Resources** — sem isso um render ocupa a VPS inteira |
| reinício automático | é o padrão do EasyPanel, não precisa mexer |
| health check | aba **Advanced**, caminho `/saude`, porta `8080` |
| rotação de log | gerenciada pelo EasyPanel |

**Domínio é opcional.** A esteira não recebe chamada de ninguém — ela lê a fila
no Postgres. Só publique `/saude` e `/status` se quiser olhar de fora, e nesse
caso ponha senha: a API não tem autenticação e a fila revela quanto você gasta.

**Atualizar:** cada push na `main` → botão **Deploy** (ou ligue o auto-deploy no
Source). Rodada em andamento não se perde: o passo interrompido volta pra fila e
é retomado quando o lease vence.

## Subir com Docker puro (sem EasyPanel)

### Pela linha de comando

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
git clone https://github.com/Gusdev06/social-hub-worker.git && cd social-hub-worker
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
