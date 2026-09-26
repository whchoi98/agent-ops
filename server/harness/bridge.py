#!/usr/bin/env python3
"""Isolated AutoHarness evaluation and native hook adapter. Never executes tools.

App protocol: python -I /absolute/bridge.py, one bounded JSON request on stdin.
Native protocol: add --binding /app/.../bindings/client.json --event PreToolUse.
Only the installed, explicitly supported engine is imported. No project modules,
native configuration, model clients, upstream audit files or tool executors are used.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import base64
import hashlib
import importlib.metadata
import inspect
import json
import logging
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import quote, unquote, urlsplit, parse_qsl
import warnings

sys.dont_write_bytecode = True

PROTOCOL = 1
ENGINE_VERSION = "0.1.1"
MAX_JSON = 128 * 1024
MAX_POLICY = 64 * 1024
MAX_INPUT = 64 * 1024
MAX_AUDIT = 2 * 1024 * 1024
MAX_EVENT = 8192
TIMEOUT = 14.0
CLIENTS = {"claude-code", "codex", "kiro"}
TEST_CLIENTS = {"claude-code", "codex", "kiro-ide", "kiro-cli"}
EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure"}
SECRET_KEY = re.compile(r"env|headers|cookie|password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key|^(?:tool_input|tool_output|tool_response|tool_result|output|error)$", re.I)
SAFE_ENV = ("HOME", "SYSTEMROOT", "WINDIR")
_engine_guarded = False
_audit_hook_installed = False


class BridgeError(Exception):
  """A safe, fixed message that may cross the bridge boundary."""


def utc_now():
  return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def safe_text(value, limit=1024, secrets=()):
  if not isinstance(value, str):
    return ""
  # Redact before truncating: truncation must not expose the prefix of a secret.
  variants = set()
  for secret in secrets:
    if secret:
      variants.update((secret, quote(secret, safe="")))
  if len(variants) > 2048 or sum(map(len, variants)) > 1024 * 1024:
    return "[redacted]" if value else ""
  if variants:
    # A single substitution cannot repeatedly expand markers for short secrets.
    pattern = "|".join(re.escape(secret) for secret in sorted(variants, key=len, reverse=True))
    value = re.sub(pattern, "[redacted]", value)
  value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)", "[redacted]", value)
  value = re.sub(r"\b(?:sk-[a-zA-Z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+)\b", "[redacted]", value)
  value = re.sub(r"\b(Bearer|Basic)\s+[a-zA-Z0-9._~+/-]+=*", r"\1 [redacted]", value, flags=re.I)
  value = re.sub(r"((?:api[_-]?key|password|passwd|secret|token|authorization)\s*[\"']?\s*[:=]\s*)[\"']?[^\"' \t\r\n,;}]+[\"']?", r"\1[redacted]", value, flags=re.I)
  value = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", value, flags=re.I)
  value = re.sub(r"\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b", "[redacted]", value)
  return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value)[:limit]


def secret_values(value):
  found = []

  def walk(item, private=False):
    if isinstance(item, dict):
      for key, child in item.items():
        if key.lower() in ("url", "uri") and isinstance(child, str):
          try:
            url = urlsplit(child)
            found.extend(unquote(part) for part in (url.username, url.password) if part)
            found.extend(value for _, value in parse_qsl(url.query) if value)
          except ValueError:
            pass
        walk(child, private or bool(SECRET_KEY.search(key)))
    elif isinstance(item, list):
      for child in item:
        walk(child, private)
    elif isinstance(item, str):
      if private and item:
        found.append(item)
        authorization = re.fullmatch(r"(Bearer|Basic)\s+(.+)", item, re.I)
        if authorization:
          found.append(authorization[2])
          if authorization[1].lower() == "basic":
            try:
              decoded = base64.b64decode(authorization[2], validate=True).decode("utf-8")
              found.append(decoded)
              found.extend(part for part in decoded.split(":", 1) if part)
            except (ValueError, UnicodeError):
              pass
      # Also find assignments inside command strings and custom rule reasons.
      found.extend(match.group(1) for match in re.finditer(
        r"(?:api[_-]?key|password|passwd|secret|token|authorization)\s*[\"']?\s*[:=]\s*[\"']?([^\"' \t\r\n,;}]+)", item, re.I))
  walk(value)
  return found


def text(value, maximum=256):
  return isinstance(value, str) and 0 < len(value.strip()) <= maximum and not re.search(r"[\x00-\x1f\x7f]", value)


def absolute(value):
  return text(value, 4096) and os.path.isabs(value) and os.path.normpath(value) == value


def bounded_tree(value):
  nodes = 0

  def visit(item, depth):
    nonlocal nodes
    nodes += 1
    if nodes > 12000 or depth > 32:
      raise BridgeError("Harness JSON exceeds the structure limit.")
    if isinstance(item, dict):
      for key, child in item.items():
        if not isinstance(key, str):
          raise BridgeError("Harness JSON object keys must be strings.")
        visit(child, depth + 1)
    elif isinstance(item, list):
      for child in item:
        visit(child, depth + 1)
    elif isinstance(item, float) and not math.isfinite(item):
      raise BridgeError("Harness JSON numbers must be finite.")
    elif not isinstance(item, (str, int, float, bool, type(None))):
      raise BridgeError("Harness input must contain only JSON values.")
  visit(value, 0)


def encode(value, maximum=MAX_JSON):
  result = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
  if len(result) > maximum:
    raise BridgeError("Harness JSON exceeds the byte limit.")
  return result


def decode(data):
  def pairs(items):
    result = {}
    for key, value in items:
      if key in result:
        raise BridgeError("Harness JSON contains duplicate fields.")
      result[key] = value
    return result

  def nonfinite(_):
    raise BridgeError("Harness JSON numbers must be finite.")

  if len(data) > MAX_JSON:
    raise BridgeError("Harness JSON exceeds the byte limit.")
  try:
    value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=nonfinite)
    bounded_tree(value)
  except BridgeError:
    raise
  except Exception:
    raise BridgeError("Harness input is not valid JSON.") from None
  if not isinstance(value, dict):
    raise BridgeError("Harness input must be a JSON object.")
  return value


def read_stdin():
  chunks, size = [], 0
  while True:
    chunk = os.read(0, min(16384, MAX_JSON + 1 - size))
    if not chunk:
      break
    chunks.append(chunk)
    size += len(chunk)
    if size > MAX_JSON:
      raise BridgeError("Harness JSON exceeds the byte limit.")
  return decode(b"".join(chunks))


def minimal_environment():
  result = {"PATH": "/usr/bin:/bin:/usr/local/bin", "LANG": "C.UTF-8"}
  for key in SAFE_ENV:
    value = os.environ.get(key)
    if value and "\0" not in value and len(value) <= 4096:
      result[key] = value
  return result


def check_owned(info, directory=False):
  valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
  if not valid_type or info.st_uid != os.getuid() or info.st_mode & 0o022:
    raise BridgeError("Harness managed path is not a private, owned regular file or directory.")
  if not directory and info.st_nlink != 1:
    raise BridgeError("Harness managed files must not have multiple links.")


@contextmanager
def owned_directory(root, parts=(), create=False):
  """Anchor at the owned data root, then use dir-fd/no-follow for every component.

  OS aliases above the root (notably macOS /tmp) are allowed; links within the
  application tree and a symlink replacing the data root are not.
  """
  if not absolute(root) or not hasattr(os, "O_NOFOLLOW"):
    raise BridgeError("Harness requires an absolute data root and no-follow filesystem support.")
  flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
  descriptors = []
  try:
    descriptor = os.open(root, flags)
    descriptors.append(descriptor)
    check_owned(os.fstat(descriptor), directory=True)
    for part in parts:
      if not part or part in (".", "..") or "/" in part:
        raise BridgeError("Harness managed path is invalid.")
      if create:
        try:
          os.mkdir(part, 0o700, dir_fd=descriptor)
        except FileExistsError:
          pass
      descriptor = os.open(part, flags, dir_fd=descriptor)
      descriptors.append(descriptor)
      check_owned(os.fstat(descriptor), directory=True)
    yield descriptor
  except OSError:
    raise BridgeError("Harness managed path could not be opened safely.") from None
  finally:
    for descriptor in reversed(descriptors):
      os.close(descriptor)


def owned_file(directory, name, flags=os.O_RDONLY):
  descriptor = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
  try:
    check_owned(os.fstat(descriptor))
    return descriptor
  except BaseException:
    os.close(descriptor)
    raise


def scope_name(project_id):
  if project_id is None:
    return "global"
  if not text(project_id):
    raise BridgeError("Harness project ID is invalid.")
  return hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:32]


def load_binding(path):
  if not absolute(path):
    raise BridgeError("Harness binding path must be absolute.")
  target = Path(path)
  if len(target.parents) < 5 or target.parent.name != "bindings" or target.parents[2].name != "scopes" or target.parents[3].name != "harness":
    raise BridgeError("Harness binding is outside the application binding directory.")
  data_dir = str(target.parents[4])
  scope = target.parents[1].name
  with owned_directory(data_dir, ("harness", "scopes", scope, "bindings")) as directory:
    descriptor = owned_file(directory, target.name)
    try:
      before = os.fstat(descriptor)
      if before.st_size > MAX_JSON:
        raise BridgeError("Harness binding exceeds the byte limit.")
      chunks, size = [], 0
      while size <= MAX_JSON:
        chunk = os.read(descriptor, min(16384, MAX_JSON + 1 - size))
        if not chunk:
          break
        chunks.append(chunk)
        size += len(chunk)
      after = os.fstat(descriptor)
      named = os.stat(target.name, dir_fd=directory, follow_symlinks=False)
      check_owned(after)
      check_owned(named)
      fingerprint = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
      if fingerprint(before) != fingerprint(after) or fingerprint(after) != fingerprint(named):
        raise BridgeError("Harness binding changed while it was being read.")
      binding = decode(b"".join(chunks))
    finally:
      os.close(descriptor)
  fields = {"protocol", "client", "projectId", "projectDir", "policyId", "policyRevision", "policy", "pythonPath", "engineVersion", "createdAt"}
  if set(binding) != fields or type(binding["protocol"]) is not int or binding["protocol"] != PROTOCOL:
    raise BridgeError("Harness binding protocol or fields are invalid.")
  client = binding["client"]
  if client not in CLIENTS or target.name != client + ".json" or scope != scope_name(binding["projectId"]):
    raise BridgeError("Harness binding client or project scope does not match its path.")
  if not all(text(binding[key]) for key in ("projectId", "policyId", "policyRevision", "createdAt")):
    raise BridgeError("Harness binding metadata is invalid.")
  if not absolute(binding["projectDir"]) or not os.path.isdir(binding["projectDir"]) or not absolute(binding["pythonPath"]):
    raise BridgeError("Harness binding project or Python path is invalid.")
  if binding["engineVersion"] != ENGINE_VERSION or not isinstance(binding["policy"], dict):
    raise BridgeError("Harness binding policy or engine version is invalid.")
  try:
    datetime.fromisoformat(binding["createdAt"].replace("Z", "+00:00"))
    if not os.path.samefile(binding["pythonPath"], sys.executable):
      raise BridgeError("Harness binding Python does not match the running interpreter.")
  except (ValueError, OSError):
    raise BridgeError("Harness binding interpreter or creation time is invalid.") from None
  encode(binding["policy"], MAX_POLICY)
  return binding, data_dir


@contextmanager
def engine_slot(data_dir):
  """Four engine evaluations at most across app and native bridge processes."""
  try:
    import fcntl
  except ImportError:
    raise BridgeError("Harness interprocess locking requires macOS or Linux.") from None
  with owned_directory(data_dir, ("harness", "runtime-locks"), create=True) as directory:
    held = None
    try:
      for index in range(4):
        descriptor = owned_file(directory, "slot-%d.lock" % index, os.O_RDWR | os.O_CREAT)
        try:
          fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
          held = descriptor
          break
        except BlockingIOError:
          os.close(descriptor)
      if held is None:
        raise BridgeError("Harness engine concurrency limit reached.")
      yield
    finally:
      if held is not None:
        fcntl.flock(held, fcntl.LOCK_UN)
        os.close(held)


def append_event(data_dir, project_id, event):
  """Three managed files total: events.jsonl and two 2MiB archives."""
  import fcntl
  payload = encode(event, MAX_EVENT) + b"\n"
  with owned_directory(data_dir, ("harness", "scopes", scope_name(project_id), "audit"), create=True) as directory:
    lock = owned_file(directory, ".events.lock", os.O_RDWR | os.O_CREAT)
    locked = False
    try:
      deadline = time.monotonic() + 1
      while not locked:
        try:
          fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
          locked = True
        except BlockingIOError:
          if time.monotonic() >= deadline:
            raise BridgeError("Harness audit lock timed out.")
          time.sleep(0.01)
      names = ("events.jsonl", "events.1.jsonl", "events.2.jsonl")
      existing = {}
      # Validate every entry before rotation changes anything.
      for name in names:
        try:
          info = os.stat(name, dir_fd=directory, follow_symlinks=False)
          check_owned(info)
          existing[name] = info.st_size
        except FileNotFoundError:
          pass
      for name in names[1:]:
        if existing.get(name, 0) > MAX_AUDIT:
          os.unlink(name, dir_fd=directory)
          del existing[name]
      if existing.get(names[0], 0) + len(payload) > MAX_AUDIT:
        if names[2] in existing:
          os.unlink(names[2], dir_fd=directory)
        for source, destination in ((names[1], names[2]), (names[0], names[1])):
          if source in existing:
            if existing[source] > MAX_AUDIT:
              # An externally enlarged managed log is discarded, never copied unboundedly.
              os.unlink(source, dir_fd=directory)
            else:
              os.rename(source, destination, src_dir_fd=directory, dst_dir_fd=directory)
      descriptor = owned_file(directory, names[0], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
      try:
        if os.fstat(descriptor).st_size + len(payload) > MAX_AUDIT:
          raise BridgeError("Harness audit exceeds the byte limit.")
        view = memoryview(payload)
        while view:
          written = os.write(descriptor, view)
          if not written:
            raise BridgeError("Harness audit write failed.")
          view = view[written:]
        os.fsync(descriptor)
      finally:
        os.close(descriptor)
    except OSError:
      raise BridgeError("Harness audit could not be written safely.") from None
    finally:
      if locked:
        fcntl.flock(lock, fcntl.LOCK_UN)
      os.close(lock)


def prevent_execution(event, args):
  if not _engine_guarded:
    return
  if event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.fork", "os.forkpty", "socket.connect", "socket.getaddrinfo", "socket.bind"):
    raise BridgeError("Harness evaluation cannot execute commands or access the network.")
  if event == "open":
    flags = args[2] if len(args) > 2 else 0
    if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
      raise BridgeError("Harness engine cannot write external files.")


@contextmanager
def isolated_engine():
  """Discard upstream diagnostics at the file-descriptor boundary, including C writes."""
  global _engine_guarded, _audit_hook_installed
  if not _audit_hook_installed:
    sys.addaudithook(prevent_execution)
    _audit_hook_installed = True
  saved = [os.dup(1), os.dup(2)]
  sink = os.open(os.devnull, os.O_WRONLY)
  old_guard = _engine_guarded
  try:
    sys.stdout.flush()
    sys.stderr.flush()
    os.dup2(sink, 1)
    os.dup2(sink, 2)
    _engine_guarded = True
    with warnings.catch_warnings():
      warnings.simplefilter("ignore")
      yield
  finally:
    _engine_guarded = old_guard
    sys.stdout.flush()
    sys.stderr.flush()
    os.dup2(saved[0], 1)
    os.dup2(saved[1], 2)
    for descriptor in saved + [sink]:
      os.close(descriptor)


def probe_engine():
  result = {
    "protocol": PROTOCOL, "operation": "probe", "state": "missing",
    "pythonVersion": ".".join(map(str, sys.version_info[:3])), "engineVersion": None,
    "requiredApi": {"constitutionFromDict": False, "pipelineEvaluate": False, "toolCall": False},
    "error": None,
  }
  try:
    result["engineVersion"] = importlib.metadata.version("autoharness")
  except importlib.metadata.PackageNotFoundError:
    pass
  if result["engineVersion"] is not None and not re.fullmatch(r"[0-9][a-zA-Z0-9.+_-]{0,79}", result["engineVersion"]):
    result.update(state="error", engineVersion=None, error="AutoHarness package version metadata is invalid.")
    return result, None
  if sys.version_info < (3, 10) or sys.version_info.major != 3:
    result.update(state="unsupported", error="AutoHarness requires Python 3.10 or newer within Python 3.")
    return result, None
  if result["engineVersion"] is None:
    result["error"] = "AutoHarness package metadata was not found in this interpreter."
    return result, None
  if result["engineVersion"] != ENGINE_VERSION:
    result.update(state="unsupported", error="This bridge supports the tested AutoHarness 0.1.1 engine only.")
    return result, None
  try:
    from autoharness.core.constitution import Constitution
    from autoharness.core.pipeline import ToolGovernancePipeline
    from autoharness.core.hooks import HookRegistry
    from autoharness.core import types
    result["requiredApi"] = {
      "constitutionFromDict": callable(getattr(Constitution, "from_dict", None)),
      "pipelineEvaluate": callable(getattr(ToolGovernancePipeline, "evaluate", None)),
      "toolCall": callable(getattr(types, "ToolCall", None)),
    }
    if not all(result["requiredApi"].values()):
      result.update(state="unsupported", error="AutoHarness is missing a required evaluation API.")
      return result, None
    inspect.signature(Constitution.from_dict).bind({})
    inspect.signature(ToolGovernancePipeline.evaluate).bind(None, None)
    for name in ("ConstitutionConfig", "PermissionDefaults", "ToolPermission", "RiskConfig", "RiskThresholds", "HooksConfig", "AuditConfig", "IdentityConfig"):
      if not callable(getattr(getattr(types, name, None), "model_validate", None)):
        raise TypeError()
    result.update(state="ready", error=None)
    return result, (Constitution, ToolGovernancePipeline, HookRegistry, types)
  except (AttributeError, TypeError):
    result.update(state="unsupported", error="AutoHarness does not expose the supported evaluation API.")
  except Exception:
    result.update(state="error", error="AutoHarness could not be imported; check its installed dependencies.")
  return result, None


def validate_policy(policy, engine):
  """Validate nested sections explicitly: upstream's dict unions accept invalid data."""
  Constitution, _, _, types = engine
  if not isinstance(policy, dict):
    raise BridgeError("Harness policy must be a JSON object.")
  encode(policy, MAX_POLICY)
  if set(policy) - set(types.ConstitutionConfig.model_fields):
    raise BridgeError("Harness policy contains unsupported top-level fields.")
  if "mode" in policy and policy["mode"] not in ("core", "standard", "enhanced"):
    raise BridgeError("Harness policy mode is invalid.")

  def section(value, model, name):
    if not isinstance(value, dict) or set(value) - set(model.model_fields):
      raise BridgeError("Harness policy has invalid fields in " + name + ".")
    try:
      return model.model_validate(value, strict=True)
    except Exception:
      raise BridgeError("Harness policy has invalid values in " + name + ".") from None

  for key, model in (("identity", types.IdentityConfig), ("audit", types.AuditConfig), ("hooks", types.HooksConfig), ("risk", types.RiskConfig)):
    if key in policy:
      section(policy[key], model, key)
  hooks = policy.get("hooks", {})
  if hooks.get("profile", "standard") not in ("minimal", "standard", "strict"):
    raise BridgeError("Harness hook profile is invalid.")
  if hooks.get("pre") or hooks.get("post"):
    raise BridgeError("Harness evaluation does not support custom executable hooks.")
  risk = policy.get("risk", {})
  if risk.get("classifier", "rules") != "rules":
    raise BridgeError("Harness evaluation supports only the rules classifier; model inference is disabled.")
  if "thresholds" in risk:
    section(risk["thresholds"], types.RiskThresholds, "risk.thresholds")
  for rule in risk.get("custom_rules", []):
    if (not isinstance(rule, dict) or set(rule) - {"pattern", "level", "reason", "tool"}
        or not text(rule.get("pattern"), 4096) or rule.get("level") not in ("low", "medium", "high", "critical")
        or not text(rule.get("tool", "*"), 128) or not isinstance(rule.get("reason", ""), str)):
      raise BridgeError("Harness custom risk rule is invalid.")
    try:
      re.compile(rule["pattern"])
    except re.error:
      raise BridgeError("Harness custom risk rule has an invalid regular expression.") from None
  permissions = policy.get("permissions", {})
  if not isinstance(permissions, dict) or set(permissions) - {"defaults", "tools"}:
    raise BridgeError("Harness permissions section is invalid.")
  section(permissions.get("defaults", {}), types.PermissionDefaults, "permissions.defaults")
  if permissions.get("defaults", {}).get("on_error", "deny") != "deny":
    raise BridgeError("Harness permission errors must deny; on_error must be deny.")
  tools = permissions.get("tools", {})
  if not isinstance(tools, dict) or len(tools) > 256:
    raise BridgeError("Harness tool permissions are invalid.")
  for name, permission in tools.items():
    if not text(name, 128) or not isinstance(permission, dict):
      raise BridgeError("Harness tool permission is invalid.")
    section({"policy": "restricted", **permission}, types.ToolPermission, "permissions.tools")
    for field in ("deny_patterns", "ask_patterns", "allow_patterns"):
      for pattern in permission.get(field, []):
        try:
          re.compile(pattern)
        except re.error:
          raise BridgeError("Harness tool permission has an invalid regular expression.") from None
  sanitized = deepcopy(policy)
  # AuditEngine opens its destination in __init__ when enabled, even for evaluate().
  sanitized["audit"] = {"enabled": False, "output": os.devnull, "retention_days": 30}
  try:
    return Constitution.from_dict(sanitized)
  except Exception:
    raise BridgeError("Harness constitution validation failed.") from None


