# -*- coding: utf-8 -*-
"""Motor PLEM espacial CRAI v0.6: mesa y huellas individuales de sillas por configuración y orientación.

Compatible con PuLP 4.x y CBC mediante pulp.COIN_CMD.

Cada alternativa está definida por (anclaje, configuración de 2/3/4 sillas,
orientación horizontal/vertical). La huella envolvente de cada configuración es
específica y se comprueba contra polígonos, rutas, columnas, sofás retenidos y
otras envolventes seleccionadas.

IMPORTANTE: las coordenadas son SVG y las envolventes se trasladan al dibujo con
una escala gráfica LOCAL derivada del símbolo de mesa. Esta escala local no
calibra el edificio. Las dimensiones de mesa son las informadas; silla, sofá y
proyección de uso son estimaciones. El resultado es un cribado geométrico de
proyecto, no un plano métrico, aprobación de evacuación ni validación en campo.
"""
from __future__ import annotations

import csv
import json
import math
import os
import sys
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Tuple

LIBRERIAS = Path(r"D:\Librerias_Python")
if LIBRERIAS.exists() and str(LIBRERIAS) not in sys.path:
    sys.path.insert(0, str(LIBRERIAS))
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

try:
    import pulp
except ImportError as exc:
    raise RuntimeError(
        "No se pudo importar PuLP. Comprueba D:\\Librerias_Python y el Python del servidor."
    ) from exc

try:
    import geometria_ubicaciones_crai as geo
except ImportError as exc:
    raise RuntimeError(
        "Falta geometria_ubicaciones_crai.py. Debe estar junto a este motor."
    ) from exc

MESAS_EXISTENTES = int(geo.MESAS_EXISTENTES)
SILLAS_EXISTENTES = int(geo.SILLAS_EXISTENTES)
PERSONAS_POR_SOFA = int(geo.PERSONAS_POR_SOFA)
DEMANDA_PREDETERMINADA = 248
CONFIGURACIONES = (2, 3, 4)
ORIENTACIONES = ("H", "V")
ESCENARIOS = ("A", "B", "C")
VERSION_MOTOR = "0.10-motor-rapido-lexicografico"

# Medidas base. La mesa es dato informado; silla y proyección de uso son estimaciones.
MESA_ANCHO_M = 1.20
MESA_PROFUNDIDAD_M = 0.60
SILLA_ANCHO_M_ESTIMADO = 0.45
SILLA_PROFUNDIDAD_M_ESTIMADA = 0.50
PROYECCION_SILLA_USO_M = 0.50

# Una silla en un lado largo proyecta 0.50 m desde el borde de la mesa.
# Configuración 2: 2 sillas en un lado largo.
# Configuración 3: 2 sillas en un lado largo y 1 en un extremo corto.
# Configuración 4: 2 sillas en cada lado largo.
ENVOLVENTES_M = {
    2: {"ancho": 1.20, "profundidad": 1.10, "disposicion": "Dos sillas en un lado largo"},
    3: {"ancho": 1.70, "profundidad": 1.10, "disposicion": "Dos sillas en un lado largo y una en un extremo corto"},
    4: {"ancho": 1.20, "profundidad": 1.60, "disposicion": "Dos sillas en cada lado largo"},
}

# Escala visual LOCAL calculada desde el icono de mesa del propio SVG (17 x 9 u)
# frente a la mesa informada (1.20 x 0.60 m). No es escala arquitectónica del plano.
UNIDADES_SVG_POR_M_VISUAL = ((17.0 / MESA_ANCHO_M) + (9.0 / MESA_PROFUNDIDAD_M)) / 2.0
PASO_MALLA_SVG = 12
PASO_MALLA_RAPIDA_SVG = 18
TIEMPO_RAPIDO_SEGUNDOS = 60
BRECHA_RAPIDA_RELATIVA = 0.02
MARGEN_LIMITE_POLIGONO_SVG = 5.0
SEPARACION_ENTRE_ENVOLVENTES_M = 0.10
SEPARACION_ENTRE_ENVOLVENTES_SVG = SEPARACION_ENTRE_ENVOLVENTES_M * UNIDADES_SVG_POR_M_VISUAL


def crear_solver(time_limit=None, gap_rel=None, threads=None):
    """Crea CBC con presolve/cortes y parámetros opcionales de exploración."""
    if not hasattr(pulp, "COIN_CMD"):
        raise RuntimeError("La instalación actual de PuLP no expone COIN_CMD.")
    if threads is None:
        threads = max(1, min(4, os.cpu_count() or 1))
    kwargs = {
        "msg": False,
        "presolve": True,
        "cuts": True,
        "threads": int(threads),
        "timeMode": "elapsed",
        "randomSeed": 42,
    }
    if time_limit is not None:
        kwargs["timeLimit"] = float(time_limit)
    if gap_rel is not None:
        kwargs["gapRel"] = float(gap_rel)
    try:
        return pulp.COIN_CMD(**kwargs)
    except TypeError:
        # Compatibilidad defensiva con compilaciones de PuLP que no expongan
        # algún parámetro opcional. Nunca se elimina el límite de rigor en modo exacto.
        kwargs.pop("randomSeed", None)
        return pulp.COIN_CMD(**kwargs)


def comprobar_solver():
    solver = crear_solver()
    ruta = solver.available()
    if not ruta:
        raise RuntimeError(
            "PuLP está instalado, pero CBC no está disponible. Comprueba D:\\Librerias_Python."
        )
    return solver, str(ruta)


def _estado(modelo, resultado) -> str:
    texto = getattr(resultado, "status_str", None)
    if texto:
        return str(texto)
    return str(pulp.LpStatus.get(modelo.status, modelo.status))


def _tiene_solucion(modelo, resultado) -> bool:
    flag = getattr(resultado, "has_solution", None)
    if flag is not None:
        return bool(flag)
    # Respaldo para instalaciones que no exponen el atributo has_solution.
    variables = modelo.variables()
    return bool(variables) and all(v.value() is not None for v in variables)


def _valor_entero(variable, nombre: str) -> int:
    valor = variable.value()
    if valor is None:
        raise RuntimeError(f"CBC no devolvió valor para {nombre}.")
    return int(round(float(valor)))


def _resolver(modelo, solver, etapa: str, permitir_factible=False):
    resultado = modelo.solve(solver)
    estado = _estado(modelo, resultado)
    hay_solucion = _tiene_solucion(modelo, resultado)
    if estado.lower() == "optimal":
        return estado, True
    if permitir_factible and hay_solucion:
        return estado, False
    raise RuntimeError(f"CBC no obtuvo una solución aceptable en {etapa}: {estado}; solución factible={hay_solucion}.")

def _dimensiones_env_m(k: int, orientacion: str) -> Tuple[float, float]:
    base = ENVOLVENTES_M[k]
    ancho, profundidad = float(base["ancho"]), float(base["profundidad"])
    return (profundidad, ancho) if orientacion == "V" else (ancho, profundidad)


