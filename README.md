# 🎓 Gyoshu & Jogyo

> *"Every great professor needs a great teaching assistant."*

**Gyoshu** (교수, *Professor*) orchestrates. **Jogyo** (조교, *Teaching Assistant*) executes.

Together, they form an end-to-end research automation system for [OpenCode](https://github.com/opencode-ai/opencode) that turns your research goals into reproducible Jupyter notebooks—complete with hypotheses, experiments, findings, and publication-ready reports.

---

## 🎭 The Cast

| Agent | Role | Korean | What They Do |
|-------|------|--------|--------------|
| **Gyoshu** | 🎩 Professor | 교수 | Plans research, orchestrates workflow, manages sessions |
| **Jogyo** | 📚 Teaching Assistant | 조교 | Executes Python code, runs experiments, generates outputs |
| **Jogyo Paper Writer** | ✍️ Grad Student | 조교 | Transforms raw findings into narrative research reports |

Think of it like a research lab:
- The **Professor** (Gyoshu) sets the research direction and reviews progress
- The **TA** (Jogyo) does the actual experiments and analysis
- When it's time to publish, another **Grad Student** writes up the findings beautifully

---

## ✨ Features

- 🔬 **Hypothesis-Driven Research** — Structure your work with `[OBJECTIVE]`, `[HYPOTHESIS]`, `[FINDING]` markers
- 🐍 **Persistent Python REPL** — Variables survive across sessions, just like a real Jupyter kernel
- 📓 **Auto-Generated Notebooks** — Every experiment is captured as a reproducible `.ipynb`
- 🤖 **Autonomous Mode** — Set a goal, walk away, come back to results
- 📝 **AI-Powered Reports** — Turn messy outputs into polished research narratives
- 🔄 **Session Management** — Continue, replay, or branch your research anytime

---

## 🚀 One-Click Installation

### Option 1: curl (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/My-Jogyo/main/install.sh | bash
```

### Option 2: Clone & Install

```bash
git clone https://github.com/Yeachan-Heo/My-Jogyo.git
cd My-Jogyo && ./install.sh
```

### Option 3: Manual Installation

```bash
# Clone the repo
git clone https://github.com/Yeachan-Heo/My-Jogyo.git

# Copy to global config
mkdir -p ~/.config/opencode/
cp -r My-Jogyo/src/* ~/.config/opencode/
```

---

## 🏃 Quick Start

```bash
# Start OpenCode
opencode

# 👋 Say hi to the Professor
/gyoshu

# 🎯 Start a new research project
/gyoshu analyze customer churn patterns in the telecom dataset

# 🤖 Or let it run autonomously (hands-off!)
/gyoshu-auto classify iris species using random forest

# 📊 Generate a report
/gyoshu report

# 🔄 Continue where you left off
/gyoshu continue
```

---

## 📖 Commands

### The Professor's Commands (`/gyoshu`)

| Command | What It Does |
|---------|--------------|
| `/gyoshu` | Show status and what to do next |
| `/gyoshu <goal>` | Start interactive research |
| `/gyoshu-auto <goal>` | Autonomous mode (set it and forget it!) |
| `/gyoshu plan <goal>` | Just create a plan, don't execute |
| `/gyoshu continue` | Pick up where you left off |
| `/gyoshu report` | Generate research report |
| `/gyoshu list` | See all your research projects |
| `/gyoshu search <query>` | Find stuff across all notebooks |

### Research Modes

| Mode | Best For | Command |
|------|----------|---------|
| 🎓 **Interactive** | Learning, exploring, iterating | `/gyoshu <goal>` |
| 🤖 **Autonomous** | Clear goals, hands-off execution | `/gyoshu-auto <goal>` |
| 🔧 **REPL** | Quick exploration, debugging | `/gyoshu repl <query>` |

---

## 🔬 How Research Works

### 1. You Set a Goal
```
/gyoshu analyze wine quality factors and build a predictive model
```

### 2. The Professor Plans
Gyoshu creates a structured research plan with clear objectives and hypotheses.

### 3. The TA Executes
Jogyo runs Python code, using structured markers to organize output:

```python
print("[OBJECTIVE] Predict wine quality from physicochemical properties")
print("[HYPOTHESIS] Alcohol content is the strongest predictor")

# ... analysis code ...

print(f"[METRIC:accuracy] {accuracy:.3f}")
print("[FINDING] Alcohol shows r=0.47 correlation with quality")
print("[CONCLUSION] Hypothesis supported - alcohol is key predictor")
```

### 4. Auto-Generated Notebook
Everything is captured in `notebooks/wine-quality.ipynb` with full reproducibility.

### 5. AI-Written Report
The Paper Writer agent transforms markers into a narrative report:

> *"Our analysis of 1,599 wine samples revealed that alcohol content emerges as the dominant predictor of quality ratings (r = 0.47). The final Random Forest model achieved 87% accuracy..."*

---

## 📁 Project Structure

```
your-project/
├── notebooks/                    # 📓 Research notebooks
│   ├── wine-quality.ipynb
│   └── customer-churn.ipynb
├── reports/                      # 📝 Generated reports
│   └── wine-quality/
│       ├── README.md             # AI-written narrative report
│       ├── figures/              # Saved plots
│       └── models/               # Saved models
├── data/                         # 📊 Your datasets
└── .venv/                        # 🐍 Python environment
```

**Runtime files** (sockets, locks) go to OS temp directories—not your project! 🧹

---

## 🎯 Output Markers

The TA uses structured markers to organize research output:

| Marker | Purpose | Example |
|--------|---------|---------|
| `[OBJECTIVE]` | Research goal | `[OBJECTIVE] Classify iris species` |
| `[HYPOTHESIS]` | What you're testing | `[HYPOTHESIS] Petal length is most predictive` |
| `[DATA]` | Dataset info | `[DATA] Loaded 150 samples` |
| `[METRIC:name]` | Quantitative results | `[METRIC:accuracy] 0.95` |
| `[FINDING]` | Key discovery | `[FINDING] Setosa is linearly separable` |
| `[CONCLUSION]` | Final verdict | `[CONCLUSION] Hypothesis confirmed` |

---

## 🐍 Python Environment

Gyoshu auto-detects your Python environment:

| Priority | Type | How It's Detected |
|----------|------|-------------------|
| 1️⃣ | Custom | `GYOSHU_PYTHON_PATH` env var |
| 2️⃣ | venv | `.venv/` directory |
| 3️⃣ | uv | `uv.lock` file |
| 4️⃣ | poetry | `poetry.lock` file |
| 5️⃣ | conda | `environment.yml` file |

No environment? No problem! The installer creates one for you.

---

## 🛠️ Requirements

- **OpenCode** v0.1.0+
- **Python** 3.10+ 
- **Optional**: `psutil` (for memory tracking), `uv`/`poetry`/`conda` (for faster env creation)

---

## 🎓 Why "Gyoshu" and "Jogyo"?

In Korean academia:

- **교수 (Gyoshu/Kyosu)** = Professor — the one who guides, plans, and oversees
- **조교 (Jogyo)** = Teaching Assistant — the one who executes, experiments, and does the heavy lifting

This reflects the architecture: Gyoshu is the orchestrator agent that plans and manages research flow, while Jogyo is the executor agent that actually runs Python code and produces results.

It's a partnership. The Professor has the vision. The TA makes it happen. Together, they publish papers. 📚

---

## 🤝 Better Together: Oh-My-OpenCode + My-Jogyo

For **data-driven product development**, combine My-Jogyo with [Oh-My-OpenCode](https://github.com/code-yeongyu/oh-my-opencode):

| Tool | Focus | Best For |
|------|-------|----------|
| **[Oh-My-OpenCode](https://github.com/code-yeongyu/oh-my-opencode)** | 🏗️ Product Development | Building features, writing code, shipping products |
| **My-Jogyo** | 📊 Data Analysis | Research, experiments, insights, ML models |

### The Synergy

```
┌─────────────────────────────────────────────────────────────┐
│                 Data-Driven Product Development             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   📊 My-Jogyo                    🏗️ Oh-My-OpenCode          │
│   ───────────                    ─────────────────          │
│   "Why are users churning?"  →   "Build retention feature"  │
│   "Which features matter?"   →   "Prioritize roadmap"       │
│   "A/B test results"         →   "Ship winning variant"     │
│   "Model predictions"        →   "Integrate ML endpoint"    │
│                                                             │
│   Research & Insights        →   Implementation & Shipping  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Install Both

```bash
# Install My-Jogyo (research & analysis)
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/My-Jogyo/main/install.sh | bash

# Install Oh-My-OpenCode (product development)
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-opencode/main/install.sh | bash
```

### Example Workflow

1. **Analyze** with My-Jogyo:
   ```
   /gyoshu-auto analyze user behavior and identify churn predictors
   ```
   → Produces insights: "Users who don't use feature X within 7 days have 3x churn rate"

2. **Build** with Oh-My-OpenCode:
   ```
   /planner implement onboarding flow that guides users to feature X
   ```
   → Ships the feature that addresses the insight

**Data informs decisions. Code ships solutions.** 🚀

---

## 📄 License

MIT — Use it, fork it, teach with it!

---

<div align="center">

**Made with 🎓 for researchers who'd rather think than type**

[Report Bug](https://github.com/Yeachan-Heo/My-Jogyo/issues) · [Request Feature](https://github.com/Yeachan-Heo/My-Jogyo/issues) · [Documentation](https://github.com/Yeachan-Heo/My-Jogyo/wiki)

</div>