class GoverningHooks:
  """Successful built-in checks are not permission grants.

  0.1.1's no-op HookAction.allow otherwise overrides restricted tool policies and
  unknown_tool=ask. Keep real built-in deny/ask results and real risk evidence,
  and leave grants to the actual pipeline's permission engine.
  """
  def __init__(self, registry):
    self.registry = registry
    self.risk = None

  def run_pre_hooks(self, tool_call, risk, context):
    self.risk = risk
    results = self.registry.run_pre_hooks(tool_call, risk, context)
    # 0.1.1 encodes failed/timed-out checks as warning-level allows with these
    # diagnostic reasons. A normal medium-risk finding also uses warning/allow,
    # so severity alone cannot distinguish a failed check from a successful one.
    for result in results:
      failed = result.severity == "error" or (result.severity == "warning" and re.fullmatch(
        r"Hook .+ (?:raised an exception \(see logs\)|timed out after [0-9.eE+-]+s)",
        result.reason or "",
      ))
      if result.action.value == "allow" and failed:
        raise BridgeError("Harness pre-hook failed or timed out.")
    return [result for result in results if result.action.value != "allow"]


def normalized_calls(name, tool_input, policy, working_dir):
  if not text(name, 128) or not isinstance(tool_input, dict):
    raise BridgeError("Harness tool name or input is invalid.")
  encode(tool_input, MAX_INPUT)
  aliases = {
    "bash": "bash", "shell": "bash", "terminal": "bash", "exec_command": "bash",
    "execute_bash": "bash", "execute_cmd": "bash",
    "read": "file_read", "fs_read": "file_read", "fsread": "file_read", "file_read": "file_read",
    "write": "file_write", "edit": "file_write", "multiedit": "file_write",
    "fs_write": "file_write", "fswrite": "file_write", "file_write": "file_write",
  }
  canonical = aliases.get(name.lower(), name)
  data = deepcopy(tool_input)

  def alias(keys, target, required=False):
    supplied = [data[key] for key in keys if key in data]
    if supplied and (not all(isinstance(value, str) for value in supplied) or any(value != supplied[0] for value in supplied)):
      raise BridgeError("Harness tool input contains conflicting or invalid aliases.")
    if required and (not supplied or not supplied[0].strip()):
      raise BridgeError("Harness tool input is missing the required command or path.")
    if supplied:
      data[target] = supplied[0]

  if canonical == "bash":
    alias(("command", "cmd"), "command", required=True)
  inputs = [data]
  if canonical in ("file_read", "file_write"):
    if "operations" in data:
      operations = data["operations"]
      if not isinstance(operations, list) or not 0 < len(operations) <= 32 or any(not isinstance(item, dict) for item in operations):
        raise BridgeError("Harness file operations are invalid or exceed the limit.")
      inputs = []
      for operation in operations:
        path = operation.get("path")
        if not text(path, 4096):
          raise BridgeError("Harness file operation is missing its path.")
        if any(key in operation and operation[key] != path for key in ("file_path", "filename", "file")):
          raise BridgeError("Harness file operation contains conflicting path aliases.")
        # Each Kiro batch member must be governed; one denied path blocks the batch.
        inputs.append({**data, **operation, "file_path": path})
    else:
      alias(("file_path", "path", "filename", "file"), "file_path", required=True)
  names = [canonical]
  configured = policy.get("permissions", {}).get("tools", {})
  if canonical.lower() != name.lower() and any(key.lower() == name.lower() for key in configured):
    # A canonical alias must never erase a stricter explicitly named tool policy.
    names.append(name)
  calls = []
  for item in inputs:
    path = item.get("file_path") if canonical in ("file_read", "file_write") else None
    if isinstance(path, str) and not os.path.isabs(path) and not path.startswith("~"):
      # Do not normpath away "..": the engine must still see traversal attempts.
      target = os.path.join(working_dir, path)
      resolved = {**item, "file_path": target}
      for key in ("path", "filename", "file"):
        if key in resolved:
          resolved[key] = target
      for variant in names:
        calls.append((variant, resolved, False))
        calls.append((variant, item, True))
    else:
      calls.extend((variant, item, False) for variant in names)
  return calls


