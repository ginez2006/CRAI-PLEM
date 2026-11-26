# -*- coding: utf-8 -*-
r"""Servidor CRAI v0.12: comparación técnica de escenarios y optimización espacial en segundo plano con seguimiento de progreso.

Ejecutar desde D:\\yhon:
    python abrir_dashboard_crai_v12.py

El modelo PLEM no cambia su objetivo ni sus restricciones. Esta versión corrige
la comunicación navegador-servidor: CBC corre en un hilo de trabajo y el HTML
consulta el estado sin dejar bloqueada una solicitud HTTP larga.
"""
from __future__ import annotations

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from datetime import datetime
import importlib
import json
import os
import sys
import threading
import uuid
import webbrowser

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8019"))
BASE_DIR = Path(__file__).resolve().parent
LIBRERIAS = Path(r"D:\Librerias_Python")
if LIBRERIAS.exists() and str(LIBRERIAS) not in sys.path:
    sys.path.insert(0, str(LIBRERIAS))
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

REQUIRED = (
    "dashboard_crai_principal.html",
    "modelo_matematico_crai.html",
    "plano_distribucion_crai.html",
    "plano_espacial_crai.html",
    "comparacion_escenarios_crai.html",
    "propuesta_redistribucion_crai.html",
    "motor_plem_crai.py",
    "motor_plem_espacial_crai.py",
    "geometria_ubicaciones_crai.py",
)
missing = [name for name in REQUIRED if not (BASE_DIR / name).is_file()]
if missing:
    raise SystemExit("Faltan archivos en D:\\yhon: " + ", ".join(missing))

# Importar una sola vez. No usar importlib.reload por cada petición concurrente.
try:
    MOTOR_ESPACIAL = importlib.import_module("motor_plem_espacial_crai")
    MOTOR_AGREGADO = importlib.import_module("motor_plem_crai")
except Exception as exc:
    raise SystemExit(f"No se pudieron cargar los motores del CRAI: {exc}") from exc

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.RLock()
ACTIVE_JOB_ID: str | None = None


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def update_job(job_id: str, **updates) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(updates)
            JOBS[job_id]["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")


def run_spatial_job(job_id: str, demand: int, mode: str, scenario: str) -> None:
    global ACTIVE_JOB_ID
    try:
        update_job(job_id, state="running", progress=1, message="Preparando el modelo y comprobando CBC...")

        def on_progress(info: dict) -> None:
            update_job(
                job_id,
                progress=int(info.get("progress", 1)),
                message=str(info.get("message", "CBC está resolviendo el modelo.")),
                scenario=info.get("scenario"),
            )

        if mode == "rapido":
            update_job(job_id, progress=3, message=f"Modo rápido: resolviendo solo el escenario {scenario} con malla preliminar y límite de búsqueda.")
            result = MOTOR_ESPACIAL.ejecutar_escenario_rapido(demand, scenario, progress_callback=on_progress)
        elif mode == "exacto_unico":
            update_job(job_id, progress=3, message=f"Modo exacto: resolviendo solo el escenario {scenario} con malla fina y optimalidad demostrada.")
            result = MOTOR_ESPACIAL.ejecutar_escenario_unico(demand, scenario, progress_callback=on_progress, paso_malla=MOTOR_ESPACIAL.PASO_MALLA_SVG, permitir_factible=False, modo="EXACTO_UN_ESCENARIO")
        elif mode == "comparacion":
            update_job(job_id, progress=3, message="Comparación completa: CBC resolverá A, B y C con malla fina y una ejecución por escenario.")
            result = MOTOR_ESPACIAL.ejecutar_comparacion_espacial(demand, progress_callback=on_progress)
        else:
            raise ValueError(f"Modo de ejecución no reconocido: {mode}")
        update_job(job_id, progress=97, message="Modelo resuelto. Guardando archivos de resultados...")
        files = MOTOR_ESPACIAL.guardar_resultados(result, BASE_DIR)
        result["archivos_generados"] = [p.name for p in files]
        update_job(job_id, state="done", progress=100, message="Optimización completada. Resultados listos.", result=result, finished_at=datetime.now().astimezone().isoformat(timespec="seconds"))
        codigos = "/".join(r["codigo"] for r in result.get("resultados", []))
        print(f"[PLEM] Trabajo {job_id}: finalizado correctamente; modo={mode}; escenario(s)={codigos}.", flush=True)
    except Exception as exc:
        update_job(job_id, state="error", error=str(exc), message="La optimización terminó con un error.", finished_at=datetime.now().astimezone().isoformat(timespec="seconds"))
        print(f"[PLEM] Trabajo {job_id}: ERROR: {exc}", flush=True)
    finally:
        with JOBS_LOCK:
            if ACTIVE_JOB_ID == job_id:
                ACTIVE_JOB_ID = None


class CRAIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def send_json(self, status: int, payload: dict) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self, max_bytes: int = 12000) -> dict:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Longitud de solicitud inválida.") from exc
        if size <= 0 or size > max_bytes:
            raise ValueError("La solicitud está vacía o supera el tamaño permitido.")
        try:
            data = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("El cuerpo enviado no es un JSON válido.") from exc
        if not isinstance(data, dict):
            raise ValueError("El cuerpo JSON debe ser un objeto.")
        return data

    def do_GET(self):
        global ACTIVE_JOB_ID
        path = urlsplit(self.path)
        route = path.path
        if route == "/api/diagnostico":
            self.send_json(200, {"ok": True, "servidor": "CRAI v0.12 · comparación, propuesta y CBC optimizado", "puerto": PORT, "aplicacion": "CRAI PLEM Web"})
            return
        if route == "/api/estado":
            try:
                _solver_agg, cbc_agg = MOTOR_AGREGADO.comprobar_solver()
                self.send_json(200, {"ok": True, "pulp_version": str(MOTOR_AGREGADO.pulp.__version__), "cbc_disponible": bool(cbc_agg), "servidor": "CRAI v0.12"})
            except Exception as exc:
                self.send_json(500, {"ok": False, "mensaje": str(exc)})
            return
        if route == "/api/plem/resultados":
            result_path = BASE_DIR / "resultados_plem_espacial_crai_v010.json"
            if not result_path.is_file():
                self.send_json(200, {"ok": True, "disponible": False, "mensaje": "Todavía no hay resultados guardados del motor PLEM v0.10."})
                return
            try:
                datos = json.loads(result_path.read_text(encoding="utf-8"))
                codigos = {str(r.get("codigo")) for r in datos.get("resultados", [])}
                comparacion_completa = (
                    datos.get("modo_ejecucion") == "COMPARACION_COMPLETA_EXACTA"
                    and codigos == {"A", "B", "C"}
                    and all(bool(r.get("optimalidad_demostrada")) and str(r.get("estado", "")).lower() == "optimal" for r in datos.get("resultados", []))
                )
                self.send_json(200, {
                    "ok": True,
                    "disponible": True,
                    "comparacion_completa_exacta": comparacion_completa,
                    "datos": datos,
                    "mensaje": "Resultados cargados desde el último archivo JSON guardado por CBC."
                })
            except Exception as exc:
                self.send_json(500, {"ok": False, "error": f"No se pudo leer el último JSON de resultados: {exc}"})
            return
        if route == "/api/espacial/estado":
            try:
                solver, cbc_path = MOTOR_ESPACIAL.comprobar_solver()
                mesh = MOTOR_ESPACIAL.resumen_anclajes_malla()
                self.send_json(200, {
                    "ok": True,
                    "servidor": "CRAI v0.12 · comparación, propuesta y CBC optimizado",
                    "version_motor": MOTOR_ESPACIAL.VERSION_MOTOR,
                    "solver": "COIN_CMD",
                    "cbc_disponible": bool(cbc_path),
                    "pulp_version": str(MOTOR_ESPACIAL.pulp.__version__),
                    "anclajes_malla": mesh["total_anclajes_malla"],
                })
            except Exception as exc:
                self.send_json(500, {"ok": False, "error": str(exc)})
            return
        if route == "/api/espacial/validacion":
            try:
                validation = MOTOR_ESPACIAL.resumen_validacion_candidatas()
                self.send_json(200, {"ok": True, "validacion": validation})
            except Exception as exc:
                self.send_json(500, {"ok": False, "error": str(exc)})
            return
        if route == "/api/espacial/optimizar/estado":
            query = parse_qs(path.query)
            job_id = (query.get("job_id") or [""])[0]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if not job:
                    self.send_json(404, {"ok": False, "error": "No se encontró el trabajo de optimización. Inicia una ejecución nueva."})
                    return
                payload = {k: v for k, v in job.items() if k != "result"}
                if job.get("state") == "done":
                    payload["result"] = job.get("result")
            self.send_json(200, {"ok": True, **payload})
            return
        if route == "/":
            self.send_response(302)
            self.send_header("Location", "/dashboard_crai_principal.html")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        global ACTIVE_JOB_ID
        route = urlsplit(self.path).path
        try:
            request = self.read_json()
            demand_raw = request.get("demanda_objetivo", 248)
            if isinstance(demand_raw, bool) or not isinstance(demand_raw, (int, float)) or int(demand_raw) != demand_raw:
                raise ValueError("La demanda debe ser un número entero.")
            demand = int(demand_raw)
            max_demand = 2000 if route == "/api/optimizar" else 500
            if not 1 <= demand <= max_demand:
                raise ValueError(f"La demanda debe estar entre 1 y {max_demand} estudiantes.")

            if route == "/api/espacial/optimizar/iniciar":
                mode = str(request.get("modo_ejecucion", "rapido"))
                scenario = str(request.get("escenario", "A")).upper()
                if mode not in ("rapido", "exacto_unico", "comparacion"):
                    raise ValueError("Modo inválido. Usa rapido, exacto_unico o comparacion.")
                if scenario not in ("A", "B", "C"):
                    raise ValueError("El escenario debe ser A, B o C.")
                # CBC runs in a worker thread; return immediately to the browser.
                with JOBS_LOCK:
                    if ACTIVE_JOB_ID and JOBS.get(ACTIVE_JOB_ID, {}).get("state") in ("queued", "running"):
                        self.send_json(409, {"ok": False, "error": "Ya existe una optimización en curso. Espera a que termine antes de iniciar otra."})
                        return
                    job_id = uuid.uuid4().hex
                    ACTIVE_JOB_ID = job_id
                    JOBS[job_id] = {
                        "job_id": job_id,
                        "state": "queued",
                        "progress": 0,
                        "message": "Trabajo recibido; esperando el hilo de CBC.",
                        "demand": demand,
                        "mode": mode,
                        "scenario": scenario,
                        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    }
                worker = threading.Thread(target=run_spatial_job, args=(job_id, demand, mode, scenario), name=f"CRAI-CBC-{job_id[:8]}", daemon=True)
                worker.start()
                self.send_json(202, {"ok": True, "job_id": job_id, "state": "queued", "message": "La optimización se inició en segundo plano."})
                print(f"[PLEM] Trabajo {job_id}: solicitado; modo={mode}; escenario={scenario}; demanda={demand}.", flush=True)
                return

            if route == "/api/optimizar":
                if demand > 2000:
                    raise ValueError("La demanda del modelo agregado debe estar entre 1 y 2 000 estudiantes.")
                solver_agg, _cbc_agg = MOTOR_AGREGADO.comprobar_solver()
                resultados = []
                for escenario in MOTOR_AGREGADO.ESCENARIOS:
                    fila = MOTOR_AGREGADO.resolver_escenario(escenario, solver_agg, demanda_objetivo=demand)
                    resultados.append(fila)
                payload = {
                    "ok": True,
                    "version_motor": "PLEM agregado 0.2",
                    "fecha_ejecucion": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "pulp_version": str(MOTOR_AGREGADO.pulp.__version__),
                    "solver": "COIN_CMD",
                    "capacidad_actual_contabilizada": MOTOR_AGREGADO.SILLAS_EXISTENTES + MOTOR_AGREGADO.SOFAS_EXISTENTES * MOTOR_AGREGADO.PERSONAS_POR_SOFA,
                    "demanda_objetivo": demand,
                    "resultados": resultados,
                }
                self.send_json(200, payload)
                print(f"[PLEM agregado] Resuelta demanda {demand}; escenarios A/B/C.", flush=True)
                return

            self.send_json(404, {"ok": False, "error": f"Ruta API no encontrada: {route}"})
        except Exception as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print("[HTTP] " + (fmt % args), flush=True)


class CRAIServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


try:
    _solver, CBC_PATH = MOTOR_ESPACIAL.comprobar_solver()
except Exception as exc:
    raise SystemExit(f"No se pudo comprobar CBC al iniciar: {exc}") from exc

try:
    MOTOR_ESPACIAL.exportar_base_ubicaciones(BASE_DIR)
    MOTOR_ESPACIAL.exportar_malla_anclajes_csv(BASE_DIR)
    MESH_INFO = MOTOR_ESPACIAL.resumen_anclajes_malla()
except Exception as exc:
    raise SystemExit(f"No se pudo preparar la malla espacial: {exc}") from exc

try:
    server = CRAIServer((HOST, PORT), CRAIHandler)
except OSError as exc:
    raise SystemExit(f"No se pudo iniciar el servidor en el puerto {PORT}: {exc}") from exc

home = f"http://127.0.0.1:{PORT}/dashboard_crai_principal.html"
print("=" * 78)
print("CRAI · SERVIDOR v0.12 · PROPUESTA DE REDISTRIBUCIÓN")
print(f"Carpeta de aplicación: {BASE_DIR}")
print(f"Dashboard: {home}")
print(f"Plano: http://{HOST}:{PORT}/plano_espacial_crai.html")
print(f"Comparación: http://{HOST}:{PORT}/comparacion_escenarios_crai.html")
print(f"Propuesta Punto 6: http://{HOST}:{PORT}/propuesta_redistribucion_crai.html")
print(f"Diagnóstico: http://{HOST}:{PORT}/api/diagnostico")
print(f"Estado CBC: disponible ({CBC_PATH})")
print(f"Malla: {MESH_INFO['total_anclajes_malla']} anclajes")
print("Modos: rápido (1 escenario/malla 18), exacto único (1 escenario/malla 12) y comparación completa (A+B+C/malla 12).")
print("Punto 4: comparación A/B/C. Punto 6: tres planos de redistribución detallados sobre el mismo croquis SVG original; teoría, cuantificación y exportación XLSX/PDF.")
print("Mantén esta terminal abierta. Para detener el servidor: Ctrl+C.")
print("=" * 78, flush=True)
if os.environ.get("CRAI_OPEN_BROWSER", "1") == "1" and HOST in ("127.0.0.1", "localhost", "0.0.0.0"):
    threading.Timer(0.7, lambda: webbrowser.open(home)).start()
try:
    server.serve_forever(poll_interval=0.4)
except KeyboardInterrupt:
    print("\nCerrando servidor CRAI v0.12...", flush=True)
finally:
    server.server_close()
