"""AndroidWorld bench service for `autotest bench aw` (W2-5 P1, docs/dev-week2-milestone5.md section 5).

Hands out AndroidWorld tasks and scores them; the exploration tier (TypeScript) does the work on the emulator
with its own driver. Only `open_app` and `answer` go through AndroidWorld's executor: `answer` has to land in
its interaction cache to be scored, and `open_app` uses its app-name mapping.

Run with the AndroidWorld venv (docs/env-plan.md):
  D:\\envs\\androidworld\\python bench\\androidworld\\server.py [--setup] [--seed 42] [--combos 1]

Uses ref/android_world's public API (Apache-2.0) without copying it: android_world is installed in that venv.
"""

import argparse
import os
import shutil
import tempfile
import threading

import fastapi
import uvicorn
from android_env.components import adb_call_parser, adb_controller
from android_env.proto import adb_pb2
from android_world import registry, suite_utils
from android_world.env import env_launcher, json_action


def _refuse_restart(self, timeout=None):  # pylint: disable=unused-argument
  # android_env restarts the adb server (`adb kill-server`) whenever a device command fails before retrying
  # (adb_controller.py, _restart_server). That server is shared with the test phone: fail instead.
  raise RuntimeError('refused adb kill-server: the adb server is shared with the test phone')


adb_controller.AdbController._restart_server = _refuse_restart  # pylint: disable=protected-access

_install_apk = adb_call_parser.AdbCallParser._install_apk  # pylint: disable=protected-access


def _install_apk_from_file(self, request, timeout=None):
  # Windows, Python 3.11: android_env hands adb a NamedTemporaryFile that is still open with delete-on-close,
  # which no other process can open ("failed to open … No such file or directory"). Write the blob to a
  # closed temporary file and install it by path instead.
  if request.install_apk.WhichOneof('location') != 'blob':
    return _install_apk(self, request, timeout)
  fd, path = tempfile.mkstemp(suffix='.apk')
  with os.fdopen(fd, 'wb') as f:
    f.write(request.install_apk.blob.contents)
  try:
    by_path = adb_pb2.AdbRequest()
    by_path.CopyFrom(request)
    by_path.install_apk.filesystem.path = path
    return _install_apk(self, by_path, timeout)
  finally:
    os.remove(path)


adb_call_parser.AdbCallParser._install_apk = _install_apk_from_file  # pylint: disable=protected-access


def build_app(env, suite) -> fastapi.FastAPI:
  app = fastapi.FastAPI(title='autotest AndroidWorld bench')
  lock = threading.Lock()  # one emulator, one task at a time

  def task_of(name: str, idx: int):
    if name not in suite or not 0 <= idx < len(suite[name]):
      raise fastapi.HTTPException(404, f'no task {name}[{idx}]')
    return suite[name][idx]

  @app.get('/health')
  def health():
    return {'ok': True, 'tasks': len(suite)}

  @app.get('/tasks')
  def tasks():
    out = []
    for name, instances in suite.items():
      t = instances[0]
      out.append({
          'name': name,
          'instances': len(instances),
          'apps': list(t.app_names),
          'complexity': t.complexity,
          'maxSteps': suite_utils._allocate_step_budget(t.complexity),  # pylint: disable=protected-access
      })
    return {'tasks': out}

  @app.post('/task/init')
  def init(name: str, idx: int = 0):
    t = task_of(name, idx)
    with lock:
      t.initialize_task(env)
      env.reset(go_home=True)  # what the AndroidWorld agents do before the first step (also clears the answer)
    return {'goal': t.goal, 'maxSteps': suite_utils._allocate_step_budget(t.complexity)}  # pylint: disable=protected-access

  @app.get('/task/score')
  def score(name: str, idx: int = 0):
    t = task_of(name, idx)
    with lock:
      return {'score': float(t.is_successful(env))}

  @app.post('/task/teardown')
  def teardown(name: str, idx: int = 0):
    t = task_of(name, idx)
    with lock:
      t.tear_down(env)
    return {'ok': True}

  @app.post('/action')
  def action(body: dict):
    kind = body.get('action_type')
    if kind == 'open_app' and isinstance(body.get('app_name'), str):
      a = json_action.JSONAction(action_type='open_app', app_name=body['app_name'])
    elif kind == 'answer' and isinstance(body.get('text'), str):
      a = json_action.JSONAction(action_type='answer', text=body['text'])
    else:
      raise fastapi.HTTPException(400, 'only {"action_type":"open_app","app_name":...} or {"action_type":"answer","text":...}')
    with lock:
      env.execute_action(a)
    return {'ok': True}

  return app


def main() -> None:
  p = argparse.ArgumentParser()
  p.add_argument('--port', type=int, default=5055)
  p.add_argument('--seed', type=int, default=42)
  p.add_argument('--combos', type=int, default=1, help='parameter combinations per task')
  p.add_argument('--setup', action='store_true', help='first run only: install and set up the AndroidWorld apps')
  p.add_argument('--console-port', type=int, default=5554)
  p.add_argument('--grpc-port', type=int, default=8554)
  p.add_argument('--adb', default=os.environ.get('AW_ADB') or shutil.which('adb'))
  a = p.parse_args()
  if not a.adb:
    raise SystemExit('adb not found: set AW_ADB or put adb on PATH')
  env = env_launcher.load_and_setup_env(console_port=a.console_port, emulator_setup=a.setup, freeze_datetime=True, adb_path=a.adb, grpc_port=a.grpc_port)
  suite = suite_utils.create_suite(registry.TaskRegistry().get_registry(registry.TaskRegistry.ANDROID_WORLD_FAMILY), n_task_combinations=a.combos, seed=a.seed)
  print(f'[bench] {len(suite)} tasks, seed {a.seed}, {a.combos} combination(s) each; http://127.0.0.1:{a.port}', flush=True)
  uvicorn.run(build_app(env, suite), host='127.0.0.1', port=a.port, log_level='warning')


if __name__ == '__main__':
  main()