def evaluate_policy(request, engine, constitution):
  _, Pipeline, HookRegistry, types = engine
  project_dir = request.get("projectDir")
  if not absolute(project_dir) or not os.path.isdir(project_dir):
    raise BridgeError("Harness project directory is invalid.")
  working_dir = request.get("workingDir", project_dir)
  root = os.path.realpath(project_dir)
  if (not absolute(working_dir) or not os.path.isdir(working_dir)
      or os.path.commonpath([root, os.path.realpath(working_dir)]) != root):
    raise BridgeError("Harness working directory is outside the bound project.")
  # 0.1.1 captures PROJECT_DIR from cwd during construction. Keep that anchor
  # fixed, then evaluate relative native paths from their actual working directory.
  os.chdir(project_dir)
  config = constitution.config.model_dump()
  profile = "minimal" if config.get("mode") == "core" else config.get("hooks", {}).get("profile", "standard")
  registry = GoverningHooks(HookRegistry(profile=profile, project_root=project_dir))
  pipeline = Pipeline(constitution, project_dir=project_dir, session_id=request.get("sessionId"), hook_registry=registry)
  os.chdir(working_dir)
  decisions = []
  private = secret_values({"tool_input": request.get("toolInput", {})}) + secret_values(request["policy"])
  calls = normalized_calls(request.get("toolName"), request.get("toolInput"), request["policy"], working_dir)
  configured = {name.lower() for name in request["policy"].get("permissions", {}).get("tools", {})}
  native_configured = request["toolName"].lower() in configured
  for name, tool_input, literal_path in calls:
    call = types.ToolCall(tool_name=name, tool_input=tool_input, session_id=request.get("sessionId"))
    # This is the only governance entry point. No process(), executors, loops or post hooks.
    decision = pipeline.evaluate(call)
    if decision.action not in ("allow", "ask", "deny") or not isinstance(decision.reason, str):
      raise BridgeError("Harness engine returned an invalid permission decision.")
    if decision.source in ("pipeline_error", "error"):
      raise BridgeError("Harness engine failed while evaluating permissions.")
    # A configured native tool is not unknown merely because its canonical
    # alias has no policy entry. Keep evaluating that alias for risk and hooks,
    # but exclude its global tool fallback; explicit policies still all apply.
    if native_configured and name.lower() not in configured and decision.source == "defaults":
      continue
    # Preserve literal path/risk/hook rules, but do not let the unexpanded path's
    # fallback mask a grant for the actual absolute target. Tool defaults were
    # already evaluated for that target, including any explicitly named alias.
    if literal_path and decision.action != "deny" and decision.source in ("defaults", "tool_policy"):
      continue
    risk = getattr(registry.risk, "level", None)
    level = getattr(risk, "value", None)
    if level not in ("low", "medium", "high", "critical"):
      raise BridgeError("Harness engine returned an invalid risk assessment.")
    matched = getattr(registry.risk, "matched_rule", None)
    decisions.append({
      "action": decision.action, "risk": level,
      "reason": safe_text(decision.reason, 1024, private) or "Governed by the AutoHarness policy.",
      "matchedRules": [safe_text(matched, 256, private)] if isinstance(matched, str) and matched else [],
    })
  if not decisions:
    raise BridgeError("Harness engine did not evaluate a tool call.")
  ranks = {"allow": 0, "ask": 1, "deny": 2}
  result = max(decisions, key=lambda item: ranks[item["action"]])
  return {"protocol": PROTOCOL, "operation": "evaluate", **result, "engineVersion": ENGINE_VERSION, "executed": False}