def _rectangulo_dentro_de_zona(rect, poligono) -> bool:
    """Muestrea el interior del rectángulo; evita usar puntos exactos del borde SVG."""
    x, y, w, h = rect
    if w <= 2 or h <= 2:
        return False
    muestras = 9
    for ix in range(muestras + 1):
        for iy in range(muestras + 1):
            px = x + 1.0 + (w - 2.0) * ix / muestras
            py = y + 1.0 + (h - 2.0) * iy / muestras
            if not geo.punto_en_poligono(px, py, poligono):
                return False
    return True


def _rectangulo_configuracion(cx: float, cy: float, k: int, orientacion: str):
    ancho_m, profundidad_m = _dimensiones_env_m(k, orientacion)
    w = ancho_m * UNIDADES_SVG_POR_M_VISUAL
    h = profundidad_m * UNIDADES_SVG_POR_M_VISUAL
    return (cx - w / 2.0, cy - h / 2.0, w, h)


def _geometria_interna_mueble(rect, k: int, orientacion: str) -> dict:
    """Devuelve rectángulos SVG individuales para mesa y sillas de la configuración."""
    x, y, _w, _h = rect
    s = UNIDADES_SVG_POR_M_VISUAL
    tw = MESA_ANCHO_M * s
    th = MESA_PROFUNDIDAD_M * s
    chair_w = SILLA_ANCHO_M_ESTIMADO * s
    chair_d = SILLA_PROFUNDIDAD_M_ESTIMADA * s
    proj = PROYECCION_SILLA_USO_M * s

    def silla(cx: float, cy: float, ancho: float = chair_w, alto: float = chair_d) -> dict:
        return {"x": cx - ancho / 2.0, "y": cy - alto / 2.0, "ancho": ancho, "alto": alto}

    if orientacion == "H":
        if k == 2:
            mesa = {"x": x, "y": y, "ancho": tw, "alto": th}
            cy = y + th + chair_d / 2.0
            sillas = [silla(x + tw / 4.0, cy), silla(x + 3.0 * tw / 4.0, cy)]
        elif k == 3:
            mesa = {"x": x, "y": y, "ancho": tw, "alto": th}
            cy = y + th + chair_d / 2.0
            sillas = [
                silla(x + tw / 4.0, cy),
                silla(x + 3.0 * tw / 4.0, cy),
                silla(x + tw + chair_d / 2.0, y + th / 2.0, ancho=chair_d, alto=chair_w),
            ]
        else:
            mesa_y = y + proj
            mesa = {"x": x, "y": mesa_y, "ancho": tw, "alto": th}
            y_sup = y + chair_d / 2.0
            y_inf = mesa_y + th + chair_d / 2.0
            sillas = [
                silla(x + tw / 4.0, y_sup),
                silla(x + 3.0 * tw / 4.0, y_sup),
                silla(x + tw / 4.0, y_inf),
                silla(x + 3.0 * tw / 4.0, y_inf),
            ]
    else:
        tvw, tvh = th, tw
        if k == 2:
            mesa = {"x": x, "y": y, "ancho": tvw, "alto": tvh}
            cx_chair = x + tvw + chair_d / 2.0
            sillas = [
                silla(cx_chair, y + tvh / 4.0, ancho=chair_d, alto=chair_w),
                silla(cx_chair, y + 3.0 * tvh / 4.0, ancho=chair_d, alto=chair_w),
            ]
        elif k == 3:
            mesa = {"x": x, "y": y, "ancho": tvw, "alto": tvh}
            cx_chair = x + tvw + chair_d / 2.0
            sillas = [
                silla(cx_chair, y + tvh / 4.0, ancho=chair_d, alto=chair_w),
                silla(cx_chair, y + 3.0 * tvh / 4.0, ancho=chair_d, alto=chair_w),
                silla(x + tvw / 2.0, y + tvh + chair_d / 2.0),
            ]
        else:
            mesa_x = x + proj
            mesa = {"x": mesa_x, "y": y, "ancho": tvw, "alto": tvh}
            x_izq = x + chair_d / 2.0
            x_der = mesa_x + tvw + chair_d / 2.0
            sillas = [
                silla(x_izq, y + tvh / 4.0, ancho=chair_d, alto=chair_w),
                silla(x_izq, y + 3.0 * tvh / 4.0, ancho=chair_d, alto=chair_w),
                silla(x_der, y + tvh / 4.0, ancho=chair_d, alto=chair_w),
                silla(x_der, y + 3.0 * tvh / 4.0, ancho=chair_d, alto=chair_w),
            ]

    return {"mesa_svg": mesa, "sillas_svg": sillas}


def _rect_en_rect(rect_interno: dict, rect_externo: tuple, tolerancia: float = 1e-6) -> bool:
    x, y, w, h = rect_externo
    return (
        rect_interno["x"] >= x - tolerancia
        and rect_interno["y"] >= y - tolerancia
        and rect_interno["x"] + rect_interno["ancho"] <= x + w + tolerancia
        and rect_interno["y"] + rect_interno["alto"] <= y + h + tolerancia
    )


def _rect_dict_se_superponen(a: dict, b: dict, tolerancia: float = 1e-6) -> bool:
    return not (
        a["x"] + a["ancho"] <= b["x"] + tolerancia
        or b["x"] + b["ancho"] <= a["x"] + tolerancia
        or a["y"] + a["alto"] <= b["y"] + tolerancia
        or b["y"] + b["alto"] <= a["y"] + tolerancia
    )


def _validar_geometria_interna(rect: tuple, mueble: dict, k: int) -> None:
    """Comprueba que mesa y sillas dibujadas estén dentro de la envolvente y no se crucen."""
    mesa = mueble["mesa_svg"]
    sillas = mueble["sillas_svg"]
    if len(sillas) != k:
        raise RuntimeError(f"La configuración de {k} sillas generó {len(sillas)} sillas gráficas.")
    if not _rect_en_rect(mesa, rect):
        raise RuntimeError("La mesa quedó fuera de la envolvente de su configuración.")
    for i, silla in enumerate(sillas):
        if not _rect_en_rect(silla, rect):
            raise RuntimeError(f"La silla {i + 1} quedó fuera de la envolvente de su configuración.")
        if _rect_dict_se_superponen(mesa, silla):
            raise RuntimeError(f"La silla {i + 1} se superpone con la mesa.")
        for j in range(i + 1, len(sillas)):
            if _rect_dict_se_superponen(silla, sillas[j]):
                raise RuntimeError(f"Las sillas {i + 1} y {j + 1} se superponen.")


