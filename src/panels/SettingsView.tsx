import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import type { Settings } from "../lib/types";

interface Props {
  toast: (msg: string, error?: boolean) => void;
}

export default function SettingsView({ toast }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    api.getSettings().then(setS);
    api.autostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  async function save(key: string, value: string) {
    try {
      await api.setSetting(key, value);
      toast("Saved");
    } catch (e) {
      toast(String(e), true);
    }
  }

  async function toggleAutostart(on: boolean) {
    try {
      await api.setAutostart(on);
      setAutostart(on);
      toast(on ? "Will launch on login" : "Autostart disabled");
    } catch (e) {
      toast(String(e), true);
    }
  }

  if (!s) return <div className="col main" />;

  return (
    <div className="col main">
      <div className="pane narrow">
        <div className="section-title">Capture</div>

        <div className="field">
          <label>
            Interval snapshot
            <span className="hint">Timed breaking point, in addition to on-save capture.</span>
          </label>
          <div>
            <input
              type="number"
              min={1}
              defaultValue={Math.round(s.default_interval_secs / 60)}
              onBlur={(e) => save("default_interval_secs", String(Math.max(1, +e.target.value) * 60))}
              style={{ width: 90 }}
            />{" "}
            minutes
          </div>
        </div>

        <div className="field">
          <label>
            Min gap between auto-points
            <span className="hint">Coalesce rapid saves (e.g. live-reload) into at most one breaking point per this many seconds.</span>
          </label>
          <div>
            <input
              type="number"
              min={1}
              defaultValue={s.event_min_gap_secs}
              onBlur={(e) => save("event_min_gap_secs", String(Math.max(1, +e.target.value)))}
              style={{ width: 90 }}
            />{" "}
            seconds
          </div>
        </div>

        <div className="field">
          <label>
            Ignore globs
            <span className="hint">One per line. Added to built-ins (.git, node_modules, target…).</span>
          </label>
          <textarea
            defaultValue={s.ignore_globs.join("\n")}
            placeholder={"*.log\ntmp/**"}
            onBlur={(e) => save("ignore_globs", e.target.value)}
          />
        </div>

        <div className="field">
          <label>
            Respect .gitignore
            <span className="hint">
              Off (default) tracks everything like local history — including .env and other gitignored files. On skips them.
            </span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              defaultChecked={s.respect_gitignore}
              onChange={(e) => save("respect_gitignore", e.target.checked ? "1" : "0")}
            />
            <span className="changecount">{s.respect_gitignore ? "Skipping gitignored" : "Tracking everything"}</span>
          </label>
        </div>

        <div className="section-title">Retention</div>

        <div className="field">
          <label>
            Keep history for
            <span className="hint">Older breaking points are pruned.</span>
          </label>
          <div>
            <input
              type="number"
              min={1}
              defaultValue={s.retention_days}
              onBlur={(e) => save("retention_days", String(Math.max(1, +e.target.value)))}
              style={{ width: 90 }}
            />{" "}
            days
          </div>
        </div>

        <div className="field">
          <label>
            Points per past day
            <span className="hint">Today stays dense; past days coalesce to this many.</span>
          </label>
          <input
            type="number"
            min={1}
            max={10}
            defaultValue={s.snapshots_per_past_day}
            onBlur={(e) => save("snapshots_per_past_day", String(Math.max(1, +e.target.value)))}
            style={{ width: 90 }}
          />
        </div>

        <div className="field">
          <label>
            Disk cap
            <span className="hint">Oldest sparse days are evicted to stay under this.</span>
          </label>
          <div>
            <input
              type="number"
              min={0.1}
              step={0.1}
              defaultValue={s.max_disk_gb}
              onBlur={(e) => save("max_disk_gb", String(Math.max(0.1, +e.target.value)))}
              style={{ width: 90 }}
            />{" "}
            GB
          </div>
        </div>

        <div className="section-title">System</div>

        <div className="field">
          <label>
            Launch on login
            <span className="hint">Run in the tray and auto-track folders opened in VSCode / Zed.</span>
          </label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={autostart} onChange={(e) => toggleAutostart(e.target.checked)} />
            <span className="changecount">{autostart ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
      </div>
    </div>
  );
}