def error_decision(reason):
  return {
    "protocol": PROTOCOL, "operation": "evaluate", "action": "error", "risk": None,
    "reason": safe_text(reason), "matchedRules": [], "engineVersion": ENGINE_VERSION, "executed": False,
  }


def error_message(error):
  return str(error) if isinstance(error, BridgeError) else "Harness engine or bridge operation failed."


def judge(request, validation=False):
  validated = False
  try:
    with engine_slot(request.get("dataDir")):
      with isolated_engine():
        report, engine = probe_engine()
        if engine is None:
          raise BridgeError(report["error"])
        validated = True
        constitution = validate_policy(request.get("policy"), engine)
        if validation:
          # Constructing the actual pipeline also validates compiled risk/hook configuration.
          config = constitution.config.model_dump()
          engine[1](constitution, project_dir=request.get("projectDir"))
          return {
            "protocol": PROTOCOL, "operation": "validate", "valid": True, "engineValidated": True,
            "mode": config["mode"].value if hasattr(config["mode"], "value") else config["mode"],
            "ruleCount": len(constitution.rules), "errors": [], "warnings": [],
          }
        return evaluate_policy(request, engine, constitution)
  except Exception as error:
    if validation:
      return {
        "protocol": PROTOCOL, "operation": "validate", "valid": False, "engineValidated": validated,
        "mode": None, "ruleCount": 0, "errors": [error_message(error)], "warnings": [],
      }
    return error_decision(error_message(error))


