#!/usr/bin/env python3
"""Fatia um roteiro em clipes de ~55-60 silabas (o ritmo natural de fala
que o Kling sustenta em ~10s), emendando em fronteira de frase.

Quando nao existe fronteira de frase onde emendar -- roteiro de anuncio em
periodo corrido, transcricao que voltou sem pontuacao -- o corte desce pra
oracao e, no limite, pra palavra. Ver atomizar().

  python3 chunk_roteiro.py roteiro.txt --lang pt
  python3 chunk_roteiro.py roteiro.txt --lang en --json
  python3 chunk_roteiro.py roteiro.txt --lang en --ref-dur 32.5
  echo "texto..." | python3 chunk_roteiro.py - --lang pt

A contagem de silabas e heuristica (grupos de vogais), nao um silabador
completo. Isso basta para fatiar: o erro tipico e de 1-2 silabas por frase,
bem dentro da folga da janela 55-60.

SEMPRE passe --ref-dur com a duracao real do criativo de referencia. O ritmo
de locucao de anuncio varia muito (3.5 a 6 silabas/s conforme as pausas), e
o default generico erra facil 40%. Com --ref-dur o script calibra o ritmo no
proprio original -- que e o ritmo que voce esta tentando reproduzir.
"""
import argparse
import json
import re
import sys

VOGAIS = "aeiouáàâãéêíóôõúüy"

# Ditongos e digrafos que formam UMA silaba, nao duas.
DITONGOS_PT = ("ai", "ei", "oi", "ui", "au", "eu", "iu", "ou", "ão", "ãe",
               "õe", "ãi", "ua", "ue", "uo", "ia", "ie", "io")
DITONGOS_EN = ("ai", "au", "ay", "ea", "ee", "ei", "ey", "ie", "oa", "oi",
               "oo", "ou", "ow", "oy", "ue", "ui")

SILABAS_ALVO = 58        # centro da janela 55-60
SILABAS_MAX = 66         # teto antes de forcar quebra
SILABAS_POR_SEGUNDO = 4.3  # locucao de anuncio, com pausas. Calibre com --ref-dur.
DUR_MIN, DUR_MAX = 3, 15   # limites do Kling


def contar_silabas(texto: str, lang: str) -> int:
    """Conta grupos de vogais, descontando ditongos e 'e' mudo final (en)."""
    ditongos = DITONGOS_PT if lang == "pt" else DITONGOS_EN
    total = 0
    for palavra in re.findall(r"[a-zà-ÿ]+", texto.lower()):
        grupos = re.findall(r"[%s]+" % VOGAIS, palavra)
        n = len(grupos)
        for g in grupos:
            for i in range(len(g) - 1):
                if g[i:i + 2] in ditongos:
                    n -= 1
        if lang == "en" and palavra.endswith("e") and n > 1:
            n -= 1  # silent e
        total += max(n, 1)
    return total


def dividir_frases(texto: str) -> list[str]:
    """Quebra em frases. Fronteira de frase e a emenda preferida."""
    texto = " ".join(texto.split())
    partes = re.split(r"(?<=[.!?…])\s+", texto)
    return [p.strip() for p in partes if p.strip()]


# Preco de emendar dois clipes DEPOIS de cada tipo de unidade. Fronteira de
# frase e de graca; as outras o fatiador so paga onde nao existe alternativa.
# A escala e a do custo de tamanho ((soma - alvo)**2), entao 300 significa
# "prefiro um clipe 17 silabas fora do alvo a cortar numa virgula".
EMENDA_FRASE = 0.0
EMENDA_CLAUSULA = 300.0
EMENDA_PALAVRA = 3000.0

# Folga sobre o teto de 15s. O teto sai de uma estimativa de ritmo em cima de
# uma contagem heuristica de silabas -- passar 10% dele e fala 10% mais rapida,
# nao clipe cortado. Sem essa folga o fatiador partia uma frase inteira ao meio
# para economizar 3 silabas.
FOLGA_TETO = 0.12


def _por_palavra(trecho: str, lang: str) -> list[tuple[str, int, float]]:
    return [(p, contar_silabas(p, lang), EMENDA_PALAVRA) for p in trecho.split()]