def generar_anclajes_malla(paso_malla: int = PASO_MALLA_SVG) -> List[dict]:
    """Genera una malla SVG; el paso puede ser 18 (exploración) o 12 (fina)."""
    paso_malla = int(paso_malla)
    if paso_malla < 6 or paso_malla > 36:
        raise ValueError("El paso de malla debe estar entre 6 y 36 unidades SVG.")
    anclajes = []
    contador_global = 1
    for zona, poligono in geo.ZONAS_ESTUDIO.items():
        xmin = math.ceil(min(p[0] for p in poligono) + MARGEN_LIMITE_POLIGONO_SVG)
        xmax = math.floor(max(p[0] for p in poligono) - MARGEN_LIMITE_POLIGONO_SVG)
        ymin = math.ceil(min(p[1] for p in poligono) + MARGEN_LIMITE_POLIGONO_SVG)
        ymax = math.floor(max(p[1] for p in poligono) - MARGEN_LIMITE_POLIGONO_SVG)
        secuencia_zona = 1
        for cy in range(ymin, ymax + 1, paso_malla):
            for cx in range(xmin, xmax + 1, paso_malla):
                anclajes.append({
                    "id": f"{zona[:3]}_{paso_malla}_{secuencia_zona:04d}",
                    "zona": zona,
                    "x_svg": float(cx),
                    "y_svg": float(cy),
                    "secuencia": contador_global,
                })
                secuencia_zona += 1
                contador_global += 1
    return anclajes


ANCLAJES_MALLA = generar_anclajes_malla(PASO_MALLA_SVG)

@lru_cache(maxsize=9)
def generar_variantes_candidatas(codigo: str, paso_malla: int = PASO_MALLA_SVG) -> tuple:
    """Genera variantes factibles y las conserva en caché por escenario y resolución."""
    if codigo not in ESCENARIOS:
        raise ValueError(f"Escenario desconocido: {codigo}")
    paso_malla = int(paso_malla)
    anclajes = ANCLAJES_MALLA if paso_malla == PASO_MALLA_SVG else generar_anclajes_malla(paso_malla)
    sofas = geo.obstaculos_sofas(codigo)
    variantes = []
    for anclaje in anclajes:
        poligono = geo.ZONAS_ESTUDIO[anclaje["zona"]]
        cx, cy = anclaje["x_svg"], anclaje["y_svg"]
        for k in CONFIGURACIONES:
            for orientacion in ORIENTACIONES:
                rect = _rectangulo_configuracion(cx, cy, k, orientacion)
                if not _rectangulo_dentro_de_zona(rect, poligono):
                    continue
                if not geo.rectangulo_libre_de_rutas(rect):
                    continue
                if any(geo.rectangulos_se_superponen(rect, obstaculo) for obstaculo in geo.COLUMNAS_SVG):
                    continue
                if any(geo.rectangulos_se_superponen(rect, sofa) for sofa in sofas):
                    continue
                ancho_m, profundidad_m = _dimensiones_env_m(k, orientacion)
                mobiliario = _geometria_interna_mueble(rect, k, orientacion)
                _validar_geometria_interna(rect, mobiliario, k)
                variantes.append({
                    "id": f"{anclaje['id']}-K{k}-{orientacion}",
                    "anclaje_id": anclaje["id"],
                    "zona": anclaje["zona"],
                    "configuracion": int(k),
                    "orientacion": orientacion,
                    "x": float(rect[0]),
                    "y": float(rect[1]),
                    "ancho_svg": float(rect[2]),
                    "alto_svg": float(rect[3]),
                    "rect": tuple(float(v) for v in rect),
                    "ancho_env_m": float(ancho_m),
                    "profundidad_env_m": float(profundidad_m),
                    "area_env_m2": float(ancho_m * profundidad_m),
                    "mesa_svg": mobiliario["mesa_svg"],
                    "sillas_svg": mobiliario["sillas_svg"],
                })
    return tuple(variantes)


def _pares_incompatibles_eficientes(variantes: list) -> list:
    """Barrido por eje X: compara solo envolventes que pueden solaparse."""
    gap = SEPARACION_ENTRE_ENVOLVENTES_SVG
    orden = sorted(range(len(variantes)), key=lambda idx: variantes[idx]["rect"][0])
    activos = []
    pares = []
    for i in orden:
        rect_i = variantes[i]["rect"]
        x_i = rect_i[0]
        activos = [
            j for j in activos
            if variantes[j]["rect"][0] + variantes[j]["rect"][2] + gap > x_i
        ]
        for j in activos:
            if variantes[i]["anclaje_id"] == variantes[j]["anclaje_id"]:
                continue
            rect_j = variantes[j]["rect"]
            # Filtro vertical barato antes de la comprobación geométrica exacta.
            if rect_i[1] + rect_i[3] + gap <= rect_j[1] or rect_j[1] + rect_j[3] + gap <= rect_i[1]:
                continue
            if geo.rectangulos_se_superponen(rect_i, rect_j, holgura=gap):
                pares.append((min(i, j), max(i, j)))
        activos.append(i)
    return pares

def resumen_huellas_configuracion() -> dict:
    return {
        "factor_visual_local_svg_por_m": UNIDADES_SVG_POR_M_VISUAL,
        "fuente_factor_visual": "Promedio del símbolo de mesa 17/1.20 y 9/0.60; no calibra la planta completa.",
        "proyeccion_silla_uso_m": PROYECCION_SILLA_USO_M,
        "separacion_entre_envolventes_m": SEPARACION_ENTRE_ENVOLVENTES_M,
        "configuraciones": {
            str(k): {
                "ancho_m": ENVOLVENTES_M[k]["ancho"],
                "profundidad_m": ENVOLVENTES_M[k]["profundidad"],
                "area_m2": ENVOLVENTES_M[k]["ancho"] * ENVOLVENTES_M[k]["profundidad"],
                "disposicion": ENVOLVENTES_M[k]["disposicion"],
            }
            for k in CONFIGURACIONES
        },
    }


def resumen_variantes_configuracion() -> dict:
    escenarios = {}
    for codigo in ESCENARIOS:
        variantes = generar_variantes_candidatas(codigo)
        escenarios[codigo] = {
            "variantes_factibles": len(variantes),
            "anclajes_con_variante": len({v["anclaje_id"] for v in variantes}),
            "por_configuracion": {
                str(k): sum(1 for v in variantes if v["configuracion"] == k)
                for k in CONFIGURACIONES
            },
            "por_orientacion": {
                o: sum(1 for v in variantes if v["orientacion"] == o)
                for o in ORIENTACIONES
            },
        }
    return {
        "anclajes_malla_generados": len(generar_anclajes_malla(paso_malla)),
        "paso_malla_svg": int(paso_malla),
        "escala_visual_local_svg_por_m": UNIDADES_SVG_POR_M_VISUAL,
        "envolventes_m": resumen_huellas_configuracion()["configuraciones"],
        "escenarios": escenarios,
        "estado": (
            "ENVOLVENTES_DISTINTAS_EN_MALLA_RAPIDA_SVG_NO_VALIDACION_FISICA"
            if int(paso_malla) > PASO_MALLA_SVG
            else "ENVOLVENTES_DISTINTAS_EN_MALLA_FINA_SVG_NO_VALIDACION_FISICA"
        ),
    }


