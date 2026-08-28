import { eq } from "drizzle-orm";
import { db } from "../compartilhado/db";
import { scheduledPosts, socialAccounts } from "../compartilhado/db/schema";
import type { Job, StepResult } from "../tipos";

/**
 * Fecha o loop: o criativo pronto vira um rascunho de publicação e cai no
 * mesmo fan-out multi-perfil que o resto do app já usa.
 *
 * Sai como `draft` de propósito. Escolher em quais perfis vai, escrever a
 * legenda e marcar a hora são decisões do Gusta — o worker não publica nada
 * sozinho na conta de ninguém.
 */
export const publicar = async (job: Job): Promise<StepResult> => {
  const video = job.manifest.compostoUrl ?? job.manifest.versaoBUrl;
  if (!video) throw new Error("nenhum vídeo final pra publicar");

  const conta = await db.query.socialAccounts.findFirst({
    where: eq(socialAccounts.isActive, true),
  });
  if (!conta) throw new Error("nenhuma conta conectada");

  // Idempotente: recompor e reprocessar é comum (mexer na escala é de graça), e
  // cada passada não pode deixar um rascunho novo pra trás.
  const jaExiste = job.manifest.scheduledPostId;
  if (jaExiste) {
    await db
      .update(scheduledPosts)
      .set({ mediaUrls: [video] })
      .where(eq(scheduledPosts.id, jaExiste));
    return { msg: "rascunho atualizado com o vídeo recomposto" };
  }

  const [post] = await db
    .insert(scheduledPosts)
    .values({
      workspaceId: conta.workspaceId,
      caption: "",
      mediaUrls: [video],
      mediaType: "reel",
      scheduledFor: new Date(),
      status: "draft",
    })
    .returning({ id: scheduledPosts.id });

  return {
    patch: { scheduledPostId: post.id },
    msg: "rascunho criado — escolha os perfis e a legenda em Novo post",
  };
};