def make_event(metadata, decision, origin, event_type, status, duration=None, run_id=None, session_id=None, secrets=()):
  clean = lambda value, limit: safe_text(value, limit, secrets)
  return {
    "timestamp": utc_now(), "origin": origin, "event_type": event_type,
    "client": metadata["client"], "project_id": clean(metadata["projectId"], 256) if metadata["projectId"] is not None else None,
    "policy_id": clean(metadata["policyId"], 256), "policy_revision": clean(metadata["policyRevision"], 256),
    "run_id": clean(run_id, 256) if isinstance(run_id, str) else None,
    "session_id": clean(session_id, 256) if isinstance(session_id, str) else None,
    "tool_name": clean(metadata.get("toolName", "unknown"), 128),
    "permission": {"action": decision["action"], "reason": clean(decision["reason"], 1024)},
    "risk": {"level": decision["risk"]},
    "execution": {"status": status, "duration_ms": duration},
  }


def synthetic(request):
  started = time.monotonic()
  if (request.get("client") not in TEST_CLIENTS or not all(text(request.get(key)) for key in ("policyId", "policyRevision"))
      or not text(request.get("toolName"), 128)):
    return error_decision("Harness evaluation metadata is invalid.")
  try:
    expected = os.path.join(request["dataDir"], "harness", "scopes", scope_name(request["projectId"]), "audit", "events.jsonl")
    if not absolute(request.get("dataDir")) or request.get("auditPath") != expected:
      raise BridgeError("Harness evaluation audit path is outside the application scope.")
    decision = judge(request)
    append_event(request["dataDir"], request["projectId"], make_event(
      request, decision, "agent-ops-test", "policy_check", "not-executed",
      round((time.monotonic() - started) * 1000, 3),
      secrets=secret_values(request["policy"]) + secret_values({"tool_input": request.get("toolInput", {})})))
    return decision
  except Exception as error:
    return error_decision(error_message(error))