def _crear_modelo(codigo: str, demanda: int, solver=None, paso_malla: int = PASO_MALLA_SVG) -> dict:
    if codigo not in ESCENARIOS:
        raise ValueError(f"Escenario no reconocido: {codigo}")
    if isinstance(demanda, bool) or not isinstance(demanda, int) or not 1 <= demanda <= 500:
        raise ValueError("La demanda debe ser un entero entre 1 y 500.")

    variantes = list(generar_variantes_candidatas(codigo, paso_malla))
    if not variantes:
        raise RuntimeError(f"No existen variantes candidatas para el escenario {codigo} y la malla {paso_malla}.")

    modelo = pulp.LpProblem(f"CRAI_PLEM_RAPIDO_{codigo}", pulp.LpMaximize)
    x: Dict[int, object] = {}
    por_anclaje: Dict[str, List[object]] = {}
    for j, variante in enumerate(variantes):
        variable = modelo.add_variable(
            f"x_{j + 1:04d}_k{variante['configuracion']}_{variante['orientacion']}",
            lowBound=0, upBound=1, cat="Binary"
        )
        x[j] = variable
        por_anclaje.setdefault(variante["anclaje_id"], []).append(variable)

    for indice, variables in enumerate(por_anclaje.values(), start=1):
        modelo += pulp.lpSum(variables) <= 1, f"Una_variante_por_anclaje_{indice:04d}"

    # Compresión exacta de incompatibilidades: si todas las variantes de dos
    # anclajes son mutuamente incompatibles, se agrega una sola restricción de grupo.
    pares_conflicto = _pares_incompatibles_eficientes(variantes)
    pares_por_anclaje = {}
    for i, j in pares_conflicto:
        ai = variantes[i]["anclaje_id"]
        aj = variantes[j]["anclaje_id"]
        key = tuple(sorted((ai, aj)))
        pares_por_anclaje.setdefault(key, []).append((i, j))

    indice_grupo = 0
    indice_par = 0
    for (anclaje_a, anclaje_b), pares in pares_por_anclaje.items():
        vars_a = por_anclaje[anclaje_a]
        vars_b = por_anclaje[anclaje_b]
        if len(pares) == len(vars_a) * len(vars_b):
            indice_grupo += 1
            modelo += pulp.lpSum(vars_a) + pulp.lpSum(vars_b) <= 1, f"Anclajes_incompatibles_{indice_grupo:05d}"
        else:
            for i, j in pares:
                indice_par += 1
                modelo += x[i] + x[j] <= 1, f"Incompatibles_{indice_par:05d}"

    mesas_expr = pulp.lpSum(x.values())
    sillas_expr = pulp.lpSum(variantes[j]["configuracion"] * x[j] for j in range(len(variantes)))
    sofas_conservados = len(geo.ESCENARIOS_SOFAS[codigo])
    plazas_sofas = sofas_conservados * PERSONAS_POR_SOFA

    # Cotas válidas y ajustadas para que la función objetivo ponderada sea
    # exactamente lexicográfica, sin coeficientes gigantes ni tres reoptimizaciones.
    asientos_requeridos = max(0, demanda - plazas_sofas)
    max_total_mesas = min(len(por_anclaje), math.ceil(asientos_requeridos / 2))
    max_mesas_nuevas = max(0, max_total_mesas - MESAS_EXISTENTES)
    max_sillas_nuevas = max(0, 4 * max_total_mesas - SILLAS_EXISTENTES)

    atendidos = modelo.add_variable("estudiantes_atendidos", lowBound=0, upBound=demanda, cat="Integer")
    mesas_nuevas = modelo.add_variable("mesas_nuevas", lowBound=0, upBound=max_mesas_nuevas, cat="Integer")
    sillas_nuevas = modelo.add_variable("sillas_nuevas", lowBound=0, upBound=max_sillas_nuevas, cat="Integer")

    modelo += atendidos <= demanda, "Limite_demanda"
    modelo += atendidos <= sillas_expr + plazas_sofas, "Capacidad_sillas_mas_sofas"
    modelo += mesas_expr <= MESAS_EXISTENTES + mesas_nuevas, "Inventario_mesas"
    modelo += sillas_expr <= SILLAS_EXISTENTES + sillas_nuevas, "Inventario_sillas"
    modelo += mesas_nuevas >= mesas_expr - MESAS_EXISTENTES, "Minimo_mesas_adicionales"
    modelo += sillas_nuevas >= sillas_expr - SILLAS_EXISTENTES, "Minimo_sillas_adicionales"

    # Un estudiante adicional domina cualquier variación posible de los dos
    # objetivos secundarios; una mesa domina cualquier variación en sillas nuevas.
    peso_sillas = 1
    peso_mesas = max_sillas_nuevas + 1
    peso_atendidos = max_mesas_nuevas * peso_mesas + max_sillas_nuevas + 1
    objetivo = peso_atendidos * atendidos - peso_mesas * mesas_nuevas - peso_sillas * sillas_nuevas
    modelo.setObjective(objetivo)

    return {
        "modelo": modelo, "variantes": variantes, "x": x,
        "atendidos": atendidos, "mesas_nuevas": mesas_nuevas, "sillas_nuevas": sillas_nuevas,
        "mesas_expr": mesas_expr, "sillas_expr": sillas_expr,
        "sofas_conservados": sofas_conservados, "plazas_sofas": plazas_sofas,
        "pares_conflicto": pares_conflicto,
        "restricciones_conflicto": indice_grupo + indice_par,
        "grupos_incompatibles_comprimidos": indice_grupo,
        "anclajes": len(por_anclaje),
        "paso_malla_svg": int(paso_malla),
        "pesos_lexicograficos": {
            "estudiantes": int(peso_atendidos),
            "mesas_nuevas": int(peso_mesas),
            "sillas_nuevas": int(peso_sillas),
            "cota_mesas_nuevas": int(max_mesas_nuevas),
            "cota_sillas_nuevas": int(max_sillas_nuevas),
        },
    }

def _validar_seleccion(ubicaciones: list, codigo: str) -> None:
    sofas = geo.obstaculos_sofas(codigo)
    for p in ubicaciones:
        rect = (p["x"], p["y"], p["ancho_svg"], p["alto_svg"])
        if not _rectangulo_dentro_de_zona(rect, geo.ZONAS_ESTUDIO[p["zona"]]):
            raise RuntimeError(f"La variante {p['variante_id']} sale del polígono de estudio.")
        if not geo.rectangulo_libre_de_rutas(rect):
            raise RuntimeError(f"La variante {p['variante_id']} interfiere con una ruta trazada.")
        if any(geo.rectangulos_se_superponen(rect, c) for c in geo.COLUMNAS_SVG):
            raise RuntimeError(f"La variante {p['variante_id']} interfiere con una columna.")
        if any(geo.rectangulos_se_superponen(rect, sofa) for sofa in sofas):
            raise RuntimeError(f"La variante {p['variante_id']} interfiere con un sofá conservado.")
    for i in range(len(ubicaciones)):
        for j in range(i + 1, len(ubicaciones)):
            rect_i = (ubicaciones[i]["x"], ubicaciones[i]["y"], ubicaciones[i]["ancho_svg"], ubicaciones[i]["alto_svg"])
            rect_j = (ubicaciones[j]["x"], ubicaciones[j]["y"], ubicaciones[j]["ancho_svg"], ubicaciones[j]["alto_svg"])
            if geo.rectangulos_se_superponen(rect_i, rect_j, holgura=SEPARACION_ENTRE_ENVOLVENTES_SVG):
                raise RuntimeError(f"Solapamiento entre {ubicaciones[i]['variante_id']} y {ubicaciones[j]['variante_id']}.")


