/**
 * Worker de produção de vídeo.
 *
 * Roda fora da Vercel de propósito: a esteira usa ffmpeg e numpy, e uma rodada
 * leva 10~15 min encadeados — nada disso cabe em função serverless. Aqui é um
 * processo longo-vivo que pega UM job, executa UM passo e devolve pro banco.
 *
 *   npm run worker            # local, contra o .env.local
 *   docker build -t social-hub-worker worker/   # ver worker/README.md
 */
import { eq, sql } from "drizzle-orm";
import { db } from "./compartilhado/db";
import { RENDER_STEPS, type RenderManifest, type RenderStep, workerHeartbeat } from "./compartilhado/db/schema";
import { subirApi } from "./api";
import { preflight } from "./preflight";
import { analisar } from "./steps/analisar";
import { clipes } from "./steps/clipes";
import { compor } from "./steps/compor";
import { imagemBase } from "./steps/imagem-base";
import { montar } from "./steps/montar";
import { publicar } from "./steps/publicar";
import { roteiro } from "./steps/roteiro";
import type { Job, StepFn, StepResult } from "./tipos";

/** Passos já construídos. O que não está aqui ainda não existe na esteira. */
const PASSOS: Partial<Record<RenderStep, StepFn>> = {
  analisar,
  roteiro,
  imagem_base: imagemBase,
  clipes,
  montar,
  compor,
  publicar,
};

const ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const INTERVALO_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
/** Um clipe do Kling leva minutos; só considere morto bem depois disso. */
const LEASE_MIN = Number(process.env.WORKER_LEASE_MIN ?? 20);

let parando = false;

/**
 * Qual passo está em execução agora — lido pelo batimento e pela API.
 *
 * Existe porque o ponto passou a ser batido por um relógio próprio, e o relógio
 * dispara no meio de um passo, quando a função que conhece o passo já saiu de
 * cena.
 */
let passoAtual: string | null = null;

/**
 * De quanto em quanto tempo o worker bate o ponto.
 *
 * Batia junto com a volta do loop — e a volta só acontece ENTRE passos. Como um
 * clipe do Kling leva minutos, o sinal envelhecia justamente enquanto a esteira
 * trabalhava, e o painel anunciava "Worker fora do ar" na hora em que ele estava
 * mais ocupado. Relógio próprio resolve: bate independente do que o passo faz.
 */
const PONTO_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 15_000);

/**
 * Pega um job e trava na mesma transação. `FOR UPDATE SKIP LOCKED` é o que
 * deixa rodar mais de um worker sem os dois pegarem o mesmo job — e vídeo
 * duplicado aqui é crédito de Kling queimado em dobro.
 */
async function pegarJob(): Promise<Job | null> {
  const linhas = await db.execute<{
    id: string; name: string; ref_video_url: string; casting_brief: string | null;
    step: RenderStep; manifest: RenderManifest; cost_cents: number;
  }>(sql`
    UPDATE render_jobs SET
      status = 'running', locked_at = now(), locked_by = ${ID},
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM render_jobs
      WHERE status = 'pending'
         OR (status = 'running' AND locked_at < now() - ${sql.raw(`interval '${LEASE_MIN} minutes'`)})
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, name, ref_video_url, casting_brief, step, manifest, cost_cents
  `);

  const r = linhas[0];
  if (!r) return null;
  return {
    id: r.id, name: r.name, refVideoUrl: r.ref_video_url,
    castingBrief: r.casting_brief, step: r.step,
    manifest: r.manifest ?? {}, costCents: r.cost_cents,
  };
}

/**
 * Bate o ponto. O painel roda na Vercel e o worker aqui na máquina — sem esse
 * sinal, uma rodada criada com o Mac desligado ficaria parada em "na fila" sem
 * nenhuma explicação na tela.
 */
async function baterPonto(passo?: string) {
  await db
    .insert(workerHeartbeat)
    .values({ id: ID, lastSeenAt: new Date(), ultimoPasso: passo ?? null })
    .onConflictDoUpdate({
      target: workerHeartbeat.id,
      set: { lastSeenAt: new Date(), ultimoPasso: passo ?? null },
    })
    .catch(() => undefined);
}

function proximoPasso(atual: RenderStep): RenderStep | null {
  return RENDER_STEPS[RENDER_STEPS.indexOf(atual) + 1] ?? null;
}

