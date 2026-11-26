# -*- coding: utf-8 -*-
"""Geometría preliminar y registro auditable de ubicaciones candidatas CRAI.

Todas las coordenadas de este módulo están expresadas en unidades SVG del
croquis (viewBox 590 x 430). No son metros ni coordenadas de obra.
"""
from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

VIEWBOX = "0 0 590 430"
MESAS_EXISTENTES = 48
SILLAS_EXISTENTES = 193
SOFAS_EXISTENTES = 4
PERSONAS_POR_SOFA = 2

# Polígonos de zonas de estudio trazados visualmente sobre el croquis v0.3.
ZONAS_ESTUDIO: Dict[str, List[Tuple[float, float]]] = {
    "SUPERIOR": [(205, 132), (478, 145), (512, 211), (490, 225), (208, 226), (183, 185)],
    "INFERIOR": [(151, 236), (492, 228), (492, 360), (389, 323), (264, 317), (153, 356)],
}

# Ejes de circulación y rutas verdes del croquis. El margen es gráfico, no normativo.
RUTAS_SVG = [
    ((128, 224), (505, 224)),
    ((321, 126), (321, 212)),
    ((132, 158), (163, 215)),
    ((163, 215), (178, 268)),
    ((218, 92), (225, 212)),
    ((519, 168), (505, 221)),
    ((505, 221), (491, 286)),
    # Tramo rojo superior de evacuación y tramo de escalera; este último queda fuera de las zonas.
    ((337, 108), (466, 124)),
    ((58, 282), (100, 350)),
]
MARGEN_RUTA_SVG = 10.0

# Cinco columnas/obstáculos cuadrados visibles en la vectorización v0.3.
# El rectángulo incluye una pequeña holgura gráfica de cribado.
COLUMNAS_SVG = [
    (236, 212, 15, 15),
    (320, 209, 15, 15),
    (408, 217, 15, 15),
    (464, 240, 15, 15),
    (282, 300, 15, 15),
]

# Sofás dibujados en el SVG. Se conserva su ubicación esquemática, no una huella medida.
SOFAS_SVG = {
    1: (188, 274, 30, 13),
    2: (222, 274, 30, 13),
    3: (188, 291, 30, 13),
    4: (222, 291, 30, 13),
}
MARGEN_SOFA_SVG = 4.0
ESCENARIOS_SOFAS = {
    "A": [1, 2, 3, 4],
    "B": [1, 2],
    "C": [],
}
NOMBRES_ESCENARIOS = {
    "A": "A · Conservar los 4 sofás",
    "B": "B · Conservar 2 sofás",
    "C": "C · Retirar los 4 sofás",
}

# Envolvente gráfica que coincide con el bloque candidato del croquis SVG actual.
# No se presenta como huella física métrica porque la escala está sin calibrar.
BLOQUE_ANCHO_SVG = 20.0
BLOQUE_ALTO_SVG = 18.0
PASO_X_SVG = 24
PASO_Y_SVG = 20


def punto_en_poligono(x: float, y: float, poligono: Sequence[Tuple[float, float]]) -> bool:
    dentro = False
    j = len(poligono) - 1
    for i in range(len(poligono)):
        xi, yi = poligono[i]
        xj, yj = poligono[j]
        if ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
        ):
            dentro = not dentro
        j = i
    return dentro


def rectangulo_dentro_de_zona(rect, poligono) -> bool:
    """Comprueba una malla 6x6 dentro del rectángulo candidato."""
    x, y, w, h = rect
    for ix in range(6):
        for iy in range(6):
            px = x + 1 + (w - 2) * ix / 5
            py = y + 1 + (h - 2) * iy / 5
            if not punto_en_poligono(px, py, poligono):
                return False
    return True


def punto_rectangulo_distancia(px: float, py: float, rect) -> float:
    rx, ry, rw, rh = rect
    dx = max(rx - px, 0.0, px - (rx + rw))
    dy = max(ry - py, 0.0, py - (ry + rh))
    return math.hypot(dx, dy)


def distancia_segmento_rectangulo(a, b, rect) -> float:
    """Distancia conservadora aproximada, muestreando cada 2 unidades SVG."""
    longitud = math.hypot(b[0] - a[0], b[1] - a[1])
    pasos = max(2, int(math.ceil(longitud / 2.0)))
    return min(
        punto_rectangulo_distancia(
            a[0] + (b[0] - a[0]) * k / pasos,
            a[1] + (b[1] - a[1]) * k / pasos,
            rect,
        )
        for k in range(pasos + 1)
    )


def rectangulos_se_superponen(a, b, holgura: float = 0.0) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (
        ax + aw + holgura <= bx
        or bx + bw + holgura <= ax
        or ay + ah + holgura <= by
        or by + bh + holgura <= ay
    )


def rectangulo_libre_de_rutas(rect) -> bool:
    return all(
        distancia_segmento_rectangulo(a, b, rect) >= MARGEN_RUTA_SVG
        for a, b in RUTAS_SVG
    )