def resolver_escenario(
    codigo: str,
    demanda: int,
    solver=None,
    progress_callback=None,
    progress_base: int = 0,
    paso_malla: int = PASO_MALLA_SVG,
    permitir_factible: bool = False,
    tiempo_limite: float | None = None,
    brecha_relativa: float | None = None,
) -> dict:
    if solver is None:
        solver = crear_solver(time_limit=tiempo_limite, gap_rel=brecha_relativa)
    m = _crear_modelo(codigo, demanda, solver, paso_malla=paso_malla)
    modelo = m["modelo"]
    atendidos = m["atendidos"]
    mesas_nuevas = m["mesas_nuevas"]
    sillas_nuevas = m["sillas_nuevas"]

    def notificar(porcentaje: int, mensaje: str) -> None:
        if callable(progress_callback):
            progress_callback({"scenario": codigo, "progress": min(96, progress_base + porcentaje), "message": mensaje})

    notificar(5, f"Escenario {codigo}: {len(m['variantes'])} variantes; {len(m['pares_conflicto'])} pares de conflicto comprimidos en {m['restricciones_conflicto']} restricciones. CBC resuelve una sola función objetivo lexicográfica.")
    estado, solver_reporta_optimal = _resolver(
        modelo, solver, f"escenario {codigo}, objetivo lexicográfico único", permitir_factible=permitir_factible
    )
    # Si el modo configuró tiempo máximo o brecha relativa, no se afirma prueba
    # de optimalidad exacta: CBC puede detenerse al alcanzar la tolerancia.
    optimalidad_demostrada = bool(
        solver_reporta_optimal and tiempo_limite is None and brecha_relativa is None
    )
    notificar(78, f"Escenario {codigo}: CBC terminó con estado {estado}. Validando inventario, capacidad y posiciones seleccionadas.")

    seleccionados = []
    configuraciones = {str(k): 0 for k in CONFIGURACIONES}
    for j, variante in enumerate(m["variantes"]):
        valor = m["x"][j].value()
        if valor is None or float(valor) <= 0.5:
            continue
        k = int(variante["configuracion"])
        configuraciones[str(k)] += 1
        rect = variante["rect"]
        seleccionados.append({
            "id": variante["anclaje_id"],
            "variante_id": variante["id"],
            "zona": variante["zona"],
            "configuracion": k,
            "asientos": k,
            "orientacion": variante["orientacion"],
            "x": float(rect[0]), "y": float(rect[1]),
            "ancho_svg": float(rect[2]), "alto_svg": float(rect[3]),
            "rect_svg": {"x": float(rect[0]), "y": float(rect[1]), "ancho": float(rect[2]), "alto": float(rect[3])},
            "ancho_env_m_estimado": variante["ancho_env_m"],
            "profundidad_env_m_estimada": variante["profundidad_env_m"],
            "area_env_m2_estimada": variante["area_env_m2"],
            "mesa_svg": variante["mesa_svg"],
            "sillas_svg": variante["sillas_svg"],
            "tipo": "inventario_existente_asignado",
        })

    seleccionados.sort(key=lambda p: (0 if p["zona"] == "SUPERIOR" else 1, p["y"], p["x"], p["variante_id"]))
    mesas_usadas = len(seleccionados)
    sillas_en_mesas = sum(p["asientos"] for p in seleccionados)
    estudiantes = _valor_entero(atendidos, "estudiantes_atendidos")
    nuevas_mesas = _valor_entero(mesas_nuevas, "mesas_nuevas")
    nuevas_sillas = _valor_entero(sillas_nuevas, "sillas_nuevas")
    capacidad_total = sillas_en_mesas + m["plazas_sofas"]
    existentes_asignadas = max(0, mesas_usadas - nuevas_mesas)
    for indice, ubicacion in enumerate(seleccionados):
        ubicacion["tipo"] = "inventario_existente_asignado" if indice < existentes_asignadas else "adicional"

    if mesas_usadas != sum(configuraciones.values()):
        raise RuntimeError("Inconsistencia: total de mesas distinto del conteo por configuración.")
    if sillas_en_mesas != sum(int(k) * v for k, v in configuraciones.items()):
        raise RuntimeError("Inconsistencia: sillas no coinciden con las configuraciones seleccionadas.")
    if mesas_usadas > MESAS_EXISTENTES + nuevas_mesas:
        raise RuntimeError("Inconsistencia: se excede el inventario de mesas.")
    if sillas_en_mesas > SILLAS_EXISTENTES + nuevas_sillas:
        raise RuntimeError("Inconsistencia: se excede el inventario de sillas.")
    if estudiantes > min(demanda, capacidad_total):
        raise RuntimeError("Inconsistencia: estudiantes atendidos superan la capacidad disponible.")
    _validar_seleccion(seleccionados, codigo)

    conteo_orientacion = {o: sum(1 for p in seleccionados if p["orientacion"] == o) for o in ORIENTACIONES}
    conteo_zona = {z: sum(1 for p in seleccionados if p["zona"] == z) for z in ("SUPERIOR", "INFERIOR")}
    return {
        "codigo": codigo,
        "escenario": geo.NOMBRES_ESCENARIOS[codigo],
        "estado": estado,
        "optimalidad_demostrada": bool(optimalidad_demostrada),
        "estado_solver": "Óptimo demostrado" if optimalidad_demostrada else "Solución exploratoria/factible; optimalidad exacta no demostrada",
        "demanda_objetivo": demanda,
        "estudiantes_atendidos": estudiantes,
        "sofas_conservados": m["sofas_conservados"],
        "plazas_sofas": m["plazas_sofas"],
        "candidatos_disponibles": m["anclajes"],
        "variantes_disponibles": len(m["variantes"]),
        "ubicaciones_seleccionadas": mesas_usadas,
        "mesas_inventario_asignado": existentes_asignadas,
        "mesas_nuevas": nuevas_mesas,
        "sillas_en_mesas": sillas_en_mesas,
        "sillas_existentes_utilizadas": min(sillas_en_mesas, SILLAS_EXISTENTES),
        "sillas_nuevas": nuevas_sillas,
        "capacidad_total_propuesta": capacidad_total,
        "demanda_no_cubierta": max(0, demanda - estudiantes),
        "configuraciones": configuraciones,
        "orientaciones": conteo_orientacion,
        "zonas": conteo_zona,
        "ubicaciones": seleccionados,
        "incompatibilidades_modeladas": len(m["pares_conflicto"]),
        "restricciones_conflicto_modeladas": m["restricciones_conflicto"],
        "grupos_incompatibles_comprimidos": m["grupos_incompatibles_comprimidos"],
        "paso_malla_svg": m["paso_malla_svg"],
        "pesos_lexicograficos": m["pesos_lexicograficos"],
        "secuencia_lexicografica": [
            "1. Maximizar estudiantes atendidos",
            "2. Minimizar mesas nuevas manteniendo atención máxima",
            "3. Minimizar sillas nuevas manteniendo las dos prioridades anteriores",
        ],
        "metodo_objetivo": "Función objetivo ponderada con cotas enteras demostradas; equivalente lexicográfico exacto cuando se ejecuta sin límite de tiempo ni brecha relativa y CBC demuestra Optimal.",
        "tiempo_limite_segundos": tiempo_limite,
        "brecha_relativa": brecha_relativa,
        "estado_validacion_espacial": "CRIBADO_SVG_CON_ENVOLVENTES_DISTINTAS_NO_VALIDACION_FISICA",
    }