def _por_clausula(frase: str, lang: str, teto: int) -> list[tuple[str, int, float]]:
    partes = [p for p in re.split(r"(?<=[,;:—–-])\s+", frase) if p.strip()]
    if len(partes) < 2:
        return _por_palavra(frase, lang)

    unidades: list[tuple[str, int, float]] = []
    for p in partes:
        s = contar_silabas(p, lang)
        if s <= teto:
            unidades.append((p, s, EMENDA_CLAUSULA))
            continue
        # Oracao que sozinha estoura: desce pra palavra, mas a emenda no FIM
        # dela continua valendo o preco de oracao.
        sub = _por_palavra(p, lang)
        unidades.extend(sub[:-1])
        t, ss, _ = sub[-1]
        unidades.append((t, ss, EMENDA_CLAUSULA))
    return unidades


def atomizar(texto: str, lang: str, teto: int) -> list[tuple[str, int, float]]:
    """Menores pedacos que o fatiador pode juntar, com o preco da emenda depois.

    Cortar so em fronteira de frase e o certo -- enquanto existe fronteira de
    frase. Roteiro de anuncio vem em periodo corrido ("here's how to see the
    messages from your boyfriend, girlfriend, husband or wife from your phone
    and the coolest thing is...") e ai nao existe nenhuma: o roteiro inteiro
    virava UM clipe, o Kling devolveria fala acelerada e o passo morria pedindo
    correcao manual -- 75 e 108 silabas em 15s, duas rodadas na mesma semana.

    Entao a frase que sozinha estoura o teto e quebrada em oracao (virgula,
    ponto-e-virgula, travessao) e, se a oracao ainda estourar, em palavra. Cada
    nivel custa mais caro que o de cima, entao o fatiador so desce onde o de
    cima nao resolvia -- um roteiro bem pontuado sai cortado exatamente como
    saia antes.
    """
    atomos: list[tuple[str, int, float]] = []
    for frase in dividir_frases(texto):
        s = contar_silabas(frase, lang)
        if s <= teto:
            atomos.append((frase, s, EMENDA_FRASE))
            continue
        sub = _por_clausula(frase, lang, teto)
        atomos.extend(sub[:-1])
        t, ss, _ = sub[-1]
        atomos.append((t, ss, EMENDA_FRASE))  # o fim da frase continua fronteira de frase
    return atomos


def duracao_kling(silabas: int, ritmo: float) -> int:
    seg = round(silabas / ritmo)
    return max(DUR_MIN, min(DUR_MAX, seg))


