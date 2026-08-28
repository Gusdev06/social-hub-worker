import { escrever } from "./llm";

/** Normaliza pra COMPARAR (não pra exibir): sem apóstrofo, sem caixa, sem sinal. */
const norm = (s: string) =>
  s.toLowerCase().replace(/['‘’ʼ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Devolve pontuação e maiúscula à transcrição crua do Whisper.
 *
 * Por que é necessário: o Whisper entrega um bloco corrido sem ponto, e o
 * fatiador de roteiro corta em fronteira de frase — sem pontuação ele não tem
 * onde cortar e empilha o roteiro inteiro num clipe só.
 *
 * Por que não dá pra confiar na saída do modelo: o roteiro é o ativo testado.
 * Pedindo "devolva o mesmo texto pontuado", o modelo silenciosamente come uma
 * palavra de vez em quando — na referência da Sophia ele comeu o "is" de "the
 * problem is hardly anyone knows", duas tentativas seguidas.
 *
 * Então o texto final é RECONSTRUÍDO a partir das palavras da transcrição, e do
 * modelo se importa apenas a pontuação. Palavra trocada deixa de ser um risco
 * detectável e passa a ser impossível.
 */
export async function restaurarPontuacao(cru: string): Promise<{ texto: string; alinhadas: number }> {
  const pontuado = await escrever({
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

  return aplicarPontuacao(cru, pontuado);
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
      const doModelo = modelo[achou];
      // Só o que vem DEPOIS da palavra é importado — e só sinal de pontuação.
      const cauda = doModelo.match(/[.,!?;:…]+$/)?.[0] ?? "";
      palavra = original + cauda;
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