def resumen_validacion_candidatas() -> dict:
    return geo.resumen_validacion_candidatas()


def resumen_anclajes_malla(paso_malla: int = PASO_MALLA_SVG) -> dict:
    anclajes = ANCLAJES_MALLA if int(paso_malla) == PASO_MALLA_SVG else generar_anclajes_malla(int(paso_malla))
    return {
        "total_anclajes_malla": len(anclajes),
        "paso_svg": int(paso_malla),
        "por_zona": {
            z: sum(1 for a in anclajes if a["zona"] == z)
            for z in ("SUPERIOR", "INFERIOR")
        },
    }


def resumen_variantes_configuracion(paso_malla: int = PASO_MALLA_SVG) -> dict:
    escenarios = {}
    for codigo in ESCENARIOS:
        variantes = generar_variantes_candidatas(codigo, paso_malla)
        escenarios[codigo] = {
            "variantes_factibles": len(variantes),
            "anclajes_con_variante": len({v["anclaje_id"] for v in variantes}),
            "por_configuracion": {
                str(k): sum(1 for v in variantes if v["configuracion"] == k)
                for k in CONFIGURACIONES
            },
            "por_orientacion": {
                o: sum(1 for v in variantes if v["orientacion"] == o)
                for o in ORIENTACIONES
            },
        }
    return {
        **resumen_anclajes_malla(paso_malla),
        "factor_visual_local_svg_por_m": UNIDADES_SVG_POR_M_VISUAL,
        "envolventes_m": resumen_huellas_configuracion(),
        "escenarios": escenarios,
    }

def resumen_huellas_configuracion() -> dict:
    return {
        "factor_visual_local_svg_por_m": UNIDADES_SVG_POR_M_VISUAL,
        "fuente_factor_visual": "Promedio del símbolo de mesa 17/1.20 y 9/0.60; escala visual local, no escala de planta.",
        "proyeccion_silla_uso_m": PROYECCION_SILLA_USO_M,
        "separacion_entre_envolventes_m": SEPARACION_ENTRE_ENVOLVENTES_M,
        "configuraciones": {
            str(k): {
                "ancho_m": ENVOLVENTES_M[k]["ancho"],
                "profundidad_m": ENVOLVENTES_M[k]["profundidad"],
                "area_m2": ENVOLVENTES_M[k]["ancho"] * ENVOLVENTES_M[k]["profundidad"],
                "disposicion": ENVOLVENTES_M[k]["disposicion"],
            }
            for k in CONFIGURACIONES
        },
    }


def _empaquetar_resultados(resultados: list, demanda: int, modo: str, paso_malla: int, tiempo_limite=None, brecha_relativa=None) -> dict:
    ordenados = sorted(resultados, key=lambda r: (-r["estudiantes_atendidos"], r["mesas_nuevas"], r["sillas_nuevas"], r["codigo"]))
    codigos = [r["codigo"] for r in resultados]
    info_malla = resumen_variantes_configuracion(paso_malla)
    return {
        "ok": True,
        "version_motor": VERSION_MOTOR,
        "modo_ejecucion": modo,
        "fecha_ejecucion": datetime.now().astimezone().isoformat(timespec="seconds"),
        "pulp_version": str(pulp.__version__),
        "solver": "COIN_CMD",
        "cbc_disponible": True,
        "demanda_objetivo": demanda,
        "inventario": {
            "mesas_existentes": MESAS_EXISTENTES,
            "sillas_existentes": SILLAS_EXISTENTES,
            "sofas_existentes": 4,
            "personas_por_sofa": PERSONAS_POR_SOFA,
        },
        "geometria_candidata": {
            **resumen_anclajes_malla(paso_malla),
            "anclajes_factibles_por_escenario": {c: info_malla["escenarios"][c]["anclajes_con_variante"] for c in codigos},
            "variantes_factibles_por_escenario": {c: info_malla["escenarios"][c]["variantes_factibles"] for c in codigos},
            "configuraciones_sillas": list(CONFIGURACIONES),
            "orientaciones": ["HORIZONTAL", "VERTICAL"],
            "unidades_coordenadas": "SVG",
            "factor_visual_local_svg_por_m": UNIDADES_SVG_POR_M_VISUAL,
            "escala_planta_calibrada": False,
            "huellas_diferenciadas_por_configuracion": True,
            "resolucion_busqueda": "MALLA_RAPIDA" if paso_malla > PASO_MALLA_SVG else "MALLA_FINA",
        },
        "envolventes_configuracion": resumen_huellas_configuracion(),
        "validacion_candidatas_punto2": geo.resumen_validacion_candidatas(),
        "resultados": resultados,
        "escenario_menor_incorporacion": ordenados[0]["codigo"] if ordenados else None,
        "parametros_solver": {
            "tiempo_limite_segundos": tiempo_limite,
            "brecha_relativa": brecha_relativa,
            "objetivo_ponderado_lexicografico": True,
            "una_ejecucion_cbc_por_escenario": True,
            "generacion_conflictos": "BARRIDO_EJE_X_Y_COMPRESION_POR_ANCLAJE",
        },
        "formulacion": {
            "objetivo": "Maximizar A, minimizar mesas nuevas y minimizar sillas nuevas mediante una sola función objetivo ponderada con cotas enteras demostradas.",
            "variables": [
                "x[i,k,o] binaria: anclaje i, configuración k={2,3,4}, orientación o={H,V}",
                "A entera: estudiantes atendidos",
                "n_m entera: mesas nuevas",
                "n_s entera: sillas nuevas",
            ],
            "restricciones": [
                "Suma_{k,o} x[i,k,o] <= 1 para cada anclaje i",
                "x[u] + x[v] <= 1 para pares de envolventes incompatibles; si todos los pares de dos anclajes chocan se usa una restricción agregada equivalente",
                "Suma_{i,k,o} x[i,k,o] <= 48 + n_m",
                "Suma_{i,k,o} k*x[i,k,o] <= 193 + n_s",
                "A <= demanda y A <= plazas_sofas + Suma_{i,k,o} k*x[i,k,o]",
            ],
            "pesos": resultados[0]["pesos_lexicograficos"] if resultados else {},
            "nota_espacial": "Las configuraciones y orientaciones usan envolventes distintas; las coordenadas permanecen en SVG y no calibran la planta completa.",
        },
        "alcance": (
            "Modelo PLEM de selección de variantes por anclaje, configuración y orientación. "
            "Usa una función objetivo ponderada exactamente lexicográfica con cotas enteras válidas, "
            "un solve CBC por escenario y conflictos espaciales generados por barrido. "
            "El modo rápido usa malla más gruesa y límites de búsqueda; no equivale a una validación física."
        ),
    }