def supervised_judgment(request, deadline):
  """Native hooks must emit a blocking response even if the engine hangs.

  The worker runs this exact installed bridge under the same isolated interpreter.
  The native supervisor owns a new worker process group and bounds all three pipes.
  """
  executable, bridge = sys.executable, os.path.abspath(__file__)
  if not absolute(executable) or not absolute(bridge):
    return error_decision("Harness worker paths must be absolute.")
  child = None
  selector = selectors.DefaultSelector()
  output, size = [], 0
  pending = memoryview(encode({**request, "operation": "judge"}))
  try:
    child = subprocess.Popen(
      [executable, "-I", bridge], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
      env=minimal_environment(), cwd=os.path.dirname(bridge), start_new_session=True,
    )
    for pipe, event in ((child.stdin, selectors.EVENT_WRITE), (child.stdout, selectors.EVENT_READ), (child.stderr, selectors.EVENT_READ)):
      os.set_blocking(pipe.fileno(), False)
      selector.register(pipe, event)
    while selector.get_map():
      remaining = deadline - time.monotonic()
      if remaining <= 0:
        raise BridgeError("Harness engine timed out.")
      for key, _ in selector.select(min(remaining, 0.1)):
        stream = key.fileobj
        if stream is child.stdin:
          count = os.write(stream.fileno(), pending[:16384])
          pending = pending[count:]
          if not pending:
            selector.unregister(stream)
            stream.close()
        else:
          chunk = os.read(stream.fileno(), 16384)
          if not chunk:
            selector.unregister(stream)
            stream.close()
            continue
          size += len(chunk)
          if size > MAX_JSON:
            raise BridgeError("Harness worker output exceeds the byte limit.")
          if stream is child.stdout:
            output.append(chunk)
    remaining = deadline - time.monotonic()
    if remaining <= 0 or child.wait(timeout=remaining) != 0:
      raise BridgeError("Harness engine worker failed.")
    result = decode(b"".join(output))
    if (result.get("protocol") != PROTOCOL or result.get("operation") != "evaluate"
        or result.get("action") not in ("allow", "ask", "deny", "error")
        or result.get("risk") not in (None, "low", "medium", "high", "critical")
        or not text(result.get("reason"), 4096) or result.get("executed") is not False
        or result.get("engineVersion") != ENGINE_VERSION):
      raise BridgeError("Harness engine worker returned an invalid decision.")
    return result
  except Exception as error:
    return error_decision(error_message(error))
  finally:
    selector.close()
    if child is not None:
      # Signal only this supervisor's newly created process group, including
      # descendants that retained pipes after their leader exited.
      for name in (signal.SIGTERM, signal.SIGKILL):
        try:
          os.killpg(child.pid, name)
        except ProcessLookupError:
          break
        if name == signal.SIGTERM:
          time.sleep(0.05)
      for stream in (child.stdin, child.stdout, child.stderr):
        stream.close()
      try:
        child.wait(timeout=0.1)
      except subprocess.TimeoutExpired:
        pass


