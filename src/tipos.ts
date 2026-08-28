import type { RenderManifest, RenderStep } from "./compartilhado/db/schema";

/** Um job travado por este worker, no formato que os passos consomem. */
export type Job = {
  id: string;
  name: string;
  refVideoUrl: string;
  castingBrief: string | null;
  step: RenderStep;
  manifest: RenderManifest;
  costCents: number;
};

/**
 * O que um passo devolve. Nenhum passo escreve no banco — ele calcula e
 * devolve; quem persiste é o loop. Assim um passo que morre no meio não deixa
 * estado pela metade, e dá pra testar passo isolado sem banco.
 */
export type StepResult = {
  /** Mesclado no manifesto. Nunca apaga o que os passos anteriores escreveram. */
  patch?: Partial<RenderManifest>;
  /** Só se o passo quiser desviar da ordem natural (ex.: repetir `clipes`). */
  next?: RenderStep;
  /** Para a esteira e espera decisão humana no painel. */
  pause?: boolean;
  /** Custo real gasto neste passo, em centavos de dólar. */
  costCents?: number;
  /** Uma linha pro log da rodada, visível no painel. */
  msg?: string;
};

export type StepFn = (job: Job) => Promise<StepResult>;
