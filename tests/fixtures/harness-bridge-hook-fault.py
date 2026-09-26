"""Exercise real AutoHarness hook failures without replacing engine decisions."""
import json
from pathlib import Path
import runpy
import sys
import threading
import time

sys.dont_write_bytecode = True
bridge_path, fault, evidence_path = sys.argv[1:]
bridge = runpy.run_path(bridge_path, run_name="harness_bridge_fault_fixture")
from autoharness.core.hooks import HookRegistry
from autoharness.core.types import HookAction, HookResult

evidence = {"fault": fault, "calls": 0, "threadBlocked": False}
previous_limit = None
if fault == "nproc":
  import resource
  previous_limit = resource.getrlimit(resource.RLIMIT_NPROC)
  resource.setrlimit(resource.RLIMIT_NPROC, (0, previous_limit[1]))
  probe = threading.Thread(target=lambda: None)
  try:
    probe.start()
    probe.join()
  except RuntimeError:
    evidence["threadBlocked"] = True
else:
  original_init = HookRegistry.__init__

  def faulty_hook(*_):
    evidence["calls"] += 1
    if fault == "exception":
      raise RuntimeError("password=fixture-private-hook-error")
    if fault == "timeout":
      time.sleep(0.2)
    return HookResult(action=HookAction.allow, reason="Completed check", severity="info")

  def initialize(self, *args, **kwargs):
    original_init(self, *args, **kwargs)
    timeout = 0.01 if fault == "timeout" else 10.0
    self.register("pre_tool_use", faulty_hook, name="controlled-check", priority=1, timeout=timeout)

  HookRegistry.__init__ = initialize

sys.argv = [bridge_path]
try:
  code = bridge["main"]()
finally:
  if previous_limit is not None:
    resource.setrlimit(resource.RLIMIT_NPROC, previous_limit)
Path(evidence_path).write_text(json.dumps(evidence))
sys.exit(code)
