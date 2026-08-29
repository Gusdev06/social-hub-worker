/**
 * Cliente do WaveSpeed. O CLI existe na máquina do Gusta, mas o container não
 * tem — e a API é simples o bastante: POST cria a predição, GET devolve o
 * resultado quando fica pronto.
 */
const BASE = "https://api.wavespeed.ai/api/v3";

function chave(): string {
  const k = process.env.WAVESPEED_API_KEY;
  if (!k) throw new Error("WAVESPEED_API_KEY não configurada");
  return k;
}

export type Predicao = { id: string; outputs: string[]; bruto: unknown };

/**
 * O envelope do WaveSpeed. Tipado à mão porque `Response.json()` devolve
 * `unknown`: sem isto o código lia `corpo.data.id` só porque o compilador do
 * Next era mais frouxo, e um campo renomeado do outro lado viraria
 * `undefined` silencioso em vez de erro.
 */
type Envelope = {
  code?: number;
  message?: string;
  data?: {
    id?: string;
    status?: string;
    outputs?: string[];
    error?: string;
  };
};

/**
 * Roda um modelo e espera o resultado. Um clipe do Kling leva minutos, então o
 * poll é longo de propósito — desistir cedo não cancela o job lá, só perde o
 * resultado de algo que já foi cobrado.
 */
export async function rodar(
  modelo: string,
  input: Record<string, unknown>,
  { timeoutMs = 15 * 60_000, intervaloMs = 4000 } = {},
): Promise<Predicao> {
  const criar = await fetch(`${BASE}/${modelo}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${chave()}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const corpo = (await criar.json()) as Envelope;
  if (!criar.ok || corpo?.code !== 200) {
    throw new Error(`${modelo}: ${corpo?.message ?? criar.status}`);
  }

  const id = corpo.data?.id;
  if (!id) throw new Error(`${modelo}: resposta sem id de predição`);
  const limite = Date.now() + timeoutMs;

  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, intervaloMs));

    const r = await fetch(`${BASE}/predictions/${id}/result`, {
      headers: { Authorization: `Bearer ${chave()}` },
    });
    const d = ((await r.json()) as Envelope)?.data;
    if (!d) continue;

    if (d.status === "completed") return { id, outputs: d.outputs ?? [], bruto: d };
    if (d.status === "failed") throw new Error(`${modelo} falhou: ${d.error ?? "sem detalhe"}`);
  }

  throw new Error(`${modelo} não terminou em ${Math.round(timeoutMs / 60000)} min (id ${id})`);
}

/**
 * Preço de tabela dos modelos de passo único, em centavos de dólar — serve pro
 * custo aparecer no painel.
 *
 * Os modelos de VÍDEO não estão aqui: eles cobram por segundo e são escolhidos
 * por rodada, então o preço deles mora em `src/lib/modelos-video.ts`, junto do
 * resto do que muda entre um modelo e outro.
 */
export const CUSTO_CENTS: Record<string, number> = {
  "wavespeed-ai/openai-whisper-with-video": 1,
  "openai/gpt-image-2/text-to-image": 6,
  "sync/lipsync-2": 5,
};