def obstaculos_sofas(codigo: str) -> List[Tuple[float, float, float, float]]:
    if codigo not in ESCENARIOS_SOFAS:
        raise ValueError(f"Escenario desconocido: {codigo}")
    rects = []
    for sofa_id in ESCENARIOS_SOFAS[codigo]:
        x, y, w, h = SOFAS_SVG[sofa_id]
        rects.append((
            x - MARGEN_SOFA_SVG,
            y - MARGEN_SOFA_SVG,
            w + 2 * MARGEN_SOFA_SVG,
            h + 2 * MARGEN_SOFA_SVG,
        ))
    return rects


def generar_registro_candidatas() -> List[dict]:
    """Crea la malla completa y documenta los motivos de aceptación/rechazo.

    Se evalúan 136 anclajes gráficos posibles. El filtro aplica:
    1) pertenencia a la zona de estudio;
    2) separación gráfica respecto de rutas;
    3) separación gráfica respecto de columnas.
    El filtro no equivale a comprobación física en metros.
    """
    registro: List[dict] = []
    secuencia = 1
    definiciones = [
        ("SUPERIOR", ZONAS_ESTUDIO["SUPERIOR"], range(190, 490, PASO_X_SVG), range(140, 215, PASO_Y_SVG)),
        ("INFERIOR", ZONAS_ESTUDIO["INFERIOR"], range(160, 490, PASO_X_SVG), range(244, 350, PASO_Y_SVG)),
    ]

    for zona, poligono, xs, ys in definiciones:
        for y in ys:
            for x in xs:
                rect = (float(x), float(y), BLOQUE_ANCHO_SVG, BLOQUE_ALTO_SVG)
                dentro = rectangulo_dentro_de_zona(rect, poligono)
                libre_rutas = rectangulo_libre_de_rutas(rect) if dentro else False
                libre_columnas = not any(rectangulos_se_superponen(rect, c) for c in COLUMNAS_SVG) if dentro and libre_rutas else False
                if not dentro:
                    motivo = "Fuera del polígono de estudio"
                elif not libre_rutas:
                    motivo = "Interfiere con banda gráfica de circulación/ruta"
                elif not libre_columnas:
                    motivo = "Interfiere con columna u obstáculo fijo representado"
                else:
                    motivo = "Apta para cribado gráfico preliminar; requiere validación física"

                fila = {
                    "id": f"P{secuencia:03d}",
                    "zona": zona,
                    "x_svg": x,
                    "y_svg": y,
                    "ancho_svg": BLOQUE_ANCHO_SVG,
                    "alto_svg": BLOQUE_ALTO_SVG,
                    "dentro_zona": dentro,
                    "libre_rutas": libre_rutas,
                    "libre_columnas": libre_columnas,
                    "apta_base": dentro and libre_rutas and libre_columnas,
                    "motivo_base": motivo,
                }
                for codigo in ("A", "B", "C"):
                    sof_obstacles = obstaculos_sofas(codigo)
                    libre_sofas = not any(rectangulos_se_superponen(rect, obs) for obs in sof_obstacles)
                    fila[f"libre_sofas_{codigo}"] = libre_sofas
                    fila[f"elegible_{codigo}"] = fila["apta_base"] and libre_sofas
                    if not fila["apta_base"]:
                        fila[f"motivo_{codigo}"] = motivo
                    elif not libre_sofas:
                        fila[f"motivo_{codigo}"] = "Interfiere con sofá conservado en este escenario"
                    else:
                        fila[f"motivo_{codigo}"] = "Apta en cribado SVG; no validada en campo"
                fila["estado_metrico"] = "NO_CALIBRADO"
                fila["unidades_coordenadas"] = "SVG"
                registro.append(fila)
                secuencia += 1
    return registro


REGISTRO_CANDIDATAS = generar_registro_candidatas()
CANDIDATOS_BASE = [
    {
        "id": f["id"],
        "zona": f["zona"],
        "x": f["x_svg"],
        "y": f["y_svg"],
        "ancho_svg": f["ancho_svg"],
        "alto_svg": f["alto_svg"],
        "rect": (f["x_svg"], f["y_svg"], f["ancho_svg"], f["alto_svg"]),
    }
    for f in REGISTRO_CANDIDATAS
    if f["apta_base"]
]


def candidatos_escenario(codigo: str) -> List[dict]:
    return [
        c.copy()
        for c in CANDIDATOS_BASE
        if next(f for f in REGISTRO_CANDIDATAS if f["id"] == c["id"])[f"elegible_{codigo}"]
    ]


