import { z } from "zod";
import { LLM_MODEL, RecusaDoEscritor, escrever, escreverJson, type ParteConteudo } from "./llm";

const CastingSchema = z.object({
  nota: z.string().describe(
    "A nota de casting em 5 linhas: IDADE/GÊNERO, TRAÇO FACIAL, ÂNCORA DE FIGURINO, CENÁRIO, LINHA EMOCIONAL.",
  ),
  prompt: z.string().describe("O prompt completo da imagem-base, em inglês, no template UGC."),
});

export type Casting = z.infer<typeof CastingSchema>;

/**
 * Escreve a nota de casting e o prompt da imagem-base.
 *
 * A nota é lei: ela reaparece literalmente igual em todo prompt de clipe. É a
 * âncora de figurino que faz o modelo reconhecer que é a mesma pessoa entre um
 * clipe e outro — troque a descrição do moletom no clipe 3 e você ganha uma
 * pessoa nova no meio do vídeo.
 */
export async function escreverCasting({
  brief, frameUrl, ratio,
}: {
  brief: string;
  frameUrl?: string;
  ratio: string;
}): Promise<Casting> {
  // O frame do original entra pra casar a GRAMÁTICA VISUAL — altura da câmera,
  // tamanho do plano, direção da luz, densidade do fundo. O que não se casa é
  // etnia, gênero e idade: trocar isso é justamente o ponto do exercício.
  const conteudo: ParteConteudo[] = [];
  if (frameUrl) {
    conteudo.push({ type: "image_url", image_url: { url: frameUrl } });
    conteudo.push({
      type: "text",
      text: "Acima, um frame do criativo original. Case a altura da câmera, o tamanho do plano, a direção da luz e a densidade do fundo. NÃO case etnia, gênero nem idade.",
    });
  }
  conteudo.push({ type: "text", text: `Avatar pedido: ${brief}\nRatio: ${ratio}` });

  return escreverJson({
    system: SISTEMA,
    conteudo,
    schema: CastingSchema,
    nome: "casting",
    jsonSchema: z.toJSONSchema(CastingSchema) as Record<string, unknown>,
    onde: "nota de casting",
  });
}

const SISTEMA = `Você escreve prompts de imagem para avatares de anúncio UGC que NÃO podem parecer feitos por IA.

Preencha este template, em inglês, mantendo os cabeçalhos:

A vertical {RATIO} UGC-style video frame shot on an iPhone resting on a tripod.
Medium shot at true eye level, subject seated, slightly forward-leaning posture.

SUBJECT: A [idade] [gênero] with [etnia/tom de pele], [cor] eyes, [sobrancelha], [traço facial distintivo]. [Cabelo: cor, textura, comprimento]. Expression is [linha emocional] — [detalhe específico da expressão, não um adjetivo genérico].

WARDROBE: [âncora de figurino, literal].

SKIN: Visible pores across the T-zone, faint expression lines, natural oil catching light on the forehead and nose bridge. No filter, no foundation, no retouching.

FRAMING: Cropped at mid-chest — hands are out of frame.

CAMERA: Native phone lens (26mm equivalent), mild barrel softness at the edges, slight neural blur only around hair edges.

LIGHTING: Available light — cool daylight from a window camera-left, warm lamp spill camera-right. Soft asymmetric shadow, natural falloff. ISO grain 500-900.

BACKGROUND: [cenário], softly out of focus, everyday and lived-in — not styled.

Regras que carregam a qualidade:
- MÃOS FORA DO QUADRO, sempre. É o maior denunciador — dedo derrete em movimento.
- Pele com textura visível. Pele limpa demais é o segundo denunciador.
- Luz disponível, nunca luz de estúdio. Grão real, lente de celular.
- Linha emocional de quem conta um segredo sentado em casa, NUNCA energia de apresentador.
- Detalhe específico no lugar de adjetivo genérico ("olhar que desvia meio segundo antes de falar", não "expressão séria").

A nota de casting vai em português, 5 linhas. O prompt vai em inglês.`;

/**
 * O prompt de UM clipe: ação física âncora primeiro, depois a fala literal.
 *
 * O formato da linha de fala muda por modelo (o Kling tem a convenção
 * `[Speaker, tom]:`, o Wan e o H3 querem a fala entre aspas na descrição), então
 * ele chega de fora, do registro em `modelos-video.ts`.
 *
 * A fala vai LITERAL, na língua do original. O roteiro é o ativo testado —
 * melhorar a copy no meio do caminho contamina o teste e o Gusta perde a
 * leitura do resultado.
 */
export async function escreverPromptClipe({
  nota, texto, n, total, formatoDialogo,
}: {
  nota: string;
  texto: string;
  n: number;
  total: number;
  /** Como este modelo espera receber a fala. */
  formatoDialogo: string;
}): Promise<string> {
  const sistema = `Você escreve prompts de clipe para um modelo de image-to-video com áudio nativo.

Formato, nesta ordem:
1. Uma frase de ação física âncora — para onde olha, como a cabeça se move, quando pisca, o ritmo do corpo. Micro-movimento, nunca gesto de mão.
2. A linha de diálogo, no formato: ${formatoDialogo}

Regras:
- A FALA VAI LITERAL, sem reescrever, sem corrigir gramática, sem traduzir.
- MÃOS FORA DO QUADRO. Nada de gesto — dedo derrete em movimento.
- Sem corte, sem zoom, sem troca de plano: é um take contínuo.
- A âncora de figurino da nota de casting reaparece LITERALMENTE igual, ou o modelo troca de pessoa entre clipes.
- Registro de quem fala baixo sentado em casa, nunca de apresentador.
Responda só com o prompt, sem preâmbulo.`;

  try {
    return await escrever({
      system: sistema,
      conteudo: `NOTA DE CASTING (lei, não altere):\n${nota}\n\nClipe ${n} de ${total}. Fala literal:\n"${texto}"`,
      onde: `prompt do clipe ${n}`,
    });
  } catch (e) {
    // Recusa é diferente de erro técnico e merece mensagem própria: não adianta
    // "tentar de novo", e a saída é mudar a fala do clipe.
    if (e instanceof RecusaDoEscritor) {
      throw new Error(
        `o modelo recusou escrever o prompt do clipe ${n} — a fala desse trecho ` +
        `esbarra na política de uso do ${LLM_MODEL}. Trocar o modelo de VÍDEO não ` +
        `ajuda: a recusa é do escritor de prompt, um passo ANTES da geração. ` +
        `Reescreva a fala do clipe no painel ou use outro criativo de referência.`,
      );
    }
    throw e;
  }
}
