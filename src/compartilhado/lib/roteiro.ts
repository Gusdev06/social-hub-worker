import { escrever } from "./llm";

/** Normaliza pra COMPARAR (não pra exibir): sem apóstrofo, sem caixa, sem sinal. */
const norm = (s: string) =>
  s.toLowerCase().replace(/['‘’ʼ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");

/** Uma fronteira de frase a cada ~30 palavras já dá ao fatiador onde cortar. */
const PALAVRAS_POR_FRASE = 30;

/**
 * Devolve pontuação e maiúscula à transcrição crua do Whisper.
 *
 * Por que existe: o Whisper às vezes entrega um bloco corrido sem ponto, e o
 * fatiador de roteiro prefere emendar em fronteira de frase. Sem nenhuma
 * fronteira ele desce pra oração e pra palavra — funciona, mas o corte cai em
 * lugar pior. Pontuar antes é o que mantém o corte na frase.
 *
 * Por que não dá pra confiar na saída do modelo: o roteiro é o ativo testado.
 * Pedindo "devolva o mesmo texto pontuado", o modelo silenciosamente come uma
 * palavra de vez em quando — na referência da Sophia ele comeu o "is" de "the
 * problem is hardly anyone knows", duas tentativas seguidas.
 *
 * Então o texto final é RECONSTRUÍDO a partir das palavras da transcrição, e do
 * modelo se importa apenas a pontuação. Palavra trocada deixa de ser um risco
 * detectável e passa a ser impossível.
 *
 * `aviso` é o que a rodada mostra na tela quando o resultado saiu abaixo do
 * ideal: vazio significa pontuação confiável.
 */
export async function restaurarPontuacao(cru: string): Promise<{ texto: string; aviso: string }> {
  const total = cru.split(/\s+/).filter(Boolean).length;
  const fronteiras = (cru.match(/[.!?…]/g) ?? []).length;

  // O Whisper MUITAS VEZES já devolve pontuado. Quando devolve, chamar o modelo
  // é só custo e risco: esta é a única etapa da esteira capaz de encostar numa
  // palavra do ativo testado.
  if (fronteiras * PALAVRAS_POR_FRASE >= total) return { texto: cru, aviso: "" };

  let pontuado: string;
  try {
    pontuado = await escrever({
      system:
        "Você recebe uma transcrição automática sem pontuação. Devolva o MESMO texto com " +
        "pontuação e maiúsculas corretas.\n\n" +
        "PROIBIDO: trocar, acrescentar ou remover qualquer palavra; corrigir gramática; " +
        "reescrever; traduzir. Só sinal de pontuação e caixa mudam.\n" +
        "Responda só com o texto.",
      conteudo: cru,
      // Modelo de raciocínio: o pensamento sai do mesmo orçamento, e transcrição
      // de criativo de 40s já passa de 150 palavras. Apertado aqui volta vazio.
      maxTokens: 8000,
      onde: "pontuação do roteiro",
    });
  } catch (erro) {
    // Pontuação é conforto; a transcrição é o ativo. O fatiador sabe descer pra
    // oração e, no limite, pra palavra quando não há ponto nenhum (ver
    // `atomizar` em chunk_roteiro.py), então falha aqui piora o corte — não
    // derruba a rodada, que ainda para pra aprovação com este aviso na tela.
    const causa = erro instanceof Error ? erro.message : String(erro);
    return { texto: cru, aviso: `pontuação não restaurada (${causa}) — corte por oração` };
  }

  const { texto, alinhadas } = aplicarPontuacao(cru, pontuado);
  return {
    texto,
    aviso: alinhadas < total ? `${total - alinhadas} palavra(s) sem pontuação alinhada` : "",
  };
}

/**
 * Alinha o texto pontuado do modelo contra as palavras originais e devolve as
 * ORIGINAIS carregando a pontuação que o modelo colocou.
 *
 * O alinhamento é guloso com janela curta: se o modelo comeu ou inventou uma
 * palavra, o ponteiro reencontra a trilha em uma ou duas posições e a única
 * perda é a pontuação daquele trecho — nunca a palavra.
 */
export function aplicarPontuacao(cru: string, pontuado: string): { texto: string; alinhadas: number } {
  const originais = cru.split(/\s+/).filter(Boolean);
  const modelo = pontuado.split(/\s+/).filter(Boolean);
  if (!modelo.length) return { texto: cru, alinhadas: 0 };

  const saida: string[] = [];
  let j = 0;
  let alinhadas = 0;
  let novaFrase = true;

  for (const original of originais) {
    const alvo = norm(original);

    // Procura o mesmo token à frente, tolerando um pequeno descompasso.
    let achou = -1;
    for (let k = j; k < Math.min(j + 4, modelo.length); k++) {
      if (norm(modelo[k]) === alvo) { achou = k; break; }
    }

    let palavra = original;
    if (achou >= 0) {
      // Só o que vem DEPOIS da palavra é importado, e só sinal de pontuação: as
      // letras são sempre as da transcrição. Quando o Whisper já tinha pontuado
      // aquela palavra, a do modelo SUBSTITUI a dele — somar as duas escrevia
      // "do seu celular.." e "namorada,," no roteiro que vai pro Kling.
      const cauda = modelo[achou].match(/[.,!?;:…]+$/)?.[0];
      palavra = cauda ? original.replace(/[.,!?;:…]+$/, "") + cauda : original;
      j = achou + 1;
      alinhadas++;
    }

    if (novaFrase) palavra = palavra.charAt(0).toUpperCase() + palavra.slice(1);
    novaFrase = /[.!?…]$/.test(palavra);
    saida.push(palavra);
  }

  return { texto: saida.join(" "), alinhadas };
}

/**
 * Palpite de idioma pra contagem de sílabas. Erra por 1-2 sílabas por frase no
 * pior caso — bem dentro da folga da janela de 55-60, então não vale mais que
 * isto.
 */
export function idioma(texto: string): "pt" | "en" {
  return /[ãõçáéíóúâêô]|\b(não|você|que|para|com|uma|mais)\b/i.test(texto) ? "pt" : "en";
}
