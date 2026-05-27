from __future__ import annotations

from datetime import datetime
from pathlib import Path


def coverage_dir_for_run(base: Path, run_time: str, threshold: str) -> Path:
    """Compute coverage layout dir for a given run + threshold.

    Layout: `<base>/<run_compact>/<threshold>/`
    Example: `/coverage/glofas/2026-05-27T00Z/Q5/`
    """
    dt = datetime.fromisoformat(run_time.replace("Z", "+00:00"))
    run_compact = dt.strftime("%Y-%m-%dT%HZ")
    out = base / run_compact / threshold
    out.mkdir(parents=True, exist_ok=True)
    return out