def native_input(payload, binding, event):
  actual = payload.get("hook_event_name")
  accepted = {event}
  if binding["client"] == "kiro":
    accepted.add(event[0].lower() + event[1:])
  if actual is not None and actual not in accepted:
    raise BridgeError("Harness native event does not match the configured trigger.")
  if not text(payload.get("tool_name"), 128) or not isinstance(payload.get("tool_input"), dict):
    raise BridgeError("Harness native tool name or input is invalid.")
  session = payload.get("session_id")
  if session is not None and not text(session, 512):
    raise BridgeError("Harness native session ID is invalid.")
  if "cwd" in payload:
    cwd = payload["cwd"]
    root = os.path.realpath(binding["projectDir"])
    if not absolute(cwd) or not os.path.isdir(cwd) or os.path.commonpath([root, os.path.realpath(cwd)]) != root:
      raise BridgeError("Harness native working directory is outside the bound project.")
  encode(payload["tool_input"], MAX_INPUT)
  return {
    "protocol": PROTOCOL, "policy": binding["policy"], "projectDir": binding["projectDir"],
    "workingDir": payload.get("cwd", binding["projectDir"]),
    "toolName": payload["tool_name"], "toolInput": payload["tool_input"], "sessionId": session,
  }


def native_response(client, event, decision, unattended):
  if event != "PreToolUse" or decision["action"] == "allow":
    return {}, 0, ""
  action = decision["action"]
  reason = safe_text(decision["reason"], 1024)
  if action == "ask" and (unattended or client != "claude-code"):
    reason = "Approval required; this native hook cannot request approval here. " + reason
  if client in ("claude-code", "codex"):
    # Codex parses ask but does not support it: that hook failure continues the tool.
    permission = "ask" if action == "ask" and client == "claude-code" and not unattended else "deny"
    return {"hookSpecificOutput": {
      "hookEventName": "PreToolUse", "permissionDecision": permission, "permissionDecisionReason": reason[:1024],
    }}, 0, ""
  # Kiro CLI blocks only on 2; other nonzero exit statuses are fail-open warnings.
  # The IDE also treats 2 as blocking, so no guessed IDE/CLI attribution is needed.
  return {}, 2, reason


