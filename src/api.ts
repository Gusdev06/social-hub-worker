import { createServer } from "node:http";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "./compartilhado/db";
import { renderJobs, workerHeartbeat } from "./compartilhado/db/schema";

/**
 * A superfície HTTP do worker.
 *
 * A esteira em si não precisa de HTTP: o painel escreve no Postgres e o worker
 * lê de lá. Isto existe por dois motivos operacionais, que só aparecem quando o
 * worker sai da máquina do dono e vira um container num servidor:
 *
 *  - o orquestrador (Docker, a VPS, um uptime monitor) precisa de um endereço
 *    pra saber se está vivo — sem isso "reiniciar se cair" não tem gatilho;
 *  - quando algo trava, não há terminal pra abrir. `/status` responde o que o
 *    `tail -f` respondia antes.
 *
 * É SÓ LEITURA e sem autenticação de propósito: nada aqui dispara trabalho nem
 * revela segredo. Ainda assim, publique atrás do proxy da VPS, não na internet
 * aberta — a fila diz quanto você gasta.
 */
export function subirApi(estado: {
  id: string;
  inicio: number;
  passoAtual: () => string | null;
}): void {
  const porta = Number(process.env.PORT ?? 8080);

  const servidor = createServer(async (req, res) => {
    const rota = (req.url ?? "/").split("?")[0];
    const responder = (codigo: number, corpo: unknown) => {
      res.writeHead(codigo, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(corpo, null, 2));
    };

    // Health check: responde sem tocar no banco, senão uma oscilação do Postgres
    // derruba o container que está perfeitamente vivo.
    if (rota === "/saude" || rota === "/health") {
      return responder(200, {
        ok: true,
        id: estado.id,
        dePeHaSegundos: Math.round((Date.now() - estado.inicio) / 1000),
        passoAtual: estado.passoAtual(),
      });
    }

    if (rota === "/status") {
      try {
        const [fila] = await db
          // `::int` porque `count()` e `sum()` são bigint, e o driver entrega
          // bigint como STRING pra não perder precisão. Sem o cast a API
          // devolvia `"pendentes": "0"` — e quem consome faz `> 0` numa string.
          .select({
            pendentes: sql<number>`(count(*) filter (where status = 'pending'))::int`,
            rodando: sql<number>`(count(*) filter (where status = 'running'))::int`,
            esperando: sql<number>`(count(*) filter (where status = 'waiting_approval'))::int`,
            falhas: sql<number>`(count(*) filter (where status = 'failed'))::int`,
            gastoCents: sql<number>`coalesce(sum(cost_cents), 0)::int`,
          })
          .from(renderJobs);

        const [ultima] = await db
          .select({ nome: renderJobs.name, status: renderJobs.status, passo: renderJobs.step })
          .from(renderJobs)
          .orderBy(desc(renderJobs.updatedAt))
          .limit(1);

        const [ponto] = await db
          .select()
          .from(workerHeartbeat)
          .where(eq(workerHeartbeat.id, estado.id));

        return responder(200, {
          worker: { id: estado.id, passoAtual: estado.passoAtual(), ultimoPonto: ponto?.lastSeenAt ?? null },
          fila,
          ultimaRodada: ultima ?? null,
        });
      } catch (e) {
        // 503, não 500: o worker está de pé, quem não respondeu foi o banco.
        return responder(503, { ok: false, erro: (e as Error).message });
      }
    }

    responder(404, { erro: "rotas: /saude, /status" });
  });

  servidor.listen(porta, () => console.log(`api de saúde na porta ${porta}`));
}