def fatiar(texto: str, lang: str, ritmo: float) -> list[dict]:
    """Distribui as unidades do roteiro em N clipes equilibrados.

    Fatiar de forma gulosa deixa um clipe-anao no fim (ex: 46/61/21), e um
    clipe de 4s ao lado de um de 11s da um corte que salta na montagem.
    Entao fixamos N pelo total e miramos total/N em cada clipe: as emendas
    caem no melhor lugar disponivel, mas os pedacos saem parelhos.
    """
    teto = int(DUR_MAX * ritmo)   # um clipe nao pode passar de 15s de fala
    duro = int(teto * (1 + FOLGA_TETO))
    piso = int(DUR_MIN * ritmo)   # nem ficar abaixo de 3s

    # Piso no teto que manda atomizar: com --ref-dur absurdo (roteiro de tres
    # palavras num video de 40s) o teto vira 2 silabas e a frase inteira desceria
    # pra palavra a toa. Abaixo disso o ritmo estimado e que esta errado.
    atomos = atomizar(texto, lang, max(teto, 24))
    if not atomos:
        return []

    total = sum(s for _, s, _ in atomos)
    n_clipes = max(1, round(total / SILABAS_ALVO))
    while n_clipes < len(atomos) and total / n_clipes > teto:
        n_clipes += 1
    n_clipes = min(n_clipes, len(atomos))
    alvo = total / n_clipes

    # Particao otima por programacao dinamica: divide as unidades em n_clipes
    # grupos CONTIGUOS minimizando desvio em relacao ao alvo MAIS o preco das
    # emendas. Guloso deixava clipe-anao ao lado de clipe-teto (46/23/59), e
    # corte de 6s colado num de 15s salta na montagem. Com poucas unidades o
    # custo do DP e irrisorio.
    n = len(atomos)
    pref = [0] * (n + 1)
    for i, (_, s, _e) in enumerate(atomos):
        pref[i + 1] = pref[i] + s

    def custo(i: int, j: int) -> float:
        """Custo do grupo atomos[i:j]."""
        soma = pref[j] - pref[i]
        pen = 0.0
        if soma > teto:                      # fala comprimida: cresce rapido
            pen += 30 * (soma - teto) ** 2
        if soma > duro:                      # estoura o Kling: proibido na pratica
            pen += 1e6 * (soma - duro)
        if soma < piso and j - i < n:        # curto demais para virar clipe
            pen += 1e3 * (piso - soma)
        if j < n:                            # onde este clipe emenda no proximo
            pen += atomos[j - 1][2]
        return (soma - alvo) ** 2 + pen

    INF = float("inf")
    # dp[k][j] = melhor custo usando k grupos para as j primeiras unidades
    dp = [[INF] * (n + 1) for _ in range(n_clipes + 1)]
    corte = [[0] * (n + 1) for _ in range(n_clipes + 1)]
    dp[0][0] = 0.0
    for k in range(1, n_clipes + 1):
        for j in range(k, n - (n_clipes - k) + 1):
            for i in range(k - 1, j):
                if dp[k - 1][i] == INF:
                    continue
                c = dp[k - 1][i] + custo(i, j)
                if c < dp[k][j]:
                    dp[k][j] = c
                    corte[k][j] = i

    limites, j = [], n
    for k in range(n_clipes, 0, -1):
        i = corte[k][j]
        limites.append((i, j))
        j = i
    limites.reverse()

    clipes = [
        (" ".join(t for t, _, _ in atomos[i:j]), pref[j] - pref[i])
        for i, j in limites
    ]

    return [
        {
            "n": i,
            "texto": t,
            "silabas": s,
            "duracao_kling": duracao_kling(s, ritmo),
        }
        for i, (t, s) in enumerate(clipes, 1)
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("arquivo", help="arquivo do roteiro, ou - para stdin")
    ap.add_argument("--lang", choices=["pt", "en"], default="pt")
    ap.add_argument("--ref-dur", type=float, metavar="SEG",
                    help="duracao real do criativo de referencia, em segundos. "
                         "Calibra o ritmo no proprio original -- use sempre que tiver.")
    ap.add_argument("--ritmo", type=float, metavar="SIL/S",
                    help=f"silabas por segundo, se voce ja sabe (default {SILABAS_POR_SEGUNDO})")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    texto = sys.stdin.read() if args.arquivo == "-" else open(args.arquivo, encoding="utf-8").read()
    if not texto.strip():
        print("roteiro vazio", file=sys.stderr)
        return 1

    total_silabas = contar_silabas(texto, args.lang)

    if args.ritmo:
        ritmo, origem = args.ritmo, "informado"
    elif args.ref_dur and args.ref_dur > 0:
        ritmo = total_silabas / args.ref_dur
        origem = f"calibrado no original ({total_silabas} sil / {args.ref_dur:g}s)"
    else:
        ritmo, origem = SILABAS_POR_SEGUNDO, "DEFAULT GENERICO — passe --ref-dur"

    clipes = fatiar(texto, args.lang, ritmo)

    if args.as_json:
        print(json.dumps({"ritmo": round(ritmo, 2), "clipes": clipes},
                         ensure_ascii=False, indent=2))
        return 0

    total_d = sum(c["duracao_kling"] for c in clipes)
    print(f"{len(clipes)} clipes · {total_silabas} silabas · ~{total_d}s")
    print(f"ritmo: {ritmo:.2f} sil/s ({origem})\n")
    for c in clipes:
        print(f"[{c['n']}] {c['silabas']} sil · {c['duracao_kling']}s")
        print(f"    {c['texto']}\n")

    if args.ref_dur:
        delta = total_d - args.ref_dur
        if abs(delta) > 2:
            print(f"AVISO: soma dos clipes ({total_d}s) foge {delta:+.0f}s do original "
                  f"({args.ref_dur:g}s) — o arredondamento por clipe acumulou.\n"
                  f"Ajuste a duracao de um clipe na mao para fechar.")
        else:
            print(f"Soma bate com o original ({args.ref_dur:g}s), folga de {delta:+.0f}s.")
    else:
        print("Sem --ref-dur o ritmo e um chute. Rode /watch no criativo de\n"
              "referencia, pegue a duracao real e passe aqui.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
