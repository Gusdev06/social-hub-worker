#!/usr/bin/env python3
"""Remove as pausas de um talking head, deixando o corte mais fluido.

  python3 remover_pausas.py entrada.mp4 saida.mp4
  python3 remover_pausas.py entrada.mp4 saida.mp4 --limiar -30 --min 0.30
  python3 remover_pausas.py entrada.mp4 --dry-run      # so lista o que cortaria

Video gerado por IA respira devagar: sobra ar no comeco, no fim e principalmente
na emenda entre clipes. Tirar esse ar e o que separa um criativo que parece
apresentacao de um que parece alguem falando com voce.

O corte deixa um SALTO na imagem (a pessoa muda de pose de um frame pro outro).
Isso e a estetica de jump cut do UGC, nao um defeito -- mas se o objetivo for
um plano contínuo, nao use isto.

Devolve a nova duracao no final: quem chama precisa dela para recalcular o
ponto de corte da montagem.
"""
import argparse
import json
import re
import subprocess
import sys


def probe_dur(caminho):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", caminho], capture_output=True, text=True).stdout
    return float(out.strip())


def achar_silencios(caminho, limiar, minimo):
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", caminho, "-af",
         f"silencedetect=n={limiar}dB:d={minimo}", "-f", "null", "-"],
        capture_output=True, text=True)
    txt = p.stderr
    inicios = [float(m) for m in re.findall(r"silence_start: (-?[\d.]+)", txt)]
    fins = [float(m) for m in re.findall(r"silence_end: (-?[\d.]+)", txt)]
    dur = probe_dur(caminho)
    # silencio aberto no fim do arquivo nao ganha silence_end
    if len(fins) < len(inicios):
        fins.append(dur)
    return [(max(0.0, s), min(dur, e)) for s, e in zip(inicios, fins) if e > s], dur


def calcular_cortes(silencios, margem, dur):
    """Intervalos a REMOVER, ja com a margem de respiro preservada."""
    cortes = []
    for s, e in silencios:
        a, b = s + margem, e - margem
        if b - a > 0.05:          # sobrou pausa suficiente para valer o corte
            cortes.append((round(a, 3), round(b, 3)))
    return cortes


def calcular_manter(cortes, dur):
    manter, pos = [], 0.0
    for a, b in cortes:
        if a > pos + 0.02:
            manter.append((round(pos, 3), round(a, 3)))
        pos = b
    if dur > pos + 0.02:
        manter.append((round(pos, 3), round(dur, 3)))
    return manter


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("entrada")
    ap.add_argument("saida", nargs="?")
    ap.add_argument("--limiar", type=float, default=-30,
                    help="dB abaixo do qual conta como silencio (default -30). "
                         "Video de IA tem ambiente: -40 quase nao acha nada, -25 come fala.")
    ap.add_argument("--min", dest="minimo", type=float, default=0.30,
                    help="pausa minima para virar corte, em s (default 0.30). "
                         "Abaixo disso e ritmo natural de fala e cortar soa picotado.")
    ap.add_argument("--margem", type=float, default=0.10,
                    help="respiro preservado nas duas pontas de cada pausa (default 0.10)")
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    silencios, dur = achar_silencios(args.entrada, args.limiar, args.minimo)
    cortes = calcular_cortes(silencios, args.margem, dur)
    manter = calcular_manter(cortes, dur)
    removido = sum(b - a for a, b in cortes)
    nova = dur - removido

    if args.as_json:
        print(json.dumps({"duracao_original": round(dur, 3), "nova_duracao": round(nova, 3),
                          "removido": round(removido, 3), "cortes": cortes,
                          "manter": manter}, indent=2))
    else:
        print(f"{args.entrada}: {dur:.2f}s -> {nova:.2f}s  ({removido:.2f}s removidos "
              f"em {len(cortes)} corte(s))")
        for a, b in cortes:
            print(f"    corta {a:6.2f}s - {b:6.2f}s  ({b-a:.2f}s)")

    if args.dry_run or not args.saida:
        return 0
    if not manter:
        print("nada a cortar")
        return 1

    expr = "+".join(f"between(t,{a},{b})" for a, b in manter)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", args.entrada,
           "-vf", f"select='{expr}',setpts=N/FRAME_RATE/TB",
           "-af", f"aselect='{expr}',asetpts=N/SR/TB",
           "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", args.saida]
    r = subprocess.run(cmd)
    if r.returncode != 0:
        return r.returncode
    real = probe_dur(args.saida)
    print(f"ok: {args.saida}  {real:.2f}s")
    if abs(real - nova) > 0.5:
        print(f"   (previsto {nova:.2f}s — o select trabalha em fronteira de frame)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