def resumen_validacion_candidatas() -> dict:
    total = len(REGISTRO_CANDIDATAS)
    dentro = sum(1 for f in REGISTRO_CANDIDATAS if f["dentro_zona"])
    ruta = sum(1 for f in REGISTRO_CANDIDATAS if f["dentro_zona"] and f["libre_rutas"])
    base = sum(1 for f in REGISTRO_CANDIDATAS if f["apta_base"])
    return {
        "total_anclajes_evaluados": total,
        "dentro_de_zona": dentro,
        "libres_de_rutas": ruta,
        "aptas_base": base,
        "descartadas_fuera_zona": total - dentro,
        "descartadas_por_rutas": dentro - ruta,
        "descartadas_por_columnas": ruta - base,
        "escenarios": {
            codigo: {
                "nombre": NOMBRES_ESCENARIOS[codigo],
                "sofas_conservados": len(ESCENARIOS_SOFAS[codigo]),
                "candidatas_elegibles": sum(1 for f in REGISTRO_CANDIDATAS if f[f"elegible_{codigo}"]),
                "descartadas_por_sofas": sum(1 for f in REGISTRO_CANDIDATAS if f["apta_base"] and not f[f"libre_sofas_{codigo}"]),
            }
            for codigo in ("A", "B", "C")
        },
        "incompatibilidades_entre_candidatas": contar_incompatibilidades(CANDIDATOS_BASE),
        "estado": "CRIBADO_GEOMETRICO_PRELIMINAR_EN_SVG",
        "validacion_fisica": False,
        "nota": (
            "La malla se valida respecto de polígonos, rutas y columnas trazados en SVG. "
            "No certifica distancias, áreas, pasillos ni colisiones en metros por falta de escala uniforme validada."
        ),
    }


def contar_incompatibilidades(candidatos: Sequence[dict]) -> int:
    total = 0
    for i in range(len(candidatos)):
        for j in range(i + 1, len(candidatos)):
            if rectangulos_se_superponen(candidatos[i]["rect"], candidatos[j]["rect"]):
                total += 1
    return total


def exportar_base_csv(carpeta: Path) -> Path:
    ruta = carpeta / "base_ubicaciones_crai_v01.csv"
    campos = [
        "id", "zona", "x_svg", "y_svg", "ancho_svg", "alto_svg",
        "dentro_zona", "libre_rutas", "libre_columnas", "apta_base",
        "libre_sofas_A", "elegible_A", "motivo_A",
        "libre_sofas_B", "elegible_B", "motivo_B",
        "libre_sofas_C", "elegible_C", "motivo_C",
        "motivo_base", "estado_metrico", "unidades_coordenadas",
    ]
    with ruta.open("w", newline="", encoding="utf-8-sig") as archivo:
        writer = csv.DictWriter(archivo, fieldnames=campos, delimiter=";")
        writer.writeheader()
        for fila in REGISTRO_CANDIDATAS:
            writer.writerow({k: fila.get(k, "") for k in campos})
    return ruta


def exportar_resumen_txt(carpeta: Path) -> Path:
    r = resumen_validacion_candidatas()
    ruta = carpeta / "informe_validacion_ubicaciones_crai_v01.txt"
    lineas = [
        "VALIDACIÓN PRELIMINAR DE UBICACIONES CANDIDATAS · CRAI UPeU JULIACA",
        "Versión: Punto 2 · v0.1",
        "",
        f"Anclajes evaluados: {r['total_anclajes_evaluados']}",
        f"Dentro de zona de estudio: {r['dentro_de_zona']}",
        f"Libres de bandas de ruta: {r['libres_de_rutas']}",
        f"Aptas en cribado base: {r['aptas_base']}",
        f"Descartadas fuera de zona: {r['descartadas_fuera_zona']}",
        f"Descartadas por rutas: {r['descartadas_por_rutas']}",
        f"Descartadas por columnas: {r['descartadas_por_columnas']}",
        f"Incompatibilidades entre candidatas base: {r['incompatibilidades_entre_candidatas']}",
        "",
        "Candidatas por escenario:",
    ]
    for codigo, dato in r["escenarios"].items():
        lineas.append(
            f"  {codigo}: {dato['candidatas_elegibles']} candidatas; "
            f"{dato['descartadas_por_sofas']} descartadas por sofás conservados."
        )
    lineas += [
        "",
        "ALCANCE Y LIMITACIONES",
        "- Las posiciones están expresadas en unidades SVG del dibujo 590 x 430.",
        "- El bloque candidato de 20 x 18 unidades es una envolvente gráfica de cribado, no una huella métrica certificada.",
        "- Los polígonos, rutas, columnas y sofás se trazaron visualmente desde el croquis y fotografías.",
        "- La diferencia entre factores de escala horizontal y vertical sigue sin resolverse.",
        "- El cribado solo comprueba pertenencia al polígono, distancia gráfica a rutas, columnas y sofás de cada escenario.",
        "- No certifica ancho de pasillo, accesibilidad, evacuación, área útil, ni colisiones físicas en metros.",
        "- Las posiciones y las dimensiones de mobiliario requieren levantamiento y validación en campo.",
        "- No presentar esta lista como aprobación de seguridad ni como plano listo para implementación.",
        "",
        "Interpretación: 'apta' significa apta para continuar el análisis geométrico en la vectorización SVG, no físicamente aprobada.",
    ]
    ruta.write_text("\n".join(lineas), encoding="utf-8")
    return ruta


if __name__ == "__main__":
    from pathlib import Path
    carpeta = Path(__file__).resolve().parent
    csv_path = exportar_base_csv(carpeta)
    txt_path = exportar_resumen_txt(carpeta)
    print("Base de ubicaciones exportada:", csv_path)
    print("Informe de validación exportado:", txt_path)
    print(resumen_validacion_candidatas())