def ejecutar_escenario_unico(
    demanda: int = DEMANDA_PREDETERMINADA,
    codigo: str = "A",
    progress_callback=None,
    paso_malla: int = PASO_MALLA_SVG,
    tiempo_limite: float | None = None,
    brecha_relativa: float | None = None,
    permitir_factible: bool = False,
    modo: str = "EXACTO_UN_ESCENARIO",
) -> dict:
    if codigo not in ESCENARIOS:
        raise ValueError("Selecciona el escenario A, B o C.")
    if isinstance(demanda, bool) or not isinstance(demanda, int) or not 1 <= demanda <= 500:
        raise ValueError("La demanda debe ser un entero entre 1 y 500.")
    solver = crear_solver(time_limit=tiempo_limite, gap_rel=brecha_relativa)
    resultado = resolver_escenario(
        codigo, demanda, solver, progress_callback=progress_callback,
        progress_base=5, paso_malla=paso_malla,
        permitir_factible=permitir_factible,
        tiempo_limite=tiempo_limite, brecha_relativa=brecha_relativa,
    )
    if callable(progress_callback):
        progress_callback({"scenario": codigo, "progress": 92, "message": f"Escenario {codigo} validado; preparando exportaciones."})
    return _empaquetar_resultados([resultado], demanda, modo, paso_malla, tiempo_limite, brecha_relativa)


def ejecutar_escenario_rapido(demanda: int = DEMANDA_PREDETERMINADA, codigo: str = "A", progress_callback=None) -> dict:
    """Exploración rápida: un escenario, malla 18, 60 s y brecha relativa 2 %."""
    return ejecutar_escenario_unico(
        demanda=demanda,
        codigo=codigo,
        progress_callback=progress_callback,
        paso_malla=PASO_MALLA_RAPIDA_SVG,
        tiempo_limite=TIEMPO_RAPIDO_SEGUNDOS,
        brecha_relativa=BRECHA_RAPIDA_RELATIVA,
        permitir_factible=True,
        modo="RAPIDO_EXPLORATORIO",
    )


def ejecutar_comparacion_espacial(demanda: int = DEMANDA_PREDETERMINADA, progress_callback=None) -> dict:
    """Comparación exacta A/B/C en malla fina, con un único solve CBC por escenario."""
    if isinstance(demanda, bool) or not isinstance(demanda, int) or not 1 <= demanda <= 500:
        raise ValueError("La demanda debe ser un entero entre 1 y 500.")
    solver, _ruta_cbc = comprobar_solver()
    resultados = []
    for indice, codigo in enumerate(ESCENARIOS):
        base_progreso = indice * 30
        if callable(progress_callback):
            progress_callback({"scenario": codigo, "progress": base_progreso + 1, "message": f"Comparación exacta: preparando escenario {codigo}; malla fina de {PASO_MALLA_SVG} unidades SVG."})
        resultado = resolver_escenario(
            codigo, demanda, solver,
            progress_callback=progress_callback,
            progress_base=base_progreso,
            paso_malla=PASO_MALLA_SVG,
            permitir_factible=False,
            tiempo_limite=None,
            brecha_relativa=None,
        )
        resultados.append(resultado)
        if callable(progress_callback):
            progress_callback({"scenario": codigo, "progress": (indice + 1) * 30, "message": f"Escenario {codigo} terminado: {resultado['estado']}. Un solve CBC completado."})
    return _empaquetar_resultados(resultados, demanda, "COMPARACION_COMPLETA_EXACTA", PASO_MALLA_SVG)

def exportar_malla_anclajes_csv(carpeta: Path, paso_malla: int = PASO_MALLA_SVG) -> Path:
    ruta = carpeta / f"malla_anclajes_espaciales_crai_v010_p{paso_malla}.csv"
    anclajes = ANCLAJES_MALLA if int(paso_malla) == PASO_MALLA_SVG else generar_anclajes_malla(int(paso_malla))
    with ruta.open("w", newline="", encoding="utf-8-sig") as archivo:
        campos = ["id_anclaje", "zona", "x_centro_svg", "y_centro_svg", "paso_malla_svg", "estado_metrico"]
        writer = csv.DictWriter(archivo, fieldnames=campos, delimiter=";")
        writer.writeheader()
        for a in anclajes:
            writer.writerow({
                "id_anclaje": a["id"], "zona": a["zona"], "x_centro_svg": a["x_svg"],
                "y_centro_svg": a["y_svg"], "paso_malla_svg": int(paso_malla),
                "estado_metrico": "SVG_NO_CALIBRADO",
            })
    return ruta


def exportar_variantes_csv(carpeta: Path, codigos=None, paso_malla: int = PASO_MALLA_SVG) -> Path:
    codigos = tuple(codigos or ESCENARIOS)
    ruta = carpeta / f"variantes_configuracion_crai_v010_p{paso_malla}.csv"
    campos = [
        "escenario", "id_anclaje", "id_variante", "zona", "configuracion_sillas", "orientacion",
        "x_svg", "y_svg", "ancho_svg", "alto_svg", "ancho_envolvente_m_estimado",
        "profundidad_envolvente_m_estimada", "area_envolvente_m2_estimada", "estado_metrico",
    ]
    with ruta.open("w", newline="", encoding="utf-8-sig") as archivo:
        writer = csv.DictWriter(archivo, fieldnames=campos, delimiter=";")
        writer.writeheader()
        for codigo in codigos:
            for v in generar_variantes_candidatas(codigo, paso_malla):
                writer.writerow({
                    "escenario": codigo, "id_anclaje": v["anclaje_id"], "id_variante": v["id"],
                    "zona": v["zona"], "configuracion_sillas": v["configuracion"], "orientacion": v["orientacion"],
                    "x_svg": round(v["x"], 3), "y_svg": round(v["y"], 3),
                    "ancho_svg": round(v["ancho_svg"], 3), "alto_svg": round(v["alto_svg"], 3),
                    "ancho_envolvente_m_estimado": v["ancho_env_m"],
                    "profundidad_envolvente_m_estimada": v["profundidad_env_m"],
                    "area_envolvente_m2_estimada": round(v["area_env_m2"], 3),
                    "estado_metrico": "ESCALA_VISUAL_LOCAL_NO_CALIBRADA",
                })
    return ruta