/** Concluiu o passo: mescla o manifesto, soma o custo e decide o próximo estado. */
async function concluir(job: Job, r: StepResult) {
  const proximo = r.next ?? proximoPasso(job.step);
  const log = [
    ...(job.manifest.log ?? []),
    { at: new Date().toISOString(), step: job.step, msg: r.msg ?? "ok" },
  ];
  const status = !proximo ? "done" : r.pause ? "waiting_approval" : "pending";

  // O manifesto é mesclado NO BANCO, não em memória.
  //
  // O painel escreve no manifesto enquanto o passo roda — um prompt corrigido,
  // um pedido de take. Gravando `{...job.manifest, ...patch}` o worker punha por
  // cima a cópia que leu lá no claim, e essas escritas sumiam sem deixar rastro.
  // Com `manifest || patch` só as chaves DESTE passo são tocadas.
  //
  // `||` não remove chave: o que o passo apagou (`takePedido: undefined`) sai
  // antes, com o operador `-`.
  const patch: Record<string, unknown> = { ...r.patch, log };
  const apagar = Object.keys(patch).filter((k) => patch[k] === undefined);
  const definir = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const base = apagar.reduce(
    (acc, k) => sql`${acc} - ${k}`,
    sql`manifest`,
  );

  await db.execute(sql`
    UPDATE render_jobs SET
      manifest = (${base}) || ${JSON.stringify(definir)}::jsonb,
      step = ${proximo ?? job.step},
      status = ${status},
      cost_cents = cost_cents + ${r.costCents ?? 0},
      locked_at = NULL, locked_by = NULL, last_error = NULL,
      finished_at = ${status === "done" ? sql`now()` : sql`NULL`},
      updated_at = now()
    WHERE id = ${job.id}
  `);

  console.log(`[${job.name}] ${job.step} → ${status}${proximo ? ` (próximo: ${proximo})` : ""} · ${r.msg ?? ""}`);
}

async function falhar(job: Job, erro: unknown) {
  const msg = erro instanceof Error ? erro.message : String(erro);
  await db.execute(sql`
    UPDATE render_jobs SET
      status = 'failed', last_error = ${msg.slice(0, 2000)},
      locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${job.id}
  `);
  console.error(`[${job.name}] ${job.step} FALHOU: ${msg}`);
}

async function tick() {
  const job = await pegarJob();
  if (!job) return false;

  passoAtual = job.step;
  await baterPonto(job.step);

  const passo = PASSOS[job.step];
  if (!passo) {
    // Honesto em vez de silencioso: a esteira está sendo construída passo a
    // passo, e o painel precisa mostrar exatamente onde ela termina hoje.
    await falhar(job, `passo "${job.step}" ainda não faz parte da esteira construída`);
    return true;
  }

  try {
    await concluir(job, await passo(job));
  } catch (e) {
    await falhar(job, e);
  }
  return true;
}

async function main() {
  try {
    await preflight();
  } catch (e) {
    console.error(`worker NÃO subiu: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // A API sobe DEPOIS do preflight: um container que responde "saudável" sem
  // ffmpeg no PATH é pior que um que não responde — o orquestrador o mantém de
  // pé e todo job que chegar falha.
  subirApi({ id: ID, inicio: Date.now(), passoAtual: () => passoAtual });

  console.log(`${ID} de pé · passos prontos: ${Object.keys(PASSOS).join(", ")}`);
  for (const s of ["SIGINT", "SIGTERM"]) {
    process.on(s, () => {
      console.log("encerrando depois do passo atual…");
      parando = true;
    });
  }
  const relogioDoPonto = setInterval(() => void baterPonto(passoAtual ?? undefined), PONTO_MS);

  while (!parando) {
    const trabalhou = await tick()
      .catch((e) => {
        console.error("erro no loop:", e);
        return false;
      })
      // Zera depois do catch: se o passo morreu, ele também não está mais em
      // andamento, e o ponto passaria a anunciar um passo que já acabou.
      .finally(() => {
        passoAtual = null;
      });
    if (!trabalhou && !parando) await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }
  clearInterval(relogioDoPonto);
  await db.delete(workerHeartbeat).where(eq(workerHeartbeat.id, ID)).catch(() => undefined);
  process.exit(0);
}

main();
