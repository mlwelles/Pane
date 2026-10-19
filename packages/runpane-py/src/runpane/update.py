"""Delegate to Pane's durable update engine, preserving the invoked pip owner."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys

from .daemon_client import PaneDaemonClientError, resolve_pane_directory


def run_update(parsed) -> int:
    pane_dir = Path(resolve_pane_directory(parsed.pane_dir)).resolve()
    engine = pane_dir / "bin" / "runpane.cjs"
    node = shutil.which("node")
    if not engine.is_file() or not node:
        raise PaneDaemonClientError(
            "The independent updater requires Pane's managed update engine and standalone Node. Nothing was changed.",
            code="ERR_UPDATE_RUNTIME",
            next="Open a Pane build supporting independent updates and install standalone Node, then retry from this Python environment.",
        )
    args = [node, str(engine), "update", "--pane-dir", str(pane_dir), "--version", parsed.pane_version]
    if parsed.update_scope != "both":
        args.append("--" + parsed.update_scope + "-only")
    if parsed.update_status:
        args.extend(["--status", parsed.update_status])
    for enabled, flag in [(parsed.update_wait, "--wait"), (parsed.json, "--json"), (parsed.dry_run, "--dry-run"), (parsed.yes, "--yes")]:
        if enabled:
            args.append(flag)
    args.extend(["--format", parsed.format])
    if parsed.download_dir:
        args.extend(["--download-dir", parsed.download_dir])
    if parsed.pane_path:
        args.extend(["--pane-path", parsed.pane_path])
    environment = dict(os.environ)
    environment.pop("ELECTRON_RUN_AS_NODE", None)
    environment["PANE_UPDATE_PYTHON"] = sys.executable
    environment["PANE_UPDATE_PYTHON_ENTRYPOINT"] = str(Path(__file__).with_name("cli.py"))
    return subprocess.call(args, env=environment)