def guardar_resultados(datos: dict, carpeta: Path) -> Tuple[Path, ...]:
    carpeta.mkdir(parents=True, exist_ok=True)
    paso = int(datos.get("geometria_candidata", {}).get("paso_svg", PASO_MALLA_SVG))
    codigos = [r["codigo"] for r in datos.get("resultados", [])]
    json_path = carpeta / "resultados_plem_espacial_crai_v010.json"
    csv_path = carpeta / "resultados_plem_espacial_crai_v010.csv"
    base_path = geo.exportar_base_csv(carpeta)
    anclajes_path = exportar_malla_anclajes_csv(carpeta, paso)
    variantes_path = exportar_variantes_csv(carpeta, codigos, paso)
    informe_path = carpeta / "informe_plem_crai_v010.txt"
    json_path.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")

    campos = [
        "escenario", "nombre", "estado_solver", "optimalidad_demostrada", "demanda_objetivo", "estudiantes_atendidos",
        "sofas_conservados", "plazas_sofas", "anclajes_factibles", "variantes_disponibles",
        "ubicaciones_seleccionadas", "config_2_sillas", "config_3_sillas", "config_4_sillas",
        "mesas_nuevas", "sillas_en_mesas", "sillas_nuevas", "capacidad_total_propuesta",
        "demanda_no_cubierta", "orientacion_H", "orientacion_V", "zona_superior", "zona_inferior",
        "incompatibilidades_modeladas", "restricciones_conflicto_modeladas", "estado_validacion_espacial",
    ]
    with csv_path.open("w", newline="", encoding="utf-8-sig") as archivo:
        writer = csv.DictWriter(archivo, fieldnames=campos, delimiter=";")
        writer.writeheader()
        for r in datos["resultados"]:
            writer.writerow({
                "escenario": r["codigo"], "nombre": r["escenario"], "estado_solver": r["estado_solver"],
                "optimalidad_demostrada": r["optimalidad_demostrada"],
                "demanda_objetivo": r["demanda_objetivo"], "estudiantes_atendidos": r["estudiantes_atendidos"],
                "sofas_conservados": r["sofas_conservados"], "plazas_sofas": r["plazas_sofas"],
                "anclajes_factibles": r["candidatos_disponibles"], "variantes_disponibles": r["variantes_disponibles"],
                "ubicaciones_seleccionadas": r["ubicaciones_seleccionadas"],
                "config_2_sillas": r["configuraciones"]["2"], "config_3_sillas": r["configuraciones"]["3"],
                "config_4_sillas": r["configuraciones"]["4"], "mesas_nuevas": r["mesas_nuevas"],
                "sillas_en_mesas": r["sillas_en_mesas"], "sillas_nuevas": r["sillas_nuevas"],
                "capacidad_total_propuesta": r["capacidad_total_propuesta"], "demanda_no_cubierta": r["demanda_no_cubierta"],
                "orientacion_H": r["orientaciones"]["H"], "orientacion_V": r["orientaciones"]["V"],
                "zona_superior": r["zonas"]["SUPERIOR"], "zona_inferior": r["zonas"]["INFERIOR"],
                "incompatibilidades_modeladas": r["incompatibilidades_modeladas"],
                "restricciones_conflicto_modeladas": r["restricciones_conflicto_modeladas"],
                "estado_validacion_espacial": r["estado_validacion_espacial"],
            })

    lines = [
        "INFORME DEL MODELO PLEM ESPACIAL CRAI · VERSIÓN 0.10",
        f"Fecha de ejecución: {datos['fecha_ejecucion']}",
        f"Modo: {datos['modo_ejecucion']} | PuLP: {datos['pulp_version']} | Solver: {datos['solver']} | CBC: {datos['cbc_disponible']}",
        f"Demanda objetivo: {datos['demanda_objetivo']}",
        f"Malla: paso {paso} unidades SVG; anclajes generados: {datos['geometria_candidata']['total_anclajes_malla']}.",
        f"Parámetros: {datos['parametros_solver']}",
        "",
        "MEJORAS DE VELOCIDAD:",
        "- Una sola ejecución CBC por escenario mediante objetivo ponderado lexicográfico exacto.",
        "- Cotas enteras calculadas para probar la prioridad de estudiantes, mesas y sillas.",
        "- Barrido espacial por eje X para crear incompatibilidades solo entre envolventes cercanas.",
        "- Compresión de incompatibilidades completas por pares de anclajes.",
        "",
        "RESULTADOS:",
    ]
    for r in datos["resultados"]:
        lines.extend([
            f"{r['codigo']} - {r['escenario']} | estado CBC: {r['estado']} | clasificación: {r['estado_solver']} | optimalidad demostrada: {r['optimalidad_demostrada']}",
            f"  Atendidos: {r['estudiantes_atendidos']} / {r['demanda_objetivo']} | demanda no cubierta: {r['demanda_no_cubierta']}",
            f"  Malla: paso {r['paso_malla_svg']} SVG | anclajes: {r['candidatos_disponibles']} | variantes: {r['variantes_disponibles']}",
            f"  Estaciones: {r['ubicaciones_seleccionadas']} | config. 2/3/4: {r['configuraciones']['2']}/{r['configuraciones']['3']}/{r['configuraciones']['4']}",
            f"  Mesas nuevas: {r['mesas_nuevas']} | sillas nuevas: {r['sillas_nuevas']} | sofás: {r['sofas_conservados']}",
            f"  Pares incompatibles: {r['incompatibilidades_modeladas']} | restricciones de conflicto: {r['restricciones_conflicto_modeladas']}",
        ])
    lines.extend([
        "",
        "LIMITACIONES:",
        "- La geometría de la planta y las rutas siguen expresadas en unidades SVG.",
        "- La malla rápida es un cribado preliminar de menor resolución; puede omitir configuraciones que aparecen en la malla fina.",
        "- Los modos con límite de tiempo o brecha relativa se rotulan como exploratorios; no se afirma optimalidad exacta aunque CBC alcance la tolerancia configurada.",
        "- El factor visual local no calibra la planta completa; los muebles y zonas requieren validación en campo.",
        "- No certifica anchos normativos de pasillos, accesibilidad ni evacuación.",
    ])
    informe_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, csv_path, base_path, anclajes_path, variantes_path, informe_path

def exportar_base_ubicaciones(carpeta: Path | None = None) -> Path:
    destino = carpeta or BASE_DIR
    destino.mkdir(parents=True, exist_ok=True)
    return geo.exportar_base_csv(destino)


def main():
    carpeta = Path(__file__).resolve().parent
    solver, ruta = comprobar_solver()
    print("\nCRAI · PLEM ESPACIAL v0.10 · MOTOR OPTIMIZADO")
    print(f"PuLP {pulp.__version__} | CBC disponible: {ruta}")
    print(f"Malla fina: {len(ANCLAJES_MALLA)} anclajes, paso {PASO_MALLA_SVG} u SVG")
    datos = ejecutar_comparacion_espacial(DEMANDA_PREDETERMINADA)
    archivos = guardar_resultados(datos, carpeta)
    for r in datos["resultados"]:
        print(f"\n{r['codigo']} · {r['escenario']} · {r['estado']}")
        print(f"Atendidos: {r['estudiantes_atendidos']}/{r['demanda_objetivo']} | demanda no cubierta: {r['demanda_no_cubierta']}")
        print(f"Estaciones: {r['ubicaciones_seleccionadas']} | config 2/3/4: {r['configuraciones']['2']}/{r['configuraciones']['3']}/{r['configuraciones']['4']}")
        print(f"Mesas nuevas: {r['mesas_nuevas']} | sillas nuevas: {r['sillas_nuevas']} | conflictos: {r['incompatibilidades_modeladas']}")
    print("\nIMPORTANTE: óptimo del PLEM bajo los supuestos SVG; no es validación física.")
    print("Archivos generados:")
    for p in archivos:
        print(" -", p.name)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}")
        raise SystemExit(1)
