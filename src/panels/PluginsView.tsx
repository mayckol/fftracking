import { CATALOG, install, isEnabled, isInstalled, setEnabled, uninstall, usePlugins } from "../lib/plugins/registry";

export default function PluginsView() {
  usePlugins();

  return (
    <div className="col main">
      <div className="pane narrow">
        <div className="section-title" id="set-plugins">Plugins</div>
        <p className="plugins-intro">
          Add a plugin to install it, then toggle to enable. Bundled for now — a marketplace is coming.
        </p>

        <div className="plugin-list">
          {CATALOG.map((p) => {
            const m = p.manifest;
            const installed = isInstalled(m.id);
            const enabled = isEnabled(m.id);
            return (
              <div className="plugin-card" key={m.id}>
                <div className="plugin-info">
                  <div className="plugin-name">
                    {m.name} <span className="plugin-ver">v{m.version}</span>
                    {installed && (
                      <span className={`plugin-badge${enabled ? " on" : ""}`}>{enabled ? "Enabled" : "Disabled"}</span>
                    )}
                  </div>
                  <div className="plugin-desc">{m.description}</div>
                  {m.note && <div className="plugin-note">{m.note}</div>}
                  <div className="plugin-by">by {m.author}</div>
                </div>
                <div className="plugin-actions">
                  {installed ? (
                    <>
                      <label className="plugin-toggle">
                        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(m.id, e.target.checked)} />
                        <span className="changecount">{enabled ? "On" : "Off"}</span>
                      </label>
                      <button className="tbtn" onClick={() => uninstall(m.id)}>
                        Remove
                      </button>
                    </>
                  ) : (
                    <button className="tbtn primary" onClick={() => install(m.id)}>
                      Add
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