def native(path, event, run_id, unattended, deadline):
  binding = None
  payload = {}
  data_dir = None
  decision = error_decision("Harness native hook failed.")
  try:
    binding, data_dir = load_binding(path)
    payload = read_stdin()
    request = native_input(payload, binding, event)
    decision = supervised_judgment({**request, "dataDir": data_dir}, deadline - 0.3)
  except Exception as error:
    decision = error_decision(error_message(error))
  if binding is None:
    return ({}, 2, safe_text(decision["reason"])) if event == "PreToolUse" else ({}, 0, "Harness post-hook could not read its binding.")
  action = decision["action"]
  duration = None
  if event == "PreToolUse":
    if action == "ask":
      status = "blocked-unattended" if unattended else ("approval-required" if binding["client"] == "claude-code" else "blocked-approval-required")
    else:
      status = {"allow": "permitted", "deny": "blocked", "error": "error"}[action]
  else:
    response = payload.get("tool_response", {})
    failed = event == "PostToolUseFailure" or isinstance(response, dict) and response.get("success") is False
    status = "observed-failure" if failed else "observed-completion"
    supplied = payload.get("duration_ms")
    if type(supplied) in (int, float) and math.isfinite(supplied) and 0 <= supplied <= 86400000:
      duration = supplied
  metadata = {**binding, "toolName": payload.get("tool_name", "unknown")}
  try:
    append_event(data_dir, binding["projectId"], make_event(
      metadata, decision, "agent-ops-hook", event, status, duration, run_id, payload.get("session_id"),
      secrets=secret_values(payload) + secret_values(binding["policy"])))
  except Exception:
    decision = error_decision("Harness audit could not be recorded safely.")
  return native_response(binding["client"], event, decision, unattended)


def dispatch(request):
  if type(request.get("protocol")) is not int or request["protocol"] != PROTOCOL:
    return error_decision("Harness request protocol is invalid.")
  operation = request.get("operation")
  if operation == "probe":
    try:
      with engine_slot(request.get("dataDir")), isolated_engine():
        return probe_engine()[0]
    except Exception as error:
      return {
        "protocol": PROTOCOL, "operation": "probe", "state": "error",
        "pythonVersion": ".".join(map(str, sys.version_info[:3])), "engineVersion": None,
        "requiredApi": {"constitutionFromDict": False, "pipelineEvaluate": False, "toolCall": False},
        "error": error_message(error),
      }
  if operation == "validate":
    if not absolute(request.get("projectDir")) or not os.path.isdir(request["projectDir"]):
      return {"protocol": PROTOCOL, "operation": "validate", "valid": False, "engineValidated": False,
        "mode": None, "ruleCount": 0, "errors": ["Harness project directory is invalid."], "warnings": []}
    return judge(request, validation=True)
  if operation == "evaluate":
    return synthetic(request)
  if operation == "judge":
    return judge(request)
  return error_decision("Harness request operation is invalid.")


def main():
  started = time.monotonic()
  run_id = os.environ.get("AGENT_OPS_RUN_ID")
  unattended = os.environ.get("AGENT_OPS_UNATTENDED") == "1"
  environment = minimal_environment()
  os.environ.clear()
  os.environ.update(environment)
  logging.disable(logging.CRITICAL)
  code, stderr = 0, ""
  event = "PreToolUse"

  def timeout(_signal, _frame):
    raise BridgeError("Harness bridge timed out.")

  def cancelled(_signal, _frame):
    raise BridgeError("Harness operation cancelled.")

  signal.signal(signal.SIGTERM, cancelled)
  signal.signal(signal.SIGINT, cancelled)
  if hasattr(signal, "setitimer"):
    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, TIMEOUT + 0.5)
  try:
    if len(sys.argv) == 1:
      response = dispatch(read_stdin())
    elif len(sys.argv) == 5 and sys.argv[1] == "--binding" and sys.argv[3] == "--event" and sys.argv[4] in EVENTS:
      event = sys.argv[4]
      response, code, stderr = native(sys.argv[2], event, run_id, unattended, started + TIMEOUT)
    else:
      response, code, stderr = {}, 2, "Harness native hook arguments are invalid."
  except Exception as error:
    if len(sys.argv) == 1:
      response = error_decision(error_message(error))
    else:
      response, code, stderr = {}, (2 if event == "PreToolUse" else 0), error_message(error)
  finally:
    if hasattr(signal, "setitimer"):
      signal.setitimer(signal.ITIMER_REAL, 0)
  try:
    encoded = encode(response) + b"\n"
  except Exception:
    if len(sys.argv) == 1:
      encoded = encode(error_decision("Harness result could not be encoded safely.")) + b"\n"
    else:
      encoded, code, stderr = b"{}\n", (2 if event == "PreToolUse" else 0), "Harness result could not be encoded safely."
  try:
    os.write(1, encoded)
    if stderr:
      os.write(2, safe_text(stderr, 1024).encode("utf-8") + b"\n")
  except (BrokenPipeError, OSError):
    return 2 if event == "PreToolUse" else 0
  return code


if __name__ == "__main__":
  sys.exit(main())
