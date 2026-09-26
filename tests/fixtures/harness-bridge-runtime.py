"""Controlled child for transport/lifecycle tests; not a governance engine."""
import json
import os
from pathlib import Path
import signal
import sys
import time

root = Path(__file__).parent
config = json.loads((root / "fixture.json").read_text())
request = json.load(sys.stdin)
operation = request["operation"]
(root / "ready.json").write_text(json.dumps({
  "pid": os.getpid(), "args": sys.argv, "isolated": sys.flags.isolated,
  "environment": dict(os.environ), "request": request,
}))
mode = config.get(operation, config.get("mode", "normal"))
if mode == "ignore-term":
  signal.signal(signal.SIGTERM, signal.SIG_IGN)
if mode in ("ignore-term", "hang", "inherited-pipes", "closed-pipes"):
  if mode in ("inherited-pipes", "closed-pipes"):
    pid = os.fork()
    if pid:
      (root / "descendant.json").write_text(json.dumps({"pid": pid}))
      if mode == "inherited-pipes":
        os._exit(0)
      print(json.dumps({
        "protocol": 1, "operation": operation, "state": "ready",
        "pythonVersion": "3.12.12", "engineVersion": "0.1.1",
        "requiredApi": {"constitutionFromDict": True, "pipelineEvaluate": True, "toolCall": True},
        "error": None,
      }), flush=True)
      os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if mode == "closed-pipes":
      os.close(1)
      os.close(2)
  while True:
    time.sleep(1)
if mode == "stdout-flood":
  sys.stdout.write("x" * 300000)
  sys.stdout.flush()
  time.sleep(10)
if mode == "stderr-flood":
  sys.stderr.write("fixture-private-secret" * 20000)
  sys.stderr.flush()
  time.sleep(10)
if mode == "crash":
  sys.stderr.write("password=fixture-private-secret")
  sys.exit(1)
time.sleep(config.get("delayMs", 0) / 1000)
if "response" in config:
  response = config["response"]
elif operation == "probe":
  response = {
    "protocol": 1, "operation": operation, "state": "ready",
    "pythonVersion": "3.12.12", "engineVersion": "0.1.1",
    "requiredApi": {"constitutionFromDict": True, "pipelineEvaluate": True, "toolCall": True},
    "error": None,
  }
elif operation == "validate":
  response = {
    "protocol": 1, "operation": operation, "valid": True, "engineValidated": True,
    "mode": "core", "ruleCount": 0, "errors": [], "warnings": [],
  }
else:
  response = {
    "protocol": 1, "operation": operation, "action": "ask", "risk": "low",
    "reason": "Tool requires confirmation.", "matchedRules": [],
    "engineVersion": "0.1.1", "executed": False,
  }
print(json.dumps(response), flush=True)
