import type { z } from "zod";

/**
 * O escritor de texto da esteira: Kimi K3.
 *
 * Servido pelo WaveSpeed numa base OpenAI-compatível (`llm.wavespeed.ai/v1`),
 * que é SEPARADA da API de inferência de imagem/vídeo (`api.wavespeed.ai/api/v3`)
 * — o mesmo `WAVESPEED_API_KEY` vale nas duas, mas o id `moonshotai/kimi-k3` só
 * existe na primeira; na segunda ele responde "Model not found".
 *
 * K3 é modelo de raciocínio: o pensamento consome o MESMO `max_tokens` da
 * resposta. Com orçamento curto o `content` volta vazio e o `finish_reason` vem
 * `length` — o que parece falha de rede e não é. Daí o piso alto de tokens e o
 * erro explícito pra esse caso.
 */

const BASE = "https://llm.wavespeed.ai/v1/chat/completions";
export const LLM_MODEL = "moonshotai/kimi-k3";

export type ParteConteudo =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Recusa de conteúdo, separada de erro técnico.
 *
 * Quem chama reescreve a mensagem com o contexto que tem (qual clipe, qual
 * passo), porque "tentar de novo" não resolve recusa — a saída é mudar o texto.
 */
export class RecusaDoEscritor extends Error {}

type Escolha = {
  finish_reason?: string;
  message?: { content?: string | null; refusal?: string | null };
};

function chave(): string {
  const k = process.env.WAVESPEED_API_KEY;
  if (!k) throw new Error("WAVESPEED_API_KEY não configurada");
  return k;
}

async function completar({
  system, conteudo, maxTokens, formato, onde,
}: {
  system?: string;
  conteudo: string | ParteConteudo[];
  maxTokens: number;
  formato?: Record<string, unknown>;
  onde: string;
}): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${chave()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: conteudo },
      ],
      ...(formato ? { response_format: formato } : {}),
    }),
  });

  const corpo = (await r.json().catch(() => null)) as
    | { choices?: Escolha[]; error?: unknown }
    | null;

  if (!r.ok || !corpo || corpo.error) {
    throw new Error(
      `${onde}: ${LLM_MODEL} respondeu HTTP ${r.status} — ` +
      `${JSON.stringify(corpo?.error ?? corpo ?? "sem corpo").slice(0, 300)}`,
    );
  }

  const escolha = corpo.choices?.[0];
  if (escolha?.message?.refusal) throw new RecusaDoEscritor(escolha.message.refusal);

  const texto = (escolha?.message?.content ?? "").trim();
  if (!texto) {
    throw new Error(
      escolha?.finish_reason === "length"
        ? `${onde}: o raciocínio do ${LLM_MODEL} consumiu os ${maxTokens} tokens antes de escrever a resposta`
        : `${onde}: ${LLM_MODEL} não devolveu texto (finish_reason=${escolha?.finish_reason ?? "?"})`,
    );
  }
  return texto;
}

/** Texto corrido. */
export const escrever = (p: {
  system?: string;
  conteudo: string | ParteConteudo[];
  maxTokens?: number;
  onde: string;
}) => completar({ ...p, maxTokens: p.maxTokens ?? 4000 });

/**
 * Saída estruturada, validada no zod depois de voltar.
 *
 * O `json_schema` vai sem `strict`: o schema pedido é orientação, e a garantia
 * de verdade é o parse do zod aqui — assim uma mudança de comportamento do
 * provedor vira erro claro em vez de objeto pela metade circulando na esteira.
 */
export async function escreverJson<T>(p: {
  system?: string;
  conteudo: string | ParteConteudo[];
  schema: z.ZodType<T>;
  nome: string;
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  onde: string;
}): Promise<T> {
  const bruto = await completar({
    system: p.system,
    conteudo: p.conteudo,
    maxTokens: p.maxTokens ?? 6000,
    onde: p.onde,
    formato: { type: "json_schema", json_schema: { name: p.nome, schema: p.jsonSchema } },
  });

  // Modelo de raciocínio às vezes embrulha o JSON em cerca de markdown.
  const limpo = bruto.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let obj: unknown;
  try {
    obj = JSON.parse(limpo);
  } catch {
    throw new Error(`${p.onde}: ${LLM_MODEL} não devolveu JSON válido — "${limpo.slice(0, 160)}"`);
  }

  const v = p.schema.safeParse(obj);
  if (!v.success) throw new Error(`${p.onde}: JSON fora do formato — ${v.error.issues[0]?.message}`);
  return v.data;
}
