# -*- coding: utf-8 -*-
"""
MOTOR PLEM DEL CRAI - VERSION 0.1
Universidad Peruana Union - segundo nivel del CRAI, Juliaca

Esta primera version resuelve el requerimiento teorico de mobiliario para
alcanzar la demanda estimada. Todavia NO verifica el encaje geometrico real
de las mesas dentro del croquis irregular: eso se incorporara en la siguiente
fase, cuando digitalicemos el perimetro y las zonas restringidas.

Compatible con PuLP 4.x y CBC mediante pulp.COIN_CMD.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path
from datetime import datetime


# ---------------------------------------------------------------------
# 1. RUTA DE LAS LIBRERIAS INSTALADAS EN EL DISCO D:
# ---------------------------------------------------------------------
# Esto permite ejecutar el archivo sin volver a escribir PYTHONPATH cada vez.
RUTA_LIBRERIAS = Path(r"D:\Librerias_Python")
if RUTA_LIBRERIAS.exists():
    sys.path.insert(0, str(RUTA_LIBRERIAS))

try:
    import pulp
except ImportError as exc:
    raise SystemExit(
        "No se pudo importar PuLP. Verifica que exista D:\\Librerias_Python "
        "y que alli se haya instalado PuLP."
    ) from exc


# ---------------------------------------------------------------------
# 2. DATOS BASE DEL CRAI
# ---------------------------------------------------------------------
# Dimensiones generales comunicadas para el segundo nivel.
LARGO_GENERAL_M = 22.15
ANCHO_GENERAL_M = 10.70
AREA_RECTANGULAR_REFERENCIAL_M2 = LARGO_GENERAL_M * ANCHO_GENERAL_M

# Inventario informado por el usuario.
MESAS_EXISTENTES = 48
SILLAS_EXISTENTES = 193
SOFAS_EXISTENTES = 4
PERSONAS_POR_SOFA = 2

# Medidas confirmadas o estimadas.
MESA_LARGO_M = 1.20       # Dato proporcionado: 1.20 x 0.60 m
MESA_FONDO_M = 0.60
SILLA_ANCHO_M = 0.45      # Estimacion provisional basada en silla universitaria
SILLA_FONDO_M = 0.50      # Estimacion provisional
SOFA_ANCHO_M = 1.60       # Estimacion provisional para sofa de dos personas
SOFA_FONDO_M = 0.85       # Estimacion provisional

# Parametros de diseno preliminares.
DEMANDA_OBJETIVO = 248    # Estimacion de ocupacion con permanencia supuesta de 90 min
SILLAS_POR_MESA = 4       # Configuracion base para estimar requerimientos
ANCHO_PASILLO_REFERENCIAL_M = 1.50  # Provisional; requiere validacion normativa

# Limites tecnicos amplios del modelo de requerimiento.
# No son limites de espacio fisico ni autorizan instalar esa cantidad.
MAX_MESAS_ADICIONALES_MODELO = DEMANDA_OBJETIVO
MAX_SILLAS_ADICIONALES_MODELO = DEMANDA_OBJETIVO

# Coeficientes para priorizar: primero atender estudiantes; despues reducir
# mesas nuevas y, finalmente, sillas nuevas.
PESO_ATENCION = 1_000_000
PESO_MESA_NUEVA = 100
PESO_SILLA_NUEVA = 1
PESO_MESA_USADA = 0.01


# ---------------------------------------------------------------------
# 3. ESCENARIOS A COMPARAR
# ---------------------------------------------------------------------
ESCENARIOS = [
    {
        "id": "A_CONSERVAR_4_SOFAS",
        "nombre": "Conservar los 4 sofas",
        "sofas_mantenidos": 4,
    },
    {
        "id": "B_CONSERVAR_2_SOFAS",
        "nombre": "Conservar 2 sofas y retirar 2",
        "sofas_mantenidos": 2,
    },
    {
        "id": "C_RETIRAR_4_SOFAS",
        "nombre": "Retirar los 4 sofas",
        "sofas_mantenidos": 0,
    },
]


# ---------------------------------------------------------------------
# 4. FUNCIONES AUXILIARES
# ---------------------------------------------------------------------
def numero_entero(valor, predeterminado=0):
    """Convierte un valor numerico del solver a entero de forma segura."""
    if valor is None:
        return predeterminado
    return int(round(float(valor)))


def comprobar_solver():
    """Comprueba que CBC se encuentre disponible para PuLP 4.x."""
    if not hasattr(pulp, "COIN_CMD"):
        raise RuntimeError(
            "Esta instalacion de PuLP no expone COIN_CMD. "
            "Revisa la version de PuLP instalada."
        )

    solver = pulp.COIN_CMD(msg=False)
    ruta_cbc = solver.available()
    if not ruta_cbc:
        raise RuntimeError(
            "PuLP se importo, pero CBC no esta disponible. "
            "Verifica la instalacion pulp[cbc]."
        )
    return solver, ruta_cbc


def resolver_escenario(escenario, solver, demanda_objetivo=None):
    """Resuelve un PLEM de capacidad y requerimiento de mobiliario.

    Variables:
      atendidos: estudiantes atendidos (entera)
      mesas_usadas: mesas que se necesitan utilizar (entera)
      mesas_nuevas: mesas que se tendrian que incorporar (entera)
      sillas_nuevas: sillas que se tendrian que incorporar (entera)

    La capacidad de los sofas se suma por separado. La capacidad de las mesas
    se estima con SILLAS_POR_MESA. El modelo aun no ubica muebles en coordenadas.
    """
    sofas_mantenidos = escenario["sofas_mantenidos"]
    plazas_sofas = sofas_mantenidos * PERSONAS_POR_SOFA
    demanda_objetivo = DEMANDA_OBJETIVO if demanda_objetivo is None else int(demanda_objetivo)
    max_mesas_nuevas = max(MAX_MESAS_ADICIONALES_MODELO, demanda_objetivo)
    max_sillas_nuevas = max(MAX_SILLAS_ADICIONALES_MODELO, demanda_objetivo)

    modelo = pulp.LpProblem(
        f"CRAI_{escenario['id']}",
        pulp.LpMaximize,
    )

    # PuLP 4.x crea las variables desde el objeto LpProblem.
    atendidos = modelo.add_variable(
        "estudiantes_atendidos", lowBound=0, upBound=demanda_objetivo, cat="Integer"
    )
    mesas_usadas = modelo.add_variable(
        "mesas_usadas", lowBound=0, upBound=MESAS_EXISTENTES + max_mesas_nuevas,
        cat="Integer"
    )
    mesas_nuevas = modelo.add_variable(
        "mesas_nuevas", lowBound=0, upBound=max_mesas_nuevas,
        cat="Integer"
    )
    sillas_nuevas = modelo.add_variable(
        "sillas_nuevas", lowBound=0, upBound=max_sillas_nuevas,
        cat="Integer"
    )

    # Restriccion 1: no se atiende por encima de la demanda de diseno.
    modelo += atendidos <= demanda_objetivo, "Limite_demanda"

    # Restriccion 2: cada mesa aporta la configuracion base de cuatro plazas.
    modelo += (
        atendidos <= plazas_sofas + SILLAS_POR_MESA * mesas_usadas,
        "Capacidad_de_mesas_y_sofas",
    )

    # Restriccion 3: debe existir una silla para cada estudiante sentado en mesa.
    modelo += (
        atendidos <= plazas_sofas + SILLAS_EXISTENTES + sillas_nuevas,
        "Disponibilidad_de_sillas_y_sofas",
    )

    # Restriccion 4: las mesas usadas no pueden superar el inventario total.
    modelo += (
        mesas_usadas <= MESAS_EXISTENTES + mesas_nuevas,
        "Disponibilidad_de_mesas",
    )

    # Funcion objetivo lexicografica aproximada:
    # 1) maximizar estudiantes; 2) minimizar mesas nuevas; 3) minimizar sillas nuevas.
    modelo += (
        PESO_ATENCION * atendidos
        - PESO_MESA_NUEVA * mesas_nuevas
        - PESO_SILLA_NUEVA * sillas_nuevas
        - PESO_MESA_USADA * mesas_usadas
    )

    resultado = modelo.solve(solver)
    estado = getattr(resultado, "status_str", str(resultado))

    if estado.lower() != "optimal":
        return {
            "id": escenario["id"],
            "escenario": escenario["nombre"],
            "estado": estado,
            "demanda_objetivo": demanda_objetivo,
            "sofas_mantenidos": sofas_mantenidos,
            "plazas_sofas": plazas_sofas,
            "estudiantes_atendidos": None,
            "mesas_usadas": None,
            "mesas_nuevas": None,
            "total_mesas": None,
            "sillas_nuevas": None,
            "total_sillas": None,
            "demanda_no_cubierta": None,
        }

    atendidos_val = numero_entero(atendidos.value())
    mesas_usadas_val = numero_entero(mesas_usadas.value())
    mesas_nuevas_val = numero_entero(mesas_nuevas.value())
    sillas_nuevas_val = numero_entero(sillas_nuevas.value())

    return {
        "id": escenario["id"],
        "escenario": escenario["nombre"],
        "estado": estado,
        "demanda_objetivo": demanda_objetivo,
        "sofas_mantenidos": sofas_mantenidos,
        "plazas_sofas": plazas_sofas,
        "estudiantes_atendidos": atendidos_val,
        "mesas_usadas": mesas_usadas_val,
        "mesas_nuevas": mesas_nuevas_val,
        "total_mesas": MESAS_EXISTENTES + mesas_nuevas_val,
        "sillas_nuevas": sillas_nuevas_val,
        "total_sillas": SILLAS_EXISTENTES + sillas_nuevas_val,
        "demanda_no_cubierta": max(0, demanda_objetivo - atendidos_val),
    }


def guardar_resultados(resultados, carpeta_salida):
    """Guarda resultados en CSV compatible con Excel y un resumen TXT."""
    archivo_csv = carpeta_salida / "resultados_plem_crai_v01.csv"
    archivo_txt = carpeta_salida / "resumen_plem_crai_v01.txt"

    columnas = [
        "escenario", "estado", "demanda_objetivo", "sofas_mantenidos",
        "plazas_sofas", "estudiantes_atendidos", "mesas_usadas",
        "mesas_nuevas", "total_mesas", "sillas_nuevas", "total_sillas",
        "demanda_no_cubierta",
    ]

    with archivo_csv.open("w", newline="", encoding="utf-8-sig") as archivo:
        escritor = csv.DictWriter(archivo, fieldnames=columnas, delimiter=";")
        escritor.writeheader()
        for fila in resultados:
            escritor.writerow(fila)

    lineas = [
        "MOTOR PLEM DEL CRAI - VERSION 0.1",
        f"Fecha de ejecucion: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}",
        "",
        "IMPORTANTE: resultados teoricos de requerimiento de mobiliario.",
        "No validan todavia el encaje fisico dentro del croquis irregular.",
        "",
        f"Demanda objetivo: {DEMANDA_OBJETIVO} estudiantes (estimacion)",
        f"Mesas existentes: {MESAS_EXISTENTES}",
        f"Sillas existentes: {SILLAS_EXISTENTES}",
        f"Sillas por mesa usadas en esta version: {SILLAS_POR_MESA}",
        "",
    ]

    for fila in resultados:
        lineas.extend([
            fila["escenario"],
            f"  Estado del solver: {fila['estado']}",
            f"  Estudiantes atendidos: {fila['estudiantes_atendidos']}",
            f"  Sofas conservados: {fila['sofas_mantenidos']} ({fila['plazas_sofas']} plazas)",
            f"  Mesas usadas: {fila['mesas_usadas']}",
            f"  Mesas nuevas requeridas: {fila['mesas_nuevas']}",
            f"  Sillas nuevas requeridas: {fila['sillas_nuevas']}",
            f"  Demanda no cubierta: {fila['demanda_no_cubierta']}",
            "",
        ])

    lineas.extend([
        "LIMITACIONES DE ESTA VERSION",
        "1. No incorpora aun las coordenadas del perimetro real del CRAI.",
        "2. No verifica colisiones entre mesas, sillas, columnas o paredes.",
        "3. No verifica anchos reales de pasillos ni rutas de evacuacion.",
        "4. Las medidas de silla y sofa son estimaciones, no mediciones.",
        "5. La configuracion de cuatro sillas por mesa es un supuesto base.",
        "",
        "La siguiente fase incorporara las ubicaciones candidatas sobre el croquis original.",
    ])
    archivo_txt.write_text("\n".join(lineas), encoding="utf-8")

    return archivo_csv, archivo_txt


def imprimir_resultados(resultados, ruta_cbc):
    print("\n" + "=" * 72)
    print("MOTOR PLEM DEL CRAI - VERSION 0.1")
    print("=" * 72)
    print(f"PuLP instalado: {pulp.__version__}")
    print(f"CBC detectado en: {ruta_cbc}")
    print(f"Demanda objetivo: {DEMANDA_OBJETIVO} estudiantes (estimacion)")
    print("\nRESULTADOS POR ESCENARIO")
    print("-" * 72)

    for fila in resultados:
        print(f"\n{fila['escenario']}")
        print(f"  Estado: {fila['estado']}")
        print(f"  Estudiantes atendidos: {fila['estudiantes_atendidos']}")
        print(f"  Sofas conservados: {fila['sofas_mantenidos']} "
              f"({fila['plazas_sofas']} plazas)")
        print(f"  Mesas usadas: {fila['mesas_usadas']}")
        print(f"  Mesas nuevas requeridas: {fila['mesas_nuevas']}")
        print(f"  Total de mesas (inventario + nuevas): {fila['total_mesas']}")
        print(f"  Sillas nuevas requeridas: {fila['sillas_nuevas']}")
        print(f"  Total de sillas (inventario + nuevas): {fila['total_sillas']}")
        print(f"  Demanda no cubierta: {fila['demanda_no_cubierta']}")

    print("\n" + "-" * 72)
    print("ADVERTENCIA: estos son requerimientos teoricos, no una distribucion")
    print("fisica aprobada. Falta incorporar el perimetro y las ubicaciones reales.")
    print("=" * 72)


def main():
    carpeta_salida = Path(__file__).resolve().parent
    try:
        solver, ruta_cbc = comprobar_solver()
        resultados = [resolver_escenario(escenario, solver) for escenario in ESCENARIOS]
        imprimir_resultados(resultados, ruta_cbc)
        archivo_csv, archivo_txt = guardar_resultados(resultados, carpeta_salida)
        print("\nArchivos generados:")
        print(f"  - {archivo_csv}")
        print(f"  - {archivo_txt}")
        print("\nEjecucion finalizada.")
    except Exception as error:
        print("\nERROR AL EJECUTAR EL MOTOR PLEM:")
        print(error)
        print("\nVerifica que PuLP 4.x y CBC esten instalados en D:\\Librerias_Python.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
