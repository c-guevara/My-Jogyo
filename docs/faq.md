# Frequently Asked Questions

Quick answers to common questions about Gyoshu.

---

## Installation

### Does Gyoshu work on Windows?

**Not directly.** Gyoshu requires Unix-like features (sockets, process management). 

**Workaround:** Use [WSL2](https://docs.microsoft.com/en-us/windows/wsl/install) (Windows Subsystem for Linux), then add Gyoshu to your `opencode.json`:

```json
{
  "plugin": ["gyoshu"]
}
```

### What Python version do I need?

**Python 3.10 or newer.** Check your version:

```bash
python3 --version
```

If you have an older version:
- Ubuntu: `sudo apt install python3.10`
- macOS: `brew install python@3.10`

### How do I update Gyoshu?

OpenCode automatically updates plugins. To force an update, clear the cache and restart:

```bash
rm -rf ~/.cache/opencode/node_modules/gyoshu
```

Then restart OpenCode. The plugin will auto-reinstall with the latest version.

### Where does Gyoshu install to?

Gyoshu installs to `~/.config/opencode/`. This includes:
- `command/` - Slash command definitions
- `agent/` - Agent configurations
- `tool/` - Tool implementations
- `lib/` - Shared utilities

---

## Usage

### Where are my notebooks stored?

In the `notebooks/` directory of your project:

```
your-project/
└── notebooks/
    ├── wine-quality.ipynb
    └── churn-analysis.ipynb
```

Open them with Jupyter Lab, VS Code, or any notebook viewer.

### Where are my reports and figures?

In the `reports/` directory, organized by research:

```
your-project/
└── reports/
    └── wine-quality/
        ├── figures/
        ├── models/
        └── report.md
```

### How do I continue previous research?

```bash
/gyoshu continue
```

If you have multiple projects, specify which one:

```bash
/gyoshu continue wine-quality
```

### What are output markers?

Structured tags that organize research output:

| Marker | Purpose |
|--------|---------|
| `[OBJECTIVE]` | Research goal |
| `[HYPOTHESIS]` | What you're testing |
| `[FINDING]` | Key discovery |
| `[METRIC:name]` | Quantitative result |
| `[CONCLUSION]` | Final verdict |

These enable search, reporting, and structured analysis. See [AGENTS.md](../AGENTS.md#structured-output-markers) for the full list.

### What's the difference between interactive and autonomous mode?

| Mode | Command | You do... | Best for... |
|------|---------|-----------|-------------|
| Interactive | `/gyoshu <goal>` | Guide each step | Exploring, learning |
| Autonomous | `/gyoshu-auto <goal>` | Set goal, walk away | Clear goals, hands-off |

---

## Troubleshooting

### Why do I get "No .venv found"?

Gyoshu needs a Python virtual environment. Create one:

```bash
python3 -m venv .venv
.venv/bin/pip install pandas numpy scikit-learn matplotlib seaborn
```

### How do I unlock a stuck session?

If a session didn't exit cleanly:

```bash
/gyoshu unlock <sessionId>
```

Find the sessionId from `/gyoshu list` or check the error message.

### What does "Bridge failed to start" mean?

The Python REPL bridge couldn't start. Common causes:

1. **Wrong Python version** - Need 3.10+
   ```bash
   python3 --version
   ```

2. **Missing .venv** - Create one (see above)

3. **Socket permissions** - Check runtime directory:
   - Linux (with XDG): `/run/user/$(id -u)/gyoshu/`
   - Linux (fallback): `~/.cache/gyoshu/runtime/`
   - macOS: `~/Library/Caches/gyoshu/runtime/`
   - Override: Set `GYOSHU_RUNTIME_DIR` environment variable

Run `/gyoshu doctor` for detailed diagnostics.

### Why did my research stop unexpectedly?

Check the session status:

```bash
/gyoshu list --status active
```

If it shows `BLOCKED` or `ABORTED`:
- **BLOCKED**: External issue (missing data, network, etc.)
- **ABORTED**: Manually stopped or crashed

Resume with `/gyoshu continue`.

---

## Integration

### Can I open Gyoshu notebooks in Jupyter Lab?

**Yes!** Notebooks are standard `.ipynb` files:

```bash
jupyter lab notebooks/wine-quality.ipynb
```

All cells, outputs, and metadata are preserved.

### Does Gyoshu work with Git?

**Yes!** Track your research in version control:

```bash
# Add to Git
git add notebooks/ reports/
git commit -m "Add wine quality research"
```

**Tip:** Gyoshu runtime files (sockets, locks) are stored in OS temp directories, not your project. No `.gitignore` entries needed for Gyoshu.

### Can I share research with teammates?

**Yes!** Share the `notebooks/` and `reports/` directories:

1. Commit to Git
2. Push to shared repository
3. Teammates can view notebooks and run `/gyoshu continue`

**Note:** REPL state (variables in memory) doesn't transfer—only notebooks and artifacts.

---

## Still have questions?

- Check the [User Guide](user-guide.md) for detailed workflows
- Read [AGENTS.md](../AGENTS.md) for technical documentation
- Run `/gyoshu doctor` to diagnose setup issues
- [Open an issue](https://github.com/Yeachan-Heo/My-Jogyo/issues) on GitHub
