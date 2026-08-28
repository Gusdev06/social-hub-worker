#!/usr/bin/env python3
"""Remonta a edicao de um criativo de referencia usando um talking head novo.

Reaproveita as faixas de baixo do original (screen recording, b-roll, barra de
caption) e troca so a faixa do sujeito.

  python3 montar_composto.py --ref original.mp4 --avatar novo.mp4 \
      --topo 279 --corte-ref 8.66 --corte 8.04 -o final.mp4

  # so ver as contas, sem renderizar
  python3 montar_composto.py --ref ... --avatar ... --topo 279 --dry-run

--topo e --corte-ref saem do analisar_estrutura.py. --corte e o instante no
video NOVO onde a parte dividida termina; deixe igual a --corte-ref se os dois
tem o mesmo ritmo, ou aponte para a emenda de clipe mais proxima.
"""
import argparse
import json
import subprocess
import sys

try:
    import numpy as np
except ImportError:
    sys.exit("precisa de numpy: python3 -m pip install numpy")


def probe(caminho):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate:format=duration", "-of", "json", caminho],
        capture_output=True, text=True).stdout
    d = json.loads(out)
    n, _, den = d["streams"][0].get("r_frame_rate", "30/1").partition("/")
    fps = float(n) / float(den or 1)
    return (int(d["streams"][0]["width"]), int(d["streams"][0]["height"]),
            float(d["format"]["duration"]), fps)


