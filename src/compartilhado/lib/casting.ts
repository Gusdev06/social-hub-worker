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
/** Compara ignorando caixa, acento, aspas e pontuação: o que sobra é a fala. */
const soLetras = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * A mensagem que a rodada mostra quando não veio prompt — com as palavras do
 * modelo DENTRO.
 *
 * Sem a resposta dele na tela, "o modelo recusou" parece defeito da esteira e
 * o reflexo é mandar rodar de novo, que recusa de novo. Com ela na frente, a
 * escolha aparece sozinha: reescrever a fala, ou escrever o prompt à mão — que
 * pula o escritor inteiro, porque prompt manual não chama LLM nenhuma.
 */
const recusou = (n: number, resposta: string) => {
  const dele = resposta.trim();
  return (
    `o ${LLM_MODEL} recusou escrever o prompt do clipe ${n} e respondeu isto: ` +
    `"${dele.slice(0, 400)}${dele.length > 400 ? "…" : ""}"`
  );
};

/**
 * O prompt do clipe e a conversa que o produziu.
 *
 * O `enviado` existe pra conferência: quando o prompt sai estranho, a pergunta
 * é se a LLM interpretou mal ou se o INSUMO já estava errado — nota de casting
 * vazia, fala fatiada no lugar errado, formato de diálogo do modelo trocado.
 * Sem guardar o que foi mandado, essa distinção só sairia relendo o código.
 */
export type PromptDeClipe = {
  prompt: string;
  enviado: { sistema: string; usuario: string; modelo: string };
};

export async function escreverPromptClipe({
  nota, texto, n, total, formatoDialogo,
}: {
  nota: string;
  texto: string;
  n: number;
  total: number;
  /** Como este modelo espera receber a fala. */
  formatoDialogo: string;
}): Promise<PromptDeClipe> {
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

  const usuario = `NOTA DE CASTING (lei, não altere):\n${nota}\n\nClipe ${n} de ${total}. Fala literal:\n"${texto}"`;

  let prompt: string;
  try {
    prompt = await escrever({
      system: sistema,
      conteudo: usuario,
      onde: `prompt do clipe ${n}`,
    });
  } catch (e) {
    // Recusa é diferente de erro técnico e merece mensagem própria: não adianta
    // "tentar de novo", e a saída é mudar a fala do clipe.
    if (e instanceof RecusaDoEscritor) throw new Error(recusou(n, e.message));
    throw e;
  }

  // A FALA TEM QUE ESTAR LITERAL DENTRO DO PROMPT. É o contrato do formato — e é
  // a única prova barata de que voltou um prompt de clipe, e não outra coisa.
  //
  // O K3 recusa em texto corrido, no `content`, e não no campo `refusal` que o
  // `escrever` sabe reconhecer. Sem esta conferência a recusa era gravada COMO
  // SE FOSSE O PROMPT: passava pelo portão parecendo um prompt qualquer e seguia
  // pro Kling, que gerou US$ 1,70 de alguém lendo "Não posso escrever esse
  // prompt. A fala promove..." — aconteceu em 29/08, quatro propostas seguidas.
  //
  // Pega também o caso mais silencioso: o modelo reescrever ou traduzir a fala.
  // O roteiro é o ativo testado; clipe com a copy trocada não mede nada.
  if (!soLetras(prompt).includes(soLetras(texto))) throw new Error(recusou(n, prompt));

  return { prompt, enviado: { sistema, usuario, modelo: LLM_MODEL } };
}