def topo_da_cabeca(caminho, w, h, t=2.0):
    """Primeira linha com conteudo de sujeito, vindo de cima.

    Fundo de parede e liso (desvio horizontal baixo); cabelo e rosto tem
    textura. O salto de desvio marca onde o sujeito comeca -- e disso sai o
    quanto de ar sobra acima dele quando cortamos a faixa.
    """
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-i", caminho, "-vframes", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    if len(p.stdout) < w * h * 3:
        return None
    img = np.frombuffer(p.stdout[:w * h * 3], dtype=np.uint8).reshape(h, w, 3).astype(np.float32)
    sd = img.mean(axis=2).std(axis=1)
    fundo = float(np.median(sd[:max(4, h // 20)]))
    lim = max(fundo * 2.5, fundo + 12)
    # Sujeito colado no topo (quadro cortado na testa) nao tem transicao
    # fundo->sujeito: a primeira linha ja e ele. Isso e 0, nao 'nao achei'.
    if sd[0] > lim:
        return 0
    for y in range(h):
        if sd[y] > lim and sd[y:y + max(4, h // 100)].min() > lim * 0.7:
            # Talking head em 9:16 SEMPRE tem a cabeca na parte de cima do quadro.
            # Achar o "topo do sujeito" abaixo de 40% da altura significa que o
            # detector engatou em outra coisa -- tipicamente um cenario com
            # textura (janela, porta, quadro na parede) que levanta o limiar ate
            # so o cabelo passar. Devolver esse numero jogava o avatar pra fora
            # da faixa e o composto saia com um ombro no topo e desfoque no resto.
            # Melhor admitir que nao sabe: sem medida, o avatar encosta no topo.
            return y if y <= h * 0.4 else None
    return None


def par(n):
    n = int(round(n))
    return n - (n % 2)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", required=True, help="criativo de referencia")
    ap.add_argument("--avatar", required=True, help="talking head novo")
    ap.add_argument("-o", "--saida", default="composto.mp4")
    ap.add_argument("--topo", type=int, default=0,
                    help="y onde termina a faixa do sujeito NA REFERENCIA (do analisar_estrutura)")
    ap.add_argument("--corte-ref", type=float, default=0.0, help="fim da parte dividida na referencia")
    ap.add_argument("--corte", type=float, help="fim da parte dividida no video novo (default: igual a --corte-ref)")
    ap.add_argument("--trechos", metavar="JSON",
                    help="linha do tempo remontada, em vez de UM corte. Lista de "
                         "{ini_av, fim_av, ini_ref, fim_ref, topo}; topo=0 e tela cheia. "
                         "Quando ausente, os flags --topo/--corte/--corte-ref viram dois trechos.")
    ap.add_argument("--largura", type=int, default=1080, help="largura de saida (default 1080)")
    ap.add_argument("--escala", type=float, default=None,
                    help="escala do avatar dentro da faixa (default 0.70 — acerte olhando o --preview)")
    ap.add_argument("--headroom", type=float, default=0.08,
                    help="ar acima da cabeca, como fracao da faixa (default 0.08)")
    ap.add_argument("--sem-blur", action="store_true", help="preencher a lateral com preto em vez de desfoque")
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mostrar-filtro", action="store_true",
                    help="imprime o filter_complex montado e sai, sem renderizar")
    ap.add_argument("--preview", metavar="JPG",
                    help="renderiza UM frame comparando referencia x composto e sai. "
                         "Use para acertar --escala antes de gastar minutos no video inteiro.")
    args = ap.parse_args()

    rw, rh, rdur, rfps = probe(args.ref)
    aw, ah, adur, afps = probe(args.avatar)
    corte = args.corte if args.corte is not None else args.corte_ref

    W = par(args.largura)
    H = par(W * rh / rw)
    k = W / rw

    cab_av = topo_da_cabeca(args.avatar, aw, ah, min(2.0, adur / 3))
    escala = args.escala if args.escala is not None else 0.70
    origem = "informada" if args.escala is not None else "padrao — confira com --preview"
    # A escala e fracao da LARGURA DE SAIDA. Usando o tamanho nativo do avatar
    # (`aw * escala`) so dava certo por acidente quando W == aw: em qualquer
    # outra largura o overlay saia gigante sobre uma faixa minuscula.
    sw = par(W * escala)
    sh = par(sw * ah / aw)
    x = par((W - sw) / 2)

    # --- a receita de remontagem ---
    #
    # NAO existe layout fixo aqui. Cada trecho e uma PILHA DE FAIXAS medida no
    # original, e cada faixa diz de onde vem: `avatar` (a pessoa, que e o que
    # trocamos) ou `ref` (caption, b-roll, screen recording — reaproveitado).
    #
    # Assim o mesmo codigo monta avatar em cima com caption embaixo, caption em
    # cima com a pessoa embaixo, tres faixas, ou tela cheia (uma faixa `avatar`
    # sozinha). Antes o script assumia "avatar em cima" e qualquer criativo com
    # outra topologia saia errado ou nem montava.
    if args.trechos:
        trechos = json.loads(args.trechos)
    else:
        corte_fim = min(corte, adur)
        pilha = ([{"y0": 0, "y1": args.topo, "fonte": "avatar"},
                  {"y0": args.topo, "y1": rh, "fonte": "ref"}] if args.topo
                 else [{"y0": 0, "y1": rh, "fonte": "avatar"}])
        trechos = [
            {"ini_av": 0.0, "fim_av": corte_fim, "ini_ref": 0.0,
             "fim_ref": min(corte_fim, args.corte_ref or rdur), "faixas": pilha},
            {"ini_av": corte_fim, "fim_av": adur, "ini_ref": 0.0, "fim_ref": 0.0,
             "faixas": [{"y0": 0, "y1": rh, "fonte": "avatar"}]},
        ]
    trechos = [t for t in trechos if t["fim_av"] - t["ini_av"] > 0.04]
    if not trechos:
        print("ERRO: nenhum trecho com duracao util")
        return 1

    def alturas(faixas):
        """Alturas de saida das faixas. Somam H exatamente, por construcao.

        Arredondar cada faixa isolada deixaria sobra ou falta de alguns pixels e
        o vstack sairia com altura diferente de H em alguns trechos — o concat
        recusa isso. Entao arredondamos as FRONTEIRAS e tiramos a diferenca.
        """
        b = [par(f["y0"] * k) for f in faixas] + [H]
        return [b[i + 1] - b[i] for i in range(len(faixas))]

    print(f"referencia : {rw}x{rh}  {rdur:.2f}s  {rfps:.2f}fps")
    print(f"avatar     : {aw}x{ah}  {adur:.2f}s  {afps:.2f}fps   cabeca y={cab_av}")
    if abs(rfps - afps) > 0.01:
        print(f"             cadencias diferentes — tudo normalizado em {afps:.2f}fps")
    print(f"saida      : {W}x{H}   {len(trechos)} trecho(s)   escala {escala:.3f} ({origem})")
    for i, t in enumerate(trechos):
        hs = alturas(t["faixas"])
        pilha = " + ".join(f"{f['fonte']}:{h}px" for f, h in zip(t["faixas"], hs))
        print(f"  [{i}] {t['ini_av']:6.2f}-{t['fim_av']:6.2f}s   {pilha}"
              + (f"   (ref {t['ini_ref']:.2f}-{t['fim_ref']:.2f}s)" if any(f["fonte"] == "ref" for f in t["faixas"]) else ""))

    for i, t in enumerate(trechos):
        fx = t["faixas"]
        if not fx:
            print(f"\nERRO: trecho {i} sem faixas"); return 1
        if sum(1 for f in fx if f["fonte"] == "avatar") != 1:
            print(f"\nERRO: trecho {i} precisa de exatamente UMA faixa de avatar"); return 1
        if any(h <= 0 for h in alturas(fx)):
            print(f"\nERRO: trecho {i} tem faixa de altura zero"); return 1
        if any(f["fonte"] == "ref" for f in fx) and t["fim_ref"] - t["ini_ref"] <= 0:
            print(f"\nERRO: trecho {i} reaproveita a referencia mas nao tem janela nela"); return 1
    if trechos[-1]["fim_av"] > adur + 0.05:
        print(f"\nERRO: a linha do tempo passa do avatar ({adur:.2f}s)"); return 1
    if args.dry_run:
        return 0

    # Uma cadencia so, a do avatar (que e quem manda no audio).
    #
    # Este criativo veio com referencia a 60 fps e avatar a 30. O `vstack`
    # sincroniza por timestamp: com cadencias diferentes ele fica alinhando
    # quadros que nao casam, e o render de 24s passou de 13 minutos sem terminar
    # -- inclusive em 180px de largura, o que provou que nao era volume de pixel.
    # O `concat` tambem exige cadencia igual entre os trechos.
    FPS = f"fps={afps:.5f},"

    def fundo_de(h):
        if args.sem_blur:
            return f"crop={W}:{h}:0:0,scale={W}:{h}"
        return (f"scale={W}:-2,crop={W}:{h}:0:{max(0, int((ah * W / aw - h) / 2))},"
                f"gblur=sigma={max(12, W // 27)},eq=brightness=0.03")

    def faixa_avatar(tag, pad_in, h):
        """A pessoa nova, ocupando a faixa.

        Faixa do quadro inteiro e o caso facil: o avatar ja nasce em 9:16, entao
        so escala e preenche. Reduzir e desfocar aqui seria encaixotar o avatar
        no proprio formato dele -- que foi o que aconteceu quando esta funcao
        passou a atender tambem os trechos de tela cheia.

        Faixa MAIS BAIXA que o quadro e o caso real: o avatar nao cabe inteiro,
        entao ele entra reduzido (`--escala`) e o que sobra e preenchido com uma
        versao desfocada dele mesmo.
        """
        if h >= H:
            return f"[{pad_in}]scale={W}:{H},setsar=1[f{tag}];"
        y = int(h * args.headroom - (cab_av or 0) * escala)
        return (f"[{pad_in}]split=2[bg{tag}][fg{tag}];"
                f"[bg{tag}]{fundo_de(h)},setsar=1[blur{tag}];"
                f"[fg{tag}]scale={sw}:{sh}[small{tag}];"
                f"[blur{tag}][small{tag}]overlay={x}:{y},crop={W}:{h}:0:0,setsar=1[f{tag}];")

    def faixa_ref(tag, pad_in, f, h, ini, fim, dur):
        """Uma faixa do original, recortada e esticada pra largura de saida.

        Quando a janela do original e mais curta que o trecho do avatar, o ultimo
        frame e clonado pra fechar a diferenca -- sem isso o vstack espera pelo
        ramo curto e o audio desliza dali pra frente.

        A clonagem e por DURACAO EXATA, nunca `stop=-1`. Com padding infinito o
        ramo nunca termina, o `concat` nunca passa pro trecho seguinte e o ffmpeg
        escreve pra sempre: um render de 24s chegou a 117 MB e crescendo, a 450%
        de CPU, sem nunca fechar o arquivo.
        """
        falta = max(0.0, dur - (fim - ini))
        pad = f"tpad=stop_duration={falta:.3f}:stop_mode=clone," if falta > 0.01 else ""
        return (f"[{pad_in}]trim={ini}:{fim},setpts=PTS-STARTPTS,{FPS}setpts=PTS-STARTPTS,{pad}"
                f"trim=0:{dur},setpts=PTS-STARTPTS,"
                f"crop={rw}:{f['y1'] - f['y0']}:0:{f['y0']},"
                f"scale={W}:{h}:flags=lanczos,setsar=1[f{tag}];")

    # Cada pad de entrada so pode ser consumido UMA vez em filter_complex: com N
    # trechos e M faixas de referencia, os dois videos precisam ser fatiados antes.
    n_ref = sum(1 for t in trechos for f in t["faixas"] if f["fonte"] == "ref")
    partes = ["[0:v]split=%d%s;" % (len(trechos), "".join(f"[a{i}]" for i in range(len(trechos))))]
    if n_ref:
        partes.append("[1:v]split=%d%s;" % (n_ref, "".join(f"[r{j}]" for j in range(n_ref))))

    j = 0
    for i, t in enumerate(trechos):
        fx, hs = t["faixas"], alturas(t["faixas"])
        dur = t["fim_av"] - t["ini_av"]
        fim_ref = t["ini_ref"] + min(dur, max(0.0, t["fim_ref"] - t["ini_ref"]))
        # O avatar deste trecho e recortado uma vez e distribuido pras faixas.
        partes.append(f"[a{i}]trim={t['ini_av']}:{t['fim_av']},setpts=PTS-STARTPTS,{FPS}"
                      f"setpts=PTS-STARTPTS[av{i}];")
        for n, (f, h) in enumerate(zip(fx, hs)):
            tag = f"{i}_{n}"
            if f["fonte"] == "avatar":
                partes.append(faixa_avatar(tag, f"av{i}", h))
            else:
                partes.append(faixa_ref(tag, f"r{j}", f, h, t["ini_ref"], fim_ref, dur))
                j += 1
        if len(fx) == 1:
            partes.append(f"[f{i}_0]null[p{i}];")
        else:
            partes.append("".join(f"[f{i}_{n}]" for n in range(len(fx))) +
                          f"vstack=inputs={len(fx)},setsar=1[p{i}];")

    partes.append("".join(f"[p{i}]" for i in range(len(trechos))) +
                  f"concat=n={len(trechos)}:v=1:a=0[vout]")
    fc = "".join(partes)

    # --- preview: o primeiro trecho com mais de uma faixa e o que vale conferir ---
    if args.preview:
        alvo = next((t for t in trechos if len(t["faixas"]) > 1), None)
        if alvo is None:
            print("sem trecho composto — nada pra comparar no preview")
            return 1
        fx, hs = alvo["faixas"], alturas(alvo["faixas"])
        t_av = (alvo["ini_av"] + alvo["fim_av"]) / 2
        t_ref = (alvo["ini_ref"] + alvo["fim_ref"]) / 2
        n_r = sum(1 for f in fx if f["fonte"] == "ref")
        pv = ["[0:v]null[av];", "[1:v]split=%d%s;" % (n_r + 1, "".join(f"[q{m}]" for m in range(n_r + 1)))]
        m = 0
        for n, (f, h) in enumerate(zip(fx, hs)):
            if f["fonte"] == "avatar":
                pv.append(faixa_avatar(f"p{n}", "av", h))
            else:
                pv.append(f"[q{m}]crop={rw}:{f['y1'] - f['y0']}:0:{f['y0']},"
                          f"scale={W}:{h}:flags=lanczos,setsar=1[fp{n}];")
                m += 1
        pv.append("".join(f"[fp{n}]" for n in range(len(fx))) +
                  f"vstack=inputs={len(fx)},scale=540:-2[novo];")
        pv.append(f"[q{n_r}]scale=540:-2,setsar=1[velho];[velho][novo]hstack=inputs=2[cmp]")
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                            "-ss", f"{t_av:.3f}", "-i", args.avatar,
                            "-ss", f"{t_ref:.3f}", "-i", args.ref,
                            "-filter_complex", "".join(pv), "-map", "[cmp]", "-vframes", "1",
                            "-q:v", "3", args.preview])
        if r.returncode == 0:
            print(f"preview: {args.preview}  (esquerda = referencia, direita = composto)")
            print("Compare o TAMANHO DA CABECA nos dois. Maior no seu? baixe --escala.")
        return r.returncode

    if args.mostrar_filtro:
        print("\n--- filter_complex ---")
        for parte in fc.split(";"):
            print("  " + parte)
        print(f"\n{len(fc)} caracteres · {fc.count(';')+1} nós")
        return 0

    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", args.avatar, "-i", args.ref,
           "-filter_complex", fc, "-map", "[vout]", "-map", "0:a?",
           "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
           "-movflags", "+faststart", args.saida]

    print("\nrenderizando...")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        return r.returncode

    ow, oh, odur, _ = probe(args.saida)
    print(f"ok: {args.saida}  {ow}x{oh}  {odur:.2f}s")
    if k > 1.5 and any(f["fonte"] == "ref" for t in trechos for f in t["faixas"]):
        print(f"NOTA: a faixa de baixo foi ampliada {k:.1f}x a partir de {rw}px de largura.")
        print("      Vai sair mole. Se conseguir a referencia em resolucao maior, remonte.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
